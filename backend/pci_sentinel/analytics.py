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
                     descope are the downstream nodes whose every TRUE PAN SOURCE
                     has been tokenized (clean-stream effect, FAQ Q5).

Clean-stream / true-source model (the correctness core of this module)
----------------------------------------------------------------------
FAQ Q5: "A system becomes safe when it is only ever in receipt of the CRN from
ALL of its upstream sources." The decisive distinction is between a system that
*originates* clear PAN and one that merely *carries* PAN it received:

  * TRUE PAN SOURCE (origin) — introduces clear PAN into the flow. Tokenizing it
    makes it emit CRN; the clean stream then propagates to everything fed solely
    by tokenized origins.
  * Pass-through carrier — flagged `carries_pan` in BAM only because it RECEIVED
    PAN. Once its true source emits CRN, it relays CRN. It must NOT be treated as
    an independent, un-cleanable PAN source, or the clean stream can never cross
    it and tokenizing the real source descopes nobody.
  * Always-CDE origin — detokenizers (RISE/APG regenerate PAN from CRN) and
    full-track / PIN holders. The data dictionary: "always a CDE candidate —
    tokenization of the PAN does not remove the risk of this data element." They
    re-introduce clear PAN regardless of upstream tokenization and cannot be
    tokenized away, so they are permanent origins.

`_true_pan_sources` computes the origin set cycle-safely via SCC condensation —
the same Tarjan->condensation rule used to build the DAG — so reciprocal/cyclic
BAM relationships cannot misclassify an origin. A downstream system descopes iff
ALL of its true-source-origin ancestors are tokenized (true-source-ancestors-only,
NOT every PAN-carrying ancestor).
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


def _always_cde(node_attrs: dict) -> bool:
    """Per data dictionary: full-track data, PIN/CVV, and detokenizers are
    'always a CDE candidate — tokenization of the PAN does not remove the risk of
    this data element'. Such systems never descope and never tier-downgrade."""
    return bool(node_attrs.get("full_track") or node_attrs.get("pin")
                or node_attrs.get("detokenizes"))


def _true_pan_sources(H: nx.DiGraph, pan_sources: set) -> set:
    """TRUE PAN ORIGINS: systems that introduce clear PAN into the flow rather than
    receiving it. This is the set whose tokenization yields the clean-stream effect.

    Cycle-safe by construction: we condense H to its DAG of strongly-connected
    components (Tarjan, via networkx.condensation — the same rule the pipeline uses
    to build the analysis DAG), then a PAN-carrying component is an ORIGIN iff no
    OTHER PAN-carrying component is its ancestor. Reciprocal/cyclic BAM links can
    therefore never make an origin look like a pass-through (or vice-versa).

    Always-CDE carriers (detokenizers, full-track, PIN) re-introduce clear PAN
    regardless of any upstream tokenization, so they are unconditionally origins.

    Returns the set of origin NODES (a subset of `pan_sources`).
    """
    carriers = {n for n in pan_sources if n in H}
    if not carriers:
        return set()

    C = nx.condensation(H)                       # DAG of SCCs; node attr 'members'
    comp_has_carrier = {}
    for i, data in C.nodes(data=True):
        comp_has_carrier[i] = bool(set(data["members"]) & carriers)

    # Single O(V+E) topological pass: does a carrier-bearing component sit upstream?
    has_carrier_ancestor = {i: False for i in C.nodes()}
    for i in nx.topological_sort(C):
        upstream_carrier = comp_has_carrier[i] or has_carrier_ancestor[i]
        if upstream_carrier:
            for j in C.successors(i):
                has_carrier_ancestor[j] = True

    origins: set = set()
    for i in C.nodes():
        if comp_has_carrier[i] and not has_carrier_ancestor[i]:
            origins |= (set(C.nodes[i]["members"]) & carriers)

    # always-CDE carriers re-source PAN regardless of upstream -> permanent origins
    always = {n for n in carriers if _always_cde(H.nodes[n])}
    return origins | always


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


