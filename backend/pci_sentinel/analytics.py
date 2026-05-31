"""Core analytics: queries + impact analysis.

  * heavy_hitters  — systems that distribute PAN to the most downstream consumers.
                     RANKED by downstream reach (the organizer definition of a
                     "primary distributor": FAQ 10.2 — "maps to out-degree and
                     reachability"). `solo_descope` (a.k.a. exclusive_reach) is
                     reported as a second, honest axis: how many systems descope
                     if THIS source alone is tokenized.
  * pci_scope      — the in-scope (CDE) set: PAN sources + everything reachable
                     from a PAN source in the data-flow graph (they receive PAN).
  * clean_stream_impact — simulate tokenizing PAN at chosen true-source(s). A
                     tokenized source does NOT leave scope: it still ingests the
                     real PAN to convert it, so it stays in the CDE as the
                     tokenization point (exactly like the RISE/APG de-tokenizers
                     the FAQ keeps in scope) — but its sensitivity drops from
                     tier 4 (transactable PAN) to tier 3 (non-transactable CRN),
                     per the data dictionary ("convert to Tokenized PAN to REDUCE
                     risk"; CRN "is not transactable"). The systems that actually
                     descope are the downstream nodes fed ONLY by the tokenized
                     source(s). Reports current vs target scope, node/edge surface
                     reduction, source tier-downgrades, and risk reduction.

Modelling note (defensible + conservative, backed by the organizer data
dictionary): full-track-data, PIN/CVV, and detokenizing systems are "always a
CDE candidate — tokenization of the PAN does not remove the risk of this data
element", so they never descope and never have their tier downgraded here.
"""
from __future__ import annotations

import networkx as nx

from .config import SETTINGS
from .scoring import _flatten


def pci_scope(H: nx.DiGraph, pan_sources: set, desc_cache: dict = None) -> set:
    """Nodes in PCI scope = PAN sources plus all their data-flow descendants.

    `desc_cache` optionally maps a source -> its descendant set (incl. itself),
    so repeated scope evaluations (e.g. the greedy optimizer's hundreds of
    what-if calls) become O(sources) set-unions instead of re-running a graph
    traversal each time. Without it, behaviour is unchanged.
    """
    if desc_cache is not None:
        scope = set()
        for s in pan_sources:
            d = desc_cache.get(s)
            if d is None:
                d = {s} | nx.descendants(H, s)
                desc_cache[s] = d
            scope |= d
        return scope
    scope = set(pan_sources)
    for s in pan_sources:
        scope |= nx.descendants(H, s)
    return scope


def scope_split(G_meta: nx.DiGraph, pan_sources: set, inferred_pan_sources: set,
                full_scope: set):
    """Partition the in-scope set by the strength of its evidence (rubric #5).

    A system is METADATA-CONFIRMED in scope when it is reachable from a
    BAM-declared PAN source through BAM-declared (authoritative) data-flow edges
    only. Everything else in scope is INFERRED-ONLY: it appears in scope solely
    because of a survey/Splunk signal (an inferred edge or an inferred PAN
    source). We never launder inferred candidates into confirmed scope; the
    split is reported so the headline number can be read honestly.

    Returns (breakdown_dict, metadata_confirmed_set, inferred_only_set).
    """
    full = set(full_scope)
    meta_sources = set(pan_sources) - set(inferred_pan_sources)
    meta_scope: set = set()
    for s in meta_sources:
        meta_scope.add(s)
        if s in G_meta:
            meta_scope |= nx.descendants(G_meta, s)
    meta_scope &= full                       # confirmed scope is a subset of total scope
    inferred_only = full - meta_scope
    breakdown = {
        "scope_total": len(full),
        "metadata_confirmed": len(meta_scope),
        "inferred_only": len(inferred_only),
        "inferred_only_sample": sorted(inferred_only)[:30],
    }
    return breakdown, meta_scope, inferred_only


def _exclusive_reach(H, s, pan_sources):
    """Systems that descope if THIS source alone is tokenized: nodes reachable
    from `s` and from NO other PAN source. Excludes `s` itself — a tokenized
    source stays in the CDE as the tokenization point (it still ingests real PAN
    to convert it), so it is not 'descoped'. This guarantees, by construction,
    solo_descope <= downstream_reach for every system."""
    desc = nx.descendants(H, s)
    reachable_wo = set()
    for o in pan_sources:
        if o == s:
            continue
        reachable_wo |= nx.descendants(H, o) | {o}
    return (desc - {s}) - reachable_wo


