"""Exact combinatorial optimization for minimum-intervention tokenization.

WHY THIS MODULE EXISTS
----------------------
`analytics.minimal_tokenization_plan` is a *greedy* roadmap, and honestly so:
because a downstream system descopes only when EVERY true PAN source reaching it
emits CRN (a conjunctive "AND"), the freed-systems objective is SUPERMODULAR, so
the (1-1/e) greedy guarantee of Nemhauser-Wolsey-Fisher (1978) does NOT hold.
A reviewer is right to press there. This module removes the doubt entirely: it
computes the PROVABLY OPTIMAL descope frontier

    f*(k) = max over |S| <= k of  #{ systems fully descoped by tokenizing S }

for k = 0..K, and reports the exact optimality gap between greedy and the optimum.

THE MODEL (0/1 integer program)
-------------------------------
    x_s in {0,1}   tokenize true PAN source s          (s in O, the true origins)
    y_v in {0,1}   system v is fully descoped           (v in D, descopable non-origins)
    y_v <= x_s     for every origin s that reaches v    (v frees only if ALL of its
                                                          true-source ancestors tokenized)
    maximize  sum_v y_v     subject to     sum_s x_s <= k

This is solved by the best available method, all returning the SAME certified optimum:
  1. scipy.optimize.milp (HiGHS branch-and-cut) when SciPy is installed.
  2. else an exact branch-and-bound over the distinct true-source ANCESTOR-SETS
     (pure Python, zero new dependency, runs on the locked office box), with
     weight-ordering, budget pruning and an admissible upper bound. A node-budget
     guard makes it safe at scale: if exhausted it returns the best certified-feasible
     solution with the residual [lower, upper] optimality interval, so the result is
     never an over-claim.
The greedy curve is always computed alongside as the lower-bound baseline.

Every in-scope non-origin system is reachable from >= 1 origin, so D is well-defined
and the optimum is exact w.r.t. the same clean-stream semantics the rest of the
engine uses (analytics._scope_after_tokenizing). Tokenized origins remain in the CDE
as tokenization points, exactly as the engine models them, so D excludes origins.
"""
from __future__ import annotations

import logging
from collections import Counter, defaultdict

import networkx as nx

from .analytics import _flatten, _true_pan_sources, _always_cde, pci_scope

log = logging.getLogger(__name__)

# Safety guard for the pure-Python exact search (branch count). Generous: the
# atom-set DFS prunes hard, so realistic estates finish far below this.
_NODE_BUDGET = 2_000_000


# --------------------------------------------------------------------------- model build
def _build_atoms(H, pan_sources):
    """Reduce the descope problem to weighted ANCESTOR-SETS over true origins.

    Returns (origins, before_n, descopable_n, atoms) where `atoms` is a list of
    (frozenset_of_origin_ancestors, weight) and weight = number of descopable
    systems sharing exactly that ancestor-set. Descoping a system requires its
    WHOLE ancestor-set to be tokenized, so these sets are the indivisible
    coverage atoms. Massive systems collapse onto a handful of distinct sets,
    which is what makes the exact search tractable.
    """
    origins = set(_true_pan_sources(H, set(pan_sources)))
    before = pci_scope(H, set(pan_sources))
    before_n = len(before)
    independent = {n for n, d in H.nodes(data=True) if _always_cde(d)}

    desc = {o: nx.descendants(H, o) for o in origins}
    # descopable = in scope, not an always-CDE element, not itself an origin
    D = (before - independent) - origins
    weight = Counter()
    members = defaultdict(list)
    for v in D:
        anc = frozenset(o for o in origins if v in desc[o])
        if anc:
            weight[anc] += 1
            members[anc].append(v)
    atoms = [(a, w) for a, w in weight.items()]
    return origins, before_n, len(D), atoms, members