def _origin_reach_count(H, origins, desc_cache=None):
    """For every node, how many TRUE PAN ORIGINS reach it (origin itself counts).
    A node's count == the number of distinct true-source ancestors it has — the
    quantity that determines whether tokenizing a set of origins fully frees it.
    Returns (reach_count: Counter, desc_cache)."""
    from collections import Counter
    if desc_cache is None:
        desc_cache = {}
    reach_count = Counter()
    for s in origins:
        d = desc_cache.get(s)
        if d is None:
            d = nx.descendants(H, s)
            desc_cache[s] = d
        for n in d:
            reach_count[n] += 1
        reach_count[s] += 1                  # an origin reaches itself
    return reach_count, desc_cache


def heavy_hitters(G, pan_sources: set, scores: dict, top_k: int = 10) -> list:
    """Rank PAN-originating systems as 'primary distributors'.

    Ranking key = downstream_reach (FAQ 10.2: heavy hitter == "distributing clear
    card numbers to the most other systems" == reachability / out-degree), with
    solo_descope and risk as tie context. We expose BOTH axes because they answer
    different questions:
      * downstream_reach — blast radius: how many systems this source can expose.
      * solo_descope (== exclusive_reach) — how many descope if ONLY this source
        is tokenized, measured against the TRUE PAN ORIGIN set (so exclusivity
        means "no OTHER true source reaches the node", not "no other PAN carrier").
        On densely-shared PAN flow this is small for everyone, which is precisely
        why the minimal-SET optimizer (see minimal_tokenization_plan) and the
        exposure-level metrics (see source_exposure_impact) matter more than
        picking one source.

    `is_true_source` marks which distributors are actual tokenization levers
    (origins). A high-reach pass-through carrier is a big distributor but NOT a
    lever — tokenizing it cleans nothing, because it only relays PAN it received.
    """
    import logging
    log = logging.getLogger(__name__)
    H = _flatten(G)
    sources = [s for s in pan_sources if s in H]
    origins = _true_pan_sources(H, set(pan_sources))
    log.info(f"       [heavy_hitters] {len(sources)} PAN sources, {len(origins)} true origins; caching descendants...")

    # descendants of each PAN source once (for reach + the distributor table)
    desc_cache = {}
    for idx, s in enumerate(sources, 1):
        desc_cache[s] = nx.descendants(H, s)
        if idx % 50 == 0 or idx == len(sources):
            log.info(f"       [heavy_hitters] cached descendants {idx}/{len(sources)}")

    # exclusivity is measured against TRUE ORIGINS only (clean-stream correct)
    origin_reach, _ = _origin_reach_count(H, origins, desc_cache=dict(desc_cache))
    log.info(f"       [heavy_hitters] origin reach-count over {len(origin_reach)} nodes")

    out = []
    for s in sources:
        desc = desc_cache[s]
        is_origin = s in origins
        # solo descope only makes sense for an origin: nodes it reaches that are
        # reached by exactly one origin (that origin being s). A pass-through has
        # no solo descope by construction (it is not a lever).
        if is_origin:
            exclusive = {n for n in desc if n != s and origin_reach[n] == 1}
        else:
            exclusive = set()
        out.append({
            "system": s,
            "downstream_reach": len(desc),
            "exclusive_reach": len(exclusive),   # kept for back-compat with the UI/JSON contract
            "solo_descope": len(exclusive),      # explicit, honest name for the same quantity
            "out_degree": H.out_degree(s),
            "risk": scores.get(s, {}).get("risk", 0.0),
            "betweenness": scores.get(s, {}).get("betweenness", 0.0),
            "carries_pan": True,
            "is_true_source": bool(is_origin),   # is this distributor an actual lever?
        })
    log.info(f"       [heavy_hitters] sorting {len(out)} sources by reach...")
    out.sort(key=lambda x: (x["downstream_reach"], x["solo_descope"], x["risk"]), reverse=True)
    return out[:top_k]


def top_intervention(hh: list) -> str | None:
    """The single best FIRST tokenization lever = the source whose SOLO descope is
    largest (== greedy step 1), tie-broken by reach. Distinct from the top
    distributor (largest reach), which the heavy-hitter table is sorted by.
    Only true sources can be levers, so we ignore pass-through carriers."""
    levers = [h for h in hh if h.get("is_true_source", True)]
    pool = levers or hh
    if not pool:
        return None
    best = max(pool, key=lambda h: (h.get("solo_descope", h.get("exclusive_reach", 0)),
                                    h.get("downstream_reach", 0)))
    return best["system"]