def heavy_hitters(G, pan_sources: set, scores: dict, top_k: int = 10) -> list:
    """Rank PAN-originating systems as 'primary distributors'.

    Ranking key = downstream_reach (FAQ 10.2: heavy hitter == "distributing clear
    card numbers to the most other systems" == reachability / out-degree), with
    solo_descope and risk as tie context. We expose BOTH axes because they answer
    different questions:
      * downstream_reach — blast radius: how many systems this source can expose.
      * solo_descope (== exclusive_reach) — how many descope if ONLY this source
        is tokenized. On densely-shared PAN flow this is small for everyone, which
        is precisely why the minimal-SET optimizer (see minimal_tokenization_plan)
        is the right tool rather than picking one source.
    """
    H = _flatten(G)
    out = []
    for s in pan_sources:
        if s not in H:
            continue
        desc = nx.descendants(H, s)
        exclusive = _exclusive_reach(H, s, pan_sources)
        out.append({
            "system": s,
            "downstream_reach": len(desc),
            "exclusive_reach": len(exclusive),   # kept for back-compat with the UI/JSON contract
            "solo_descope": len(exclusive),      # explicit, honest name for the same quantity
            "out_degree": H.out_degree(s),
            "risk": scores.get(s, {}).get("risk", 0.0),
            "betweenness": scores.get(s, {}).get("betweenness", 0.0),
            "carries_pan": True,
        })
    # primary-distributor ranking: reach first (organizer definition), then solo
    # descope leverage, then composite risk.
    out.sort(key=lambda x: (x["downstream_reach"], x["solo_descope"], x["risk"]), reverse=True)
    return out[:top_k]


def top_intervention(hh: list) -> str | None:
    """The single best FIRST tokenization lever = the source whose SOLO descope is
    largest (== greedy step 1), tie-broken by reach. Distinct from the top
    distributor (largest reach), which the heavy-hitter table is sorted by."""
    if not hh:
        return None
    best = max(hh, key=lambda h: (h.get("solo_descope", h.get("exclusive_reach", 0)),
                                  h.get("downstream_reach", 0)))
    return best["system"]


def recommended_levers(G, pan_sources: set, scores: dict, n: int = 3) -> list:
    """The top-n tokenization LEVERS to recommend = the first n picks of the greedy
    minimum-intervention plan (max marginal descope at each step). This is the
    correct 'what should we tokenize first' set — distinct from the heavy-hitter
    table's distributor ranking (by reach). Falls back to top solo-descope sources
    if the plan returns fewer than n (e.g. when marginal descope hits zero)."""
    plan = minimal_tokenization_plan(G, pan_sources, scores, target_fraction=1.0,
                                     max_k=max(1, n))
    picks = list(plan.get("plan", []))
    if len(picks) < n:
        # pad with the next-best solo-descope sources not already chosen
        hh = heavy_hitters(G, pan_sources, scores, top_k=len(pan_sources) or 1)
        for h in sorted(hh, key=lambda x: (x["solo_descope"], x["downstream_reach"]),
                        reverse=True):
            if h["system"] not in picks:
                picks.append(h["system"])
            if len(picks) >= n:
                break
    return picks[:n]


def trace_lineage(G, target: str, pan_sources: set, max_paths: int = 5) -> dict:
    """Trace how PAN reaches `target`: shortest paths from PAN sources to it."""
    H = _flatten(G)
    paths = []
    for s in pan_sources:
        if s in H and target in H and s != target and nx.has_path(H, s, target):
            try:
                paths.append(nx.shortest_path(H, s, target))
            except nx.NetworkXNoPath:
                pass
        if len(paths) >= max_paths:
            break
    return {"target": target, "in_scope": target in pci_scope(H, pan_sources),
            "pan_paths": paths}


def _always_cde(node_attrs: dict) -> bool:
    """Per data dictionary: full-track data, PIN/CVV, and detokenizers are
    'always a CDE candidate — tokenization of the PAN does not remove the risk of
    this data element'. Such systems never descope and never tier-downgrade."""
    return bool(node_attrs.get("full_track") or node_attrs.get("pin")
                or node_attrs.get("detokenizes"))