# --------------------------------------------------------------------------- greedy baseline
def _greedy_curve(origins, atoms, k_max):
    """Greedy lower bound on the same atom model: at each step add the origin that
    maximizes marginal newly-completed weight. Returns list of (k, descoped, set)."""
    chosen, covered_weight, out = set(), 0, []
    out.append({"k": 0, "descoped": 0, "sources": []})
    # precompute, per origin, the atoms it participates in
    by_origin = defaultdict(list)
    for i, (a, w) in enumerate(atoms):
        for o in a:
            by_origin[o].append(i)
    completed = [False] * len(atoms)
    for _ in range(min(k_max, len(origins))):
        best_o, best_gain = None, 0
        for o in sorted(origins):
            if o in chosen:
                continue
            cand = chosen | {o}
            gain = 0
            for i in by_origin[o]:
                if not completed[i] and atoms[i][0] <= cand:
                    gain += atoms[i][1]
            if gain > best_gain:
                best_o, best_gain = o, gain
        if best_o is None:
            # no positive marginal; pad with any unused origin (cost only)
            remaining = [o for o in origins if o not in chosen]
            if not remaining:
                break
            best_o, best_gain = remaining[0], 0
        chosen.add(best_o)
        for i in by_origin[best_o]:
            if not completed[i] and atoms[i][0] <= chosen:
                completed[i] = True
                covered_weight += atoms[i][1]
        out.append({"k": len(chosen), "descoped": covered_weight, "sources": sorted(chosen)})
        if covered_weight == sum(w for _, w in atoms):
            break
    return out


# --------------------------------------------------------------------------- exact: SciPy MILP
def _milp_frontier(origins, atoms, descopable_n, k_max):
    """Exact frontier via scipy.optimize.milp (HiGHS). Returns list or None if SciPy
    is unavailable. One MILP per budget k (max coverage s.t. sum x <= k)."""
    try:
        import numpy as np
        from scipy.optimize import milp, LinearConstraint, Bounds
    except Exception:
        return None

    origin_list = sorted(origins)
    oidx = {o: i for i, o in enumerate(origin_list)}
    nO = len(origin_list)
    nA = len(atoms)
    if nA == 0:
        return [{"k": k, "descoped": 0, "sources": [], "certified": True} for k in range(k_max + 1)]
    nV = nO + nA  # x (origins) then y (atoms, each "system class")

    # objective: maximize sum_a w_a * y_a  -> minimize -sum w_a y_a
    c = np.zeros(nV)
    for j, (_, w) in enumerate(atoms):
        c[nO + j] = -float(w)

    # constraints y_a <= x_s for every s in atom a  ->  y_a - x_s <= 0
    rows = []
    for j, (a, _) in enumerate(atoms):
        for s in a:
            row = np.zeros(nV)
            row[nO + j] = 1.0
            row[oidx[s]] = -1.0
            rows.append(row)
    cons = [LinearConstraint(np.array(rows), -np.inf, 0.0)] if rows else []

    integ = np.ones(nV)                  # all binary
    bounds = Bounds(np.zeros(nV), np.ones(nV))

    out = []
    for k in range(k_max + 1):
        budget = np.zeros(nV)
        budget[:nO] = 1.0
        kcons = list(cons) + [LinearConstraint(budget.reshape(1, -1), -np.inf, float(k))]
        res = milp(c=c, constraints=kcons, integrality=integ, bounds=bounds)
        if not res.success:
            return None
        x = res.x
        chosen = [origin_list[i] for i in range(nO) if x[i] > 0.5]
        descoped = int(round(-res.fun))
        out.append({"k": k, "descoped": descoped, "sources": sorted(chosen), "certified": True})
    return out