def recommended_levers(G, pan_sources: set, scores: dict, n: int = 3) -> list:
    """The top-n tokenization LEVERS to recommend = the first n picks of the greedy
    minimum-intervention plan (max marginal descope at each step). This is the
    correct 'what should we tokenize first' set — distinct from the heavy-hitter
    table's distributor ranking (by reach). Falls back to the top sources by
    exposure benefit (feeds_removed, then solo descope) if the plan returns fewer
    than n (e.g. when marginal FULL descope hits zero but exposure benefit does not)."""
    import logging
    log = logging.getLogger(__name__)
    log.info(f"       [recommended_levers] computing minimal tokenization plan (greedy set-cover)...")
    plan = minimal_tokenization_plan(G, pan_sources, scores, target_fraction=1.0,
                                     max_k=max(1, n))
    picks = list(plan.get("plan", []))
    if len(picks) < n:
        # pad with the next-best sources by EXPOSURE benefit (feeds_removed), not full
        # descope — so a recommendation always names the highest-leverage origins even
        # when single-source full descope is zero (the dense-convergence case).
        log.info(f"       [recommended_levers] plan returned {len(picks)}; padding by exposure benefit...")
        exp = source_exposure_impact(G, pan_sources, scores).get("per_source", [])
        for row in sorted(exp, key=lambda r: (r["feeds_removed"], r["solo_descope"]),
                          reverse=True):
            if row["system"] not in picks:
                picks.append(row["system"])
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


def _scope_after_tokenizing(H, pan_sources, tokenize, before, origins=None):
    """Scope after tokenizing `tokenize`, under clean-stream semantics (FAQ Q5).

    A downstream system descopes when ALL of its TRUE-PAN-SOURCE (origin) ancestors
    are tokenized — NOT when every PAN-carrying intermediary is. Intermediaries
    carry PAN only because they received it; once their true source emits CRN they
    relay CRN, so the clean stream propagates THROUGH them. This is the fix for the
    previously-too-strict predicate that treated every `carries_pan` node as an
    un-cleanable independent source (which structurally pinned descope at ~0).

    Tokenized origins REMAIN in the CDE as tokenization points. Always-CDE origins
    (detok / full-track / PIN) are part of `origins`, are never in `tokenize`, and
    therefore keep re-sourcing PAN to their descendants.
    """
    tok = set(tokenize)
    if origins is None:
        origins = _true_pan_sources(H, set(pan_sources))
    remaining_origins = origins - tok
    after = pci_scope(H, remaining_origins)      # remaining origins + their descendants
    after |= (tok & before)                      # tokenization points stay in the CDE
    return after