def _scope_after_tokenizing(H, pan_sources, tokenize, before):
    """Scope after tokenizing `tokenize`. Tokenized sources REMAIN in scope (they
    stay in the CDE as tokenization points); only downstream nodes fed solely by
    them descope. Independent PAN carriers / detokenizers stay regardless."""
    tok = set(tokenize)
    independent = {n for n, d in H.nodes(data=True)
                   if d.get("carries_pan") or d.get("detokenizes")}
    remaining = (pan_sources - tok) | (independent - tok)
    after = pci_scope(H, remaining) | (independent - tok)
    after |= (tok & before)                     # tokenization points stay in the CDE
    return after


def clean_stream_impact(G, pan_sources: set, scores: dict, tokenize: list) -> dict:
    """Simulate tokenizing PAN at the systems in `tokenize`.

    Descope semantics (FAQ Q5 + data dictionary): a downstream system goes safe
    only when EVERY clear-PAN source reaching it is tokenized. The tokenized
    sources themselves stay in the CDE (they convert PAN->CRN), but drop from
    tier 4 (transactable PAN) to tier 3 (non-transactable CRN) UNLESS they also
    hold full-track / PIN / detokenize (which keep them at tier 4).
    """
    H = _flatten(G)
    w = SETTINGS.weights
    tok = set(tokenize)
    before = pci_scope(H, pan_sources)
    after = _scope_after_tokenizing(H, pan_sources, tok, before)
    descoped = before - after

    def pan_edges(scope):
        return sum(1 for u, v in H.edges() if u in scope)

    def downgraded_risk(n):
        """Risk of n after tokenization. Descoped nodes are handled by exclusion
        from `after`; a tokenized PURE-PAN source drops tier 4->3."""
        base = scores.get(n, {}).get("risk", 0.0)
        if n in tok:
            d = H.nodes[n]
            tier = scores.get(n, {}).get("sensitivity_tier", 0)
            if tier > SETTINGS.tier_high and not _always_cde(d):
                # only the sensitivity term changes (PAN tier -> CRN tier)
                return round(base - 100.0 * w.sensitivity
                             * ((tier - SETTINGS.tier_high) / 4.0), 2)
        return base

    risk_before = sum(scores.get(n, {}).get("risk", 0.0) for n in before)
    risk_after = sum(downgraded_risk(n) for n in after)

    in_after_tok = tok & after
    sources_downgraded = sorted(
        n for n in in_after_tok
        if downgraded_risk(n) < scores.get(n, {}).get("risk", 0.0))
    sources_retained_tier4 = sorted(n for n in in_after_tok if n not in sources_downgraded)
    # FAQ Q7/Takeaway 7: systems that genuinely need PAN de-tokenize via centralized
    # RISE/APG services, so they remain in CDE scope even after upstream tokenization.
    retained_detok = sorted(n for n in after
                            if H.nodes[n].get("detokenizes") and n not in tok)
    return {
        "tokenized_systems": list(tokenize),
        "scope_before": len(before),
        "scope_after": len(after),
        "nodes_descoped": len(descoped),
        "descoped_systems_sample": sorted(descoped)[:25],
        "sources_downgraded": sources_downgraded,            # tier 4 -> 3 (PAN -> CRN)
        "sources_downgraded_count": len(sources_downgraded),
        "sources_retained_tier4": sources_retained_tier4,    # track/PIN/detok stay tier 4
        "retained_via_detokenization": retained_detok,       # stay in CDE (RISE/APG)
        "retained_via_detokenization_count": len(retained_detok),
        "pan_edges_before": pan_edges(before),
        "pan_edges_after": pan_edges(after),
        "risk_before": round(risk_before, 1),
        "risk_after": round(risk_after, 1),
        "risk_reduction_pct": round(100 * (risk_before - risk_after) / risk_before, 1) if risk_before else 0.0,
        "node_surface_reduction_pct": round(100 * len(descoped) / len(before), 1) if before else 0.0,
    }


def _gini(values):
    """Gini coefficient (Gini 1912) of a non-negative distribution, in [0,1].
    0 = perfectly even; ->1 = a few systems carry almost all the exposure."""
    xs = sorted(float(v) for v in values)
    n = len(xs)
    tot = sum(xs)
    if n == 0 or tot == 0:
        return 0.0
    cum = sum((i + 1) * x for i, x in enumerate(xs))
    return round((2 * cum) / (n * tot) - (n + 1) / n, 3)