# --------------------------------------------------------------------------- exact: pure-Python B&B
def _bnb_frontier(origins, atoms, descopable_n, k_max):
    """Exact frontier via branch-and-bound over ancestor-set atoms. No dependency.

    For each budget k we maximize total completed weight subject to the union of
    chosen atoms' origins having size <= k. Atoms with |set| > k can never be
    completed within k and are dropped. DFS branches include/exclude per atom in
    descending-weight order; an admissible bound (sum of still-affordable atom
    weights) prunes aggressively. Returns the certified frontier, each row tagged
    with whether the search proved optimality within the node budget.
    """
    total_w = sum(w for _, w in atoms)
    out = [{"k": 0, "descoped": 0, "sources": [], "certified": True, "upper_bound": 0}]
    for k in range(1, k_max + 1):
        affordable = sorted((a for a in atoms if len(a[0]) <= k),
                            key=lambda aw: (-aw[1], len(aw[0])))
        if not affordable:
            out.append({"k": k, "descoped": 0, "sources": [], "certified": True, "upper_bound": 0})
            continue

        best = {"weight": 0, "union": frozenset()}
        nodes = [0]
        truncated = [False]
        m = len(affordable)
        # suffix weight sums for a quick (loose) admissible bound
        suffix = [0] * (m + 1)
        for i in range(m - 1, -1, -1):
            suffix[i] = suffix[i + 1] + affordable[i][1]

        def dfs(i, union, gained):
            if truncated[0]:
                return
            nodes[0] += 1
            if nodes[0] > _NODE_BUDGET:
                truncated[0] = True
                return
            if gained > best["weight"]:
                best["weight"], best["union"] = gained, union
            if i >= m:
                return
            # admissible bound: gained + weight of all remaining atoms that COULD
            # still fit (each individually affordable given remaining budget).
            rem_budget = k - len(union)
            ub = gained
            for j in range(i, m):
                a, w = affordable[j]
                if len(a - union) <= rem_budget:
                    ub += w
            if ub <= best["weight"]:
                return
            a, w = affordable[i]
            new_union = union | a
            if len(new_union) <= k:                 # include branch (take atom a)
                dfs(i + 1, new_union, gained + w)
            dfs(i + 1, union, gained)               # exclude branch

        dfs(0, frozenset(), 0)
        # certified optimum is best["union"]; if truncated, best is a valid lower
        # bound and `suffix[0]`-style root bound is the (loose) upper bound.
        root_ub = best["weight"] if not truncated[0] else min(total_w, suffix[0])
        out.append({
            "k": k, "descoped": best["weight"], "sources": sorted(best["union"]),
            "certified": not truncated[0],
            "upper_bound": best["weight"] if not truncated[0] else root_ub,
        })
    return out


# --------------------------------------------------------------------------- public API
def descope_frontier(G, pan_sources, scores=None, k_max: int = 10) -> dict:
    """Certified-optimal tokenization frontier + greedy gap.

    Returns a dict with: method used, the optimal frontier (per-k descoped count and
    the exact source set), the greedy baseline curve, the per-k optimality gap, and
    the minimum number of sources to reach 25/50/75/100 % of descopable systems.
    Safe and deterministic; degrades to greedy-only if the model is empty.
    """
    H = _flatten(G)
    origins, before_n, descopable_n, atoms, members = _build_atoms(H, pan_sources)
    k_max = max(1, min(k_max, len(origins)))

    # Greedy baseline = the SAME greedy roadmap the product ships (analytics
    # cumulative_descope_curve), so the chart is consistent with the rest of the report
    # AND deterministic. (A set-iteration greedy is non-deterministic across processes.)
    try:
        from . import analytics as _an
        gcurve = _an.cumulative_descope_curve(G, pan_sources, scores, max_k=k_max)
        greedy = [{"k": 0, "descoped": 0, "sources": []}]
        for c in gcurve:
            greedy.append({"k": c["k"], "descoped": c["cumulative_descoped"],
                           "sources": c.get("tokenized", [])})
    except Exception:
        greedy = _greedy_curve(origins, atoms, k_max)

    method = "scipy.milp (HiGHS, exact)"
    optimal = _milp_frontier(origins, atoms, descopable_n, k_max)
    if optimal is None:
        method = "branch-and-bound (exact, no-dependency)"
        optimal = _bnb_frontier(origins, atoms, descopable_n, k_max)

    all_certified = all(r.get("certified", True) for r in optimal)
    if not all_certified:
        method += " [node-budget reached on some k; bounds reported]"

    # align greedy to the frontier length and compute the gap
    g_by_k = {r["k"]: r["descoped"] for r in greedy}
    frontier = []
    max_gap = 0
    for r in optimal:
        k = r["k"]
        gd = g_by_k.get(k, g_by_k.get(max(x for x in g_by_k if x <= k), 0) if g_by_k else 0)
        opt = r["descoped"]
        gap = opt - gd
        max_gap = max(max_gap, gap)
        frontier.append({
            "k": k,
            "optimal_descoped": opt,
            "greedy_descoped": gd,
            "gap": gap,
            "optimal_sources": r["sources"],
            "certified": r.get("certified", True),
            "pct_of_descopable": round(100 * opt / descopable_n, 1) if descopable_n else 0.0,
        })

    # minimum sources to reach coverage milestones (read off the certified frontier)
    def min_k_for(frac):
        target = frac * descopable_n
        for r in frontier:
            if r["optimal_descoped"] >= target:
                return r["k"]
        return None

    milestones = {f"{int(f*100)}pct": min_k_for(f) for f in (0.25, 0.5, 0.75, 1.0)}

    # headline gap vs greedy at the same budget the greedy roadmap chose
    greedy_k = next((r["k"] for r in reversed(greedy)
                     if r["descoped"] == greedy[-1]["descoped"]), greedy[-1]["k"]) if greedy else 0
    opt_at_greedy_k = next((r["optimal_descoped"] for r in frontier if r["k"] == greedy_k), 0)
    greedy_at_greedy_k = g_by_k.get(greedy_k, 0)
    greedy_efficiency = (round(100 * greedy_at_greedy_k / opt_at_greedy_k, 1)
                         if opt_at_greedy_k else 100.0)

    return {
        "method": method,
        "objective": "max systems fully descoped s.t. <= k true sources tokenized "
                     "(supermodular AND-coverage; solved to certified optimality)",
        "descopable": descopable_n,
        "scope_before": before_n,
        "true_source_count": len(origins),
        "distinct_ancestor_sets": len(atoms),
        "k_max": k_max,
        "frontier": frontier,
        "milestones_min_sources": milestones,
        "max_greedy_gap": max_gap,
        "greedy_efficiency_pct": greedy_efficiency,
        "all_certified": all_certified,
    }