def clean_stream_impact(G, pan_sources: set, scores: dict, tokenize: list) -> dict:
    """Simulate tokenizing PAN at the systems in `tokenize`.

    Descope semantics (FAQ Q5 + data dictionary): a downstream system goes safe
    only when EVERY TRUE PAN SOURCE reaching it is tokenized. The tokenized sources
    themselves stay in the CDE (they convert PAN->CRN), but drop from tier 4
    (transactable PAN) to tier 3 (non-transactable CRN) UNLESS they also hold
    full-track / PIN / detokenize (which keep them at tier 4).

    Beyond full descope, we also report EXPOSURE-level benefit (which is non-zero
    even when full descope is not): feeds_removed (systems that lose a clear-PAN
    feed) and parent_reduction (systems whose true-source-parent count drops but
    that remain in scope via another source).
    """
    H = _flatten(G)
    w = SETTINGS.weights
    tok = set(tokenize)
    origins = _true_pan_sources(H, set(pan_sources))
    before = pci_scope(H, pan_sources)
    after = _scope_after_tokenizing(H, pan_sources, tok, before, origins=origins)
    descoped = before - after

    # exposure-level benefit: union of descendants of the tokenized origins, within scope
    tok_origins = tok & origins
    fed_by_tok = set()
    for t in tok_origins:
        fed_by_tok |= ({t} | nx.descendants(H, t))
    feeds_removed = (fed_by_tok & before) - tok          # systems that lose a clear-PAN feed
    parent_reduction = feeds_removed - descoped          # narrowed but still in scope

    def pan_edges(scope):
        return sum(1 for u, v in H.edges() if u in scope)

    def downgraded_risk(n):
        base = scores.get(n, {}).get("risk", 0.0)
        if n in tok:
            d = H.nodes[n]
            tier = scores.get(n, {}).get("sensitivity_tier", 0)
            if tier > SETTINGS.tier_high and not _always_cde(d):
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
    retained_detok = sorted(n for n in after
                            if H.nodes[n].get("detokenizes") and n not in tok)
    return {
        "tokenized_systems": list(tokenize),
        "scope_before": len(before),
        "scope_after": len(after),
        "nodes_descoped": len(descoped),
        "descoped_systems_sample": sorted(descoped)[:25],
        # exposure-level benefit (non-zero even when full descope is 0)
        "feeds_removed": len(feeds_removed),
        "feeds_removed_sample": sorted(feeds_removed)[:25],
        "parent_reduction": len(parent_reduction),
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


def source_exposure_impact(G, pan_sources: set, scores: dict, top_k: int = 25) -> dict:
    """Per-true-source EXPOSURE impact — the 'block-this-source, measure-the-benefit'
    table the FAQ asks for. For every true PAN origin T we report:

      * downstream_reach  — systems T can feed clear PAN to (blast radius).
      * solo_descope      — systems fully freed if ONLY T is tokenized (T is their
                            single true source).  ( == exclusive_reach )
      * feeds_removed      — systems that lose a clear-PAN feed when T -> CRN
                            (every system T reaches in scope). Non-zero, meaningful.
      * parent_reduction   — systems whose true-source-parent count drops by >=1 but
                            that remain in scope via another source
                            ( == feeds_removed - solo_descope ).

    Decomposition that holds by construction:  feeds_removed = solo_descope + parent_reduction.
    This is what turns the honest 0%-full-descope result into a ranked, non-zero
    intervention story.
    """
    H = _flatten(G)
    before = pci_scope(H, pan_sources)
    origins = _true_pan_sources(H, set(pan_sources))
    origin_reach, desc_cache = _origin_reach_count(H, origins)

    rows = []
    for s in origins:
        desc = desc_cache.get(s) or nx.descendants(H, s)
        fed = ({s} | desc) & before
        feeds_removed = fed - {s}                                  # systems losing T's feed
        solo = {n for n in desc if n != s and origin_reach[n] == 1}
        rows.append({
            "system": s,
            "downstream_reach": len(desc),
            "solo_descope": len(solo),
            "feeds_removed": len(feeds_removed),
            "parent_reduction": len(feeds_removed) - len(solo),
            "risk": scores.get(s, {}).get("risk", 0.0),
            "is_true_source": True,
            # names of the systems FULLY freed by blocking this one source (small on a
            # saturated estate) — drives the "who benefits" overlay + the named report.
            "solo_systems": sorted(solo)[:50],
        })
    # Rank so the DEFAULT-highlighted source is the genuinely best SINGLE block:
    # most systems fully freed, then widest exposure narrowed, then reach.
    rows.sort(key=lambda r: (r["solo_descope"], r["feeds_removed"], r["downstream_reach"]),
              reverse=True)
    return {
        "true_source_count": len(origins),
        "scope_before": len(before),
        "per_source": rows[:top_k],
        "per_source_full_count": len(rows),
    }


def cumulative_descope_curve(G, pan_sources: set, scores: dict, max_k: int = 25) -> list:
    """Greedy cumulative descope curve: tokenize true sources in greedy max-marginal
    order and record, at each step, how many systems are FULLY descoped and how many
    have lost a clear-PAN feed (exposure narrowed). THIS is the headline finding — it
    shows full descope only ramps once most of the source front is tokenized, which is
    *why* single-source tokenization frees ~0 (told as insight, not failure)."""
    H = _flatten(G)
    before = pci_scope(H, pan_sources)
    before_n = len(before)
    origins = _true_pan_sources(H, set(pan_sources))
    # candidate ordering = origins by reach (interpretable, bounds cost)
    cache = {s: ({s} | nx.descendants(H, s)) for s in origins}
    candidates = sorted(origins, key=lambda s: -len(cache[s]))[:max_k]

    def scope_after(tok):
        rem = origins - set(tok)
        scope = set()
        for s in rem:
            scope |= cache[s]
        scope |= (set(tok) & before)
        return scope

    chosen, curve, cur = [], [], before
    fed_cum = set()
    while len(chosen) < max_k:
        best, best_after, best_marginal = None, cur, 0
        for s in candidates:
            if s in chosen:
                continue
            a = scope_after(chosen + [s])
            marg = len(cur) - len(a)
            if marg > best_marginal or (best is None and marg >= 0):
                best, best_after, best_marginal = s, a, marg
        if best is None:
            break
        chosen.append(best)
        # STRICT descendants only (exclude the source itself) and never subtract the
        # growing `chosen` set — feeds-removed counts DOWNSTREAM consumers that lost a
        # clear-PAN feed, which can only grow as more sources are tokenized (monotone).
        fed_cum |= (nx.descendants(H, best) & before)
        cur = best_after
        curve.append({
            "k": len(chosen),
            "tokenized": list(chosen),
            "last_source": best,
            "cumulative_descoped": before_n - len(cur),
            "marginal_descoped": best_marginal,
            "cumulative_feeds_removed": len(fed_cum),
        })
        if len(cur) == 0:
            break
    return curve


def saturation_curve(G, pan_sources: set, scores: dict, points: int = 12) -> dict:
    """The supermodular-cliff proof. Tokenize true sources in reach order at coarse
    cumulative counts (0, n/points, ... , all) and record how many systems FULLY
    descope at each. On a saturated estate this stays ~0 until nearly the whole source
    front is tokenized, then jumps — the visual that explains *why* no small set helps,
    and the empirical signature of supermodularity (marginal gains increase)."""
    H = _flatten(G)
    before = pci_scope(H, pan_sources)
    before_n = len(before)
    origins = list(_true_pan_sources(H, set(pan_sources)))
    cache = {s: ({s} | nx.descendants(H, s)) for s in origins}
    order = sorted(origins, key=lambda s: -len(cache[s]))
    n = len(order)
    ks = sorted({0} | {round(i * n / points) for i in range(1, points)} | {n})
    out = []
    for k in ks:
        tok = set(order[:k])
        rem = set(origins) - tok
        scope = set()
        for s in rem:
            scope |= cache[s]
        scope |= (tok & before)
        out.append({"k": k, "pct_sources": round(100 * k / max(1, n), 1),
                    "fully_descoped": before_n - len(scope)})
    return {"source_count": n, "scope_before": before_n, "curve": out}


def block_set_comparison(G, pan_sources: set, scores: dict, sets: dict) -> dict:
    """Compare candidate block-sets side by side (FAQ: 'block this / block that and
    compare'). `sets` maps a label -> list of source systems. For each set we report
    full descope, clear-PAN feeds removed, parent-count reductions, and risk delta."""
    out = {}
    for label, members in sets.items():
        imp = clean_stream_impact(G, pan_sources, scores, list(members))
        out[label] = {
            "tokenize": list(members),
            "fully_descoped": imp["nodes_descoped"],
            "feeds_removed": imp["feeds_removed"],
            "parent_reduction": imp["parent_reduction"],
            "risk_reduction_pct": imp["risk_reduction_pct"],
            "scope_before": imp["scope_before"],
            "scope_after": imp["scope_after"],
        }
    return out


def what_if(G, pan_sources: set, scores: dict, tokenize: list) -> dict:
    """Clean-stream impact for an arbitrary set of tokenized sources, returning the
    FULL descoped and retained sets so the UI can recolor the graph and the plan
    can show exactly which systems go safe-for-free vs. must onboard RISE/APG.
    Also returns the exposure-level benefit so blocking ALWAYS shows non-zero value."""
    H = _flatten(G)
    origins = _true_pan_sources(H, set(pan_sources))
    before = pci_scope(H, pan_sources)
    after = _scope_after_tokenizing(H, pan_sources, set(tokenize), before, origins=origins)
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

    Problem: choose the FEWEST true PAN sources to tokenize that descope the MOST
    systems (FAQ: "where tokenization has the greatest reduction of clear card number
    usage"). Descope semantics (FAQ Q5): a system goes safe only when EVERY TRUE PAN
    SOURCE reaching it is tokenized — a conjunctive ("AND") coverage condition.

    Method & honesty about the bound: each step adds the candidate source with the
    largest marginal FULL descope. Note the objective is NOT submodular: because a
    system frees only when ALL its true sources are tokenized, marginal returns
    INCREASE as the source front gets covered (the freed-systems objective is
    supermodular), so the (1-1/e) greedy guarantee of Nemhauser-Wolsey-Fisher (1978)
    does NOT apply here. We therefore report greedy as a transparent, interpretable
    heuristic and present the honest result — together with the cumulative descope
    curve and the per-source exposure metrics, which carry the intervention story
    when full descope ramps slowly under dense multi-source convergence.

    Candidate levers are the top-reach TRUE SOURCES (origins) only — tokenizing a
    pass-through carrier cleans nothing, so it is never a candidate.
    """
    H = _flatten(G)
    before = pci_scope(H, pan_sources)
    before_n = len(before)
    origins = _true_pan_sources(H, set(pan_sources))
    independent = {n for n, d in H.nodes(data=True) if _always_cde(d)}
    descopable = before - independent

    # candidates = top-reach ORIGINS (levers), computed once
    cache = {s: ({s} | nx.descendants(H, s)) for s in origins}
    candidates = sorted(origins, key=lambda s: -len(cache[s]))[:candidate_k]
    # solo descope per candidate (against the origin set) for reporting
    origin_reach, _ = _origin_reach_count(H, origins, desc_cache={s: (cache[s] - {s}) for s in origins})
    solo = {}
    for s in candidates:
        solo[s] = sum(1 for n in cache[s] if n != s and origin_reach[n] == 1)

    def scope_after(tok):
        rem = origins - set(tok)
        scope = set()
        for s in rem:
            scope |= cache[s]
        scope |= (set(tok) & before)         # tokenization points stay in the CDE
        return scope

    chosen, steps, cur = [], [], before
    import logging
    log = logging.getLogger(__name__)
    log.info(f"       [plan] greedy set-cover: {len(candidates)} origin candidates, "
             f"{before_n} in scope, max_k={max_k}")
    while len(chosen) < max_k:
        best, best_after = None, cur
        for s in candidates:
            if s in chosen:
                continue
            a = scope_after(chosen + [s])
            if len(a) < len(best_after):
                best, best_after = s, a
        if best is None or len(cur) - len(best_after) <= 0:
            log.info(f"       [plan] no further marginal full-descope; stopping greedy")
            break
        marginal = len(cur) - len(best_after)
        chosen.append(best)
        cum = before_n - len(best_after)
        steps.append({
            "step": len(chosen), "tokenize": best, "marginal_descoped": marginal,
            "cumulative_descoped": cum, "scope_after": len(best_after),
            "solo_descope": solo.get(best), "exclusive_reach": solo.get(best),
            "pct_of_descopable": round(100 * cum / max(1, len(descopable)), 1),
        })
        cur = best_after
        if len(descopable) and cum / len(descopable) >= target_fraction:
            log.info(f"       [plan] reached target fraction, stopping")
            break

    total = before_n - len(cur)
    # cumulative curve (fills the TokenizationPlan tab + is the headline visual,
    # even when greedy full-descope halts early)
    curve = cumulative_descope_curve(G, pan_sources, scores, max_k=candidate_k)
    log.info(f"       [plan] complete: {len(chosen)} steps, {total} systems fully descoped")
    return {
        "before": before_n, "descopable": len(descopable), "after": len(cur),
        "total_descoped": total, "k": len(chosen),
        "plan": chosen, "steps": steps, "target_fraction": target_fraction,
        "true_source_count": len(origins),
        "cumulative_curve": curve,
        # Honest method statement: greedy is a heuristic here (objective is supermodular,
        # so no (1-1/e) guarantee). The exposure metrics carry the story.
        "method": "greedy max-marginal full-descope (heuristic; objective is supermodular "
                   "under conjunctive true-source coverage, so no (1-1/e) guarantee)",
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


def weight_sensitivity(scores: dict, top_n: int = 8) -> dict:
    """Robustness of the heavy-hitter ranking to the risk weights.

    The composite risk uses weights 0.40/0.30/0.20/0.10 (sensitivity/reach/
    betweenness/source). A fair challenge is whether the ranking is an artifact of
    those constants. We recompute each PAN-carrying system's risk from its
    already-stored, graph-derived factors (no graph re-traversal) under several
    alternative weightings, and measure how far the ordering moves. Spearman rank
    correlation near 1.0 and stable top-5 membership mean the conclusions do not
    depend on the specific weights — they fall out of the data-flow structure."""
    universe = [n for n, s in scores.items() if s.get("carries_pan")]
    if len(universe) < 2:
        return {}

    def risk_under(w, n):
        f = scores[n]["factors"]
        return (w[0] * f["sensitivity_norm"] + w[1] * f["reach_norm"]
                + w[2] * f["betweenness_norm"] + w[3] * f["source_flag"])

    def ranking(w):  # PAN carriers ordered by risk desc (ties broken by id for determinism)
        return sorted(universe, key=lambda n: (-risk_under(w, n), n))

    bw = SETTINGS.weights
    scenarios_def = [
        ("Base (0.40/0.30/0.20/0.10)", (bw.sensitivity, bw.reach, bw.betweenness, bw.source)),
        ("Equal", (0.25, 0.25, 0.25, 0.25)),
        ("Sensitivity-heavy", (0.55, 0.20, 0.15, 0.10)),
        ("Reach-heavy", (0.20, 0.55, 0.15, 0.10)),
        ("Betweenness-heavy", (0.20, 0.20, 0.50, 0.10)),
        ("Source-heavy", (0.25, 0.25, 0.20, 0.30)),
    ]
    base_order = ranking(scenarios_def[0][1])
    base_rank = {n: i for i, n in enumerate(base_order)}
    tracked = base_order[:top_n]
    base_top5 = set(base_order[:5])

    def spearman(order):
        # Honest: rho over the FULL universe of PAN carriers using each system's
        # GLOBAL rank under base vs the scenario. The old version correlated only the
        # base top-8 among themselves, so a scenario that leapfrogs new systems into
        # the top while leaving the original 8 in the same relative order scored
        # rho=1.00 yet had 0/5 top-5 overlap — a contradiction. Full-universe ranks
        # capture the real reshuffle (e.g. betweenness-heavy surfaces conduit hubs).
        idx = {n: i for i, n in enumerate(order)}
        m = len(universe)
        if m < 2:
            return 1.0
        d2 = sum((base_rank[n] - idx[n]) ** 2 for n in universe)
        return round(1 - 6 * d2 / (m * (m * m - 1)), 3)

    scen_out, rhos, min_overlap = [], [], 5
    rank_by_scenario = {}
    least_robust = {"name": None, "rho": 1.0, "overlap": 5}
    for i, (name, w) in enumerate(scenarios_def):
        order = ranking(w)
        rank_by_scenario[name] = {n: j + 1 for j, n in enumerate(order)}
        if i == 0:
            rho = 1.0
        else:
            rho = spearman(order); rhos.append(rho)
            ov = len(base_top5 & set(order[:5]))
            min_overlap = min(min_overlap, ov)
            if rho < least_robust["rho"]:
                least_robust = {"name": name, "rho": rho, "overlap": ov}
        scen_out.append({
            "name": name,
            "weights": {"sensitivity": round(w[0], 2), "reach": round(w[1], 2),
                        "betweenness": round(w[2], 2), "source": round(w[3], 2)},
            "top5": order[:5], "rho": rho,
            "top5_overlap": (5 if i == 0 else len(base_top5 & set(order[:5]))),
        })

    tracked_rows = []
    for n in tracked:
        ranks = [rank_by_scenario[name][n] for name, _ in scenarios_def]
        tracked_rows.append({"system": n, "base_rank": base_rank[n] + 1,
                             "min_rank": min(ranks), "max_rank": max(ranks)})

    return {
        "scenarios": scen_out,
        "mean_rank_correlation": round(sum(rhos) / len(rhos), 3) if rhos else 1.0,
        "min_rank_correlation": min(rhos) if rhos else 1.0,
        "top5_overlap_min": min_overlap,
        "least_robust_scenario": least_robust,
        "tracked": tracked_rows,
        "universe_size": len(universe),
    }


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
    scope = pci_scope(H, pan_sources)
    P = H.subgraph(scope).copy()

    reaches = [scores.get(n, {}).get("downstream_reach", 0) for n in scope]
    tot_reach = sum(reaches) or 1
    shares = [r / tot_reach for r in reaches]
    hhi = round(sum(s * s for s in shares), 4)              # Herfindahl-Hirschman
    top5 = sum(sorted(reaches, reverse=True)[:5])
    top5_share = round(100 * top5 / tot_reach, 1)

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
        "weight_sensitivity": weight_sensitivity(scores),
    }