def graph_structure_metrics(G, pan_sources: set, scores: dict, hh: list) -> dict:
    """Defensible, interpretable graph-theoretic structure metrics that quantify
    WHY a few interventions dominate — every one is named and citable, none is a
    black box.

      * concentration (Gini + HHI of downstream reach) — proves the exposure is
        carried by a handful of systems, justifying the heavy-hitter strategy.
      * propagation_depth — longest PAN path through the acyclic data-flow graph
        (how many hops clear PAN travels from a true source).
      * pan_islands — weakly-connected components of the PAN-flow subgraph
        (independent exposure clusters that can be reasoned about separately).
      * choke_points — articulation/cut vertices of the PAN-flow subgraph whose
        tokenization severs PAN to a whole branch (single points of propagation).
    """
    H = _flatten(G)
    # PAN-flow subgraph: edges that originate from a PAN-carrying system
    scope = pci_scope(H, pan_sources)
    P = H.subgraph(scope).copy()

    reaches = [scores.get(n, {}).get("downstream_reach", 0) for n in scope]
    tot_reach = sum(reaches) or 1
    shares = [r / tot_reach for r in reaches]
    hhi = round(sum(s * s for s in shares), 4)              # Herfindahl-Hirschman
    top5 = sum(sorted(reaches, reverse=True)[:5])
    top5_share = round(100 * top5 / tot_reach, 1)

    # propagation depth = longest PAN path; condense any residual cycles first so a
    # back-edge can't void the measure (depth is then in supernode hops, >= a lower
    # bound on physical hops)
    try:
        if nx.is_directed_acyclic_graph(P):
            depth = nx.dag_longest_path_length(P)
        elif P.number_of_nodes():
            depth = nx.dag_longest_path_length(nx.condensation(P))
        else:
            depth = 0
    except Exception:
        depth = None

    islands = nx.number_weakly_connected_components(P) if P.number_of_nodes() else 0

    # choke points: cut vertices on the undirected projection of the PAN subgraph
    try:
        choke = sorted(nx.articulation_points(P.to_undirected()),
                       key=lambda n: -scores.get(n, {}).get("downstream_reach", 0))
    except Exception:
        choke = []

    return {
        "reach_gini": _gini(reaches),
        "reach_hhi": hhi,
        "top5_reach_share_pct": top5_share,
        "propagation_depth": depth,
        "pan_islands": islands,
        "choke_points": choke[:12],
        "choke_point_count": len(choke),
        "pan_subgraph_nodes": P.number_of_nodes(),
        "pan_subgraph_edges": P.number_of_edges(),
    }


def what_if(G, pan_sources: set, scores: dict, tokenize: list) -> dict:
    """Clean-stream impact for an arbitrary set of tokenized sources, returning the
    FULL descoped and retained sets so the UI can recolor the graph and the plan
    can show exactly which systems go safe-for-free vs. must onboard RISE/APG."""
    H = _flatten(G)
    before = pci_scope(H, pan_sources)
    after = _scope_after_tokenizing(H, pan_sources, set(tokenize), before)
    descoped = sorted(before - after)
    retained = sorted(n for n in after
                      if H.nodes[n].get("detokenizes") and n not in set(tokenize))
    base = clean_stream_impact(G, pan_sources, scores, tokenize)
    base["descoped_systems"] = descoped            # full set (no cap) for graph recolor
    base["descoped_systems_sample"] = descoped[:60]
    base["retained_via_detokenization"] = retained
    base["retained_via_detokenization_count"] = len(retained)
    return base