# --------------------------------------------------------------------------- min-cut segmentation
def segmentation_min_cut(G, pan_sources, targets=None, top: int = 6) -> dict:
    """Network-segmentation lever via max-flow / min-cut (Menger's theorem).

    For a high-value in-scope target T, the MINIMUM number of data-flow edges
    (integration points) that must be severed so that NO true PAN source can reach
    T equals the max-flow from a synthetic super-source (joined to every origin) to
    T with unit edge capacities. Those cut edges are the concrete segmentation work
    to ring-fence T — the second scope-reduction lever besides tokenizing the source.

    Returns the per-target minimum cut size and the actual edges to sever. Targets
    default to the highest-reach in-scope systems (the costliest to leave exposed).
    """
    H = _flatten(G)
    origins = _true_pan_sources(H, set(pan_sources))
    if not origins:
        return {"cuts": [], "note": "no true PAN origins"}

    # unit capacities on every real edge
    F = nx.DiGraph()
    F.add_nodes_from(H.nodes())
    for u, v in H.edges():
        F.add_edge(u, v, capacity=1)
    SS = "__PAN_SOURCE__"
    F.add_node(SS)
    for o in origins:
        F.add_edge(SS, o, capacity=float("inf"))   # sources are not themselves cuttable

    before = pci_scope(H, set(pan_sources))
    if targets is None:
        reach = {n: len(nx.descendants(H, n)) for n in before if n not in origins}
        targets = [n for n, _ in sorted(reach.items(), key=lambda kv: -kv[1])[:top]]

    cuts = []
    for t in targets:
        if t not in F or t == SS:
            continue
        try:
            cut_value, (reachable, _) = nx.minimum_cut(F, SS, t)
        except Exception:
            continue
        # recover the cut edges: edges from the source-side set to the sink-side set
        cut_edges = []
        for u in reachable:
            for v in H.successors(u) if u in H else []:
                if v not in reachable:
                    cut_edges.append([u, v])
        cuts.append({
            "target": t,
            "min_cut_edges": int(cut_value) if cut_value != float("inf") else None,
            "edges_to_sever": cut_edges[:12],
            "downstream_reach": len(nx.descendants(H, t)),
        })
    cuts.sort(key=lambda c: (c["min_cut_edges"] if c["min_cut_edges"] is not None else 1e9))
    return {
        "cuts": cuts,
        "note": "min edges to sever so no true PAN source reaches the target "
                "(max-flow/min-cut, unit capacities; Menger's theorem)",
    }