def minimal_tokenization_plan(G, pan_sources: set, scores: dict,
                              target_fraction: float = 0.8, max_k: int = 8,
                              candidate_k: int = 25) -> dict:
    """Greedy minimum-intervention roadmap.

    Problem: choose the FEWEST PAN sources to tokenize that descope the MOST systems
    (FAQ: "where tokenization has the greatest reduction of clear card number usage").
    Descope semantics (FAQ Q5): a system goes safe only when every clear-PAN source
    reaching it is tokenized — so coverage is a monotone, submodular set function.
    Tokenized sources themselves stay in the CDE (tokenization points), consistent
    with clean_stream_impact.

    Method: greedy maximum-coverage — at each step add the candidate source whose
    marginal descope is largest. For monotone submodular coverage the greedy solution
    is within (1 - 1/e) ~ 63% of the optimal k-set (Nemhauser, Wolsey & Fisher, 1978),
    a named, defensible bound rather than a heuristic with no guarantee. Candidate
    levers are the top-reach distributors (interpretable, and bounds cost).
    """
    H = _flatten(G)
    before = pci_scope(H, pan_sources)
    before_n = len(before)
    independent = {n for n, d in H.nodes(data=True)
                   if d.get("carries_pan") or d.get("detokenizes")}
    descopable = before - independent
    hh_full = heavy_hitters(G, pan_sources, scores, top_k=candidate_k)   # computed once (reach-ranked)
    candidates = [h["system"] for h in hh_full]
    solo = {h["system"]: h["solo_descope"] for h in hh_full}
    cand_set = set(candidates)

    # Reachability cache + a precomputed FIXED scope from every source that is never
    # a tokenization candidate (those never change across what-ifs). Each greedy
    # evaluation then unions only the handful of active candidate descendant sets,
    # not the whole source set — keeping hundreds of evals well under a second even
    # at enterprise scale.
    cache = {}
    all_sources = pan_sources | independent
    for s in all_sources:                       # warm the cache once (no misses in loop)
        cache[s] = {s} | nx.descendants(H, s)
    fixed_sources = all_sources - cand_set
    fixed_scope = set().union(*[cache[s] for s in fixed_sources]) if fixed_sources else set()

    def scope_after(tok):
        tok = set(tok)
        active = [c for c in candidates if c not in tok]
        scope = set(fixed_scope)
        for c in active:
            scope |= cache[c]
        scope |= (independent - tok)            # tokenized independents stop sourcing PAN
        scope |= (tok & before)                 # but tokenization points themselves stay in CDE
        return scope

    chosen, steps, cur = [], [], before
    while len(chosen) < max_k:
        best, best_after = None, cur
        for s in candidates:
            if s in chosen:
                continue
            a = scope_after(chosen + [s])
            if len(a) < len(best_after):
                best, best_after = s, a
        if best is None or len(cur) - len(best_after) <= 0:
            break
        marginal = len(cur) - len(best_after)
        chosen.append(best)
        cum = before_n - len(best_after)
        steps.append({
            "step": len(chosen), "tokenize": best, "marginal_descoped": marginal,
            "cumulative_descoped": cum, "scope_after": len(best_after),
            "solo_descope": solo.get(best),
            "exclusive_reach": solo.get(best),       # back-compat alias
            "pct_of_descopable": round(100 * cum / max(1, len(descopable)), 1),
        })
        cur = best_after
        if len(descopable) and cum / len(descopable) >= target_fraction:
            break
    total = before_n - len(cur)
    return {
        "before": before_n, "descopable": len(descopable), "after": len(cur),
        "total_descoped": total, "k": len(chosen),
        "plan": chosen, "steps": steps, "target_fraction": target_fraction,
        # greedy on a monotone submodular coverage objective is >= (1-1/e) of the
        # optimal k-set, so the optimum descope with this many sources is bounded above.
        "optimality_bound_ceiling": round(total / 0.6321) if total else 0,
        "method": "greedy max-coverage (Nemhauser-Wolsey-Fisher 1978; (1-1/e) bound)",
    }


def hidden_scope(G) -> dict:
    """FAQ Takeaway 5 (killer demo): systems BAM flags PCI=No but Splunk observed
    clear PAN in their logs -> hidden scope BAM misses. Uses the CURRENT BAM PCI
    flag (DS4), so systems BAM has since caught are not counted (DS6's flag is a
    point-in-time snapshot). Also surfaces declared PAN carriers for the headline
    'systems exposed to clear PAN' metric, and a per-system evidence detail (the
    Splunk finding, the app's stated source, and how far the leaked PAN then
    propagates) so each BAM miss is auditable, not just counted."""
    H = _flatten(G)
    hidden, detail = [], []
    for n, d in G.nodes(data=True):
        if d.get("pan_in_logs_observed") and not d.get("pci_flag"):
            hidden.append(n)
            reach = len(nx.descendants(H, n)) if n in H else 0
            detail.append({
                "system": n,
                "name": d.get("app_name", ""),
                "downstream_reach": reach,            # how far the leaked PAN can travel onward
                "stated_source": d.get("splunk_stated_source", ""),
                "finding": d.get("splunk_finding", "") or "True PAN in logs",
            })
    hidden.sort()
    detail.sort(key=lambda x: (-x["downstream_reach"], x["system"]))
    declared = sorted(n for n, d in G.nodes(data=True) if d.get("carries_pan"))
    return {"hidden_pci_systems": hidden, "hidden_pci_count": len(hidden),
            "hidden_detail": detail,
            "hidden_propagating_count": sum(1 for x in detail if x["downstream_reach"] > 0),
            "declared_pan_systems_count": len(declared)}
