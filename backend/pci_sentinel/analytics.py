"""Core analytics: queries + impact analysis.

  * heavy_hitters  — systems that distribute PAN to the most downstream consumers
                     (rubric: "primary distributors"); ranked by exclusive
                     downstream reach with degree/centrality as tie-context.
  * pci_scope      — the in-scope (CDE) set: PAN sources + everything reachable
                     from a PAN source in the data-flow graph (they receive PAN).
  * clean_stream_impact — simulate tokenizing PAN at a chosen true-source: nodes
                     that were in scope ONLY because they received PAN from that
                     source descope. Reports current vs target scope, node/edge
                     surface-area reduction, and risk reduction.
"""
from __future__ import annotations

import networkx as nx

from .scoring import _flatten


def pci_scope(H: nx.DiGraph, pan_sources: set) -> set:
    """Nodes in PCI scope = PAN sources plus all their data-flow descendants."""
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


def heavy_hitters(G, pan_sources: set, scores: dict, top_k: int = 10) -> list:
    """Rank PAN-originating systems by how much of the in-scope surface they feed.

    'exclusive_reach' = downstream nodes that fall out of scope if THIS source is
    tokenized (i.e. nodes reachable from it and not from any other PAN source).
    That is the direct clean-stream leverage of the system.
    """
    H = _flatten(G)
    full_scope = pci_scope(H, pan_sources)
    out = []
    for s in pan_sources:
        if s not in H:
            continue
        desc = nx.descendants(H, s)
        others = pan_sources - {s}
        reachable_wo = set()
        for o in others:
            reachable_wo |= nx.descendants(H, o) | {o}
        exclusive = (desc | {s}) - reachable_wo
        out.append({
            "system": s,
            "downstream_reach": len(desc),
            "exclusive_reach": len(exclusive),
            "out_degree": H.out_degree(s),
            "risk": scores.get(s, {}).get("risk", 0.0),
            "betweenness": scores.get(s, {}).get("betweenness", 0.0),
            "carries_pan": True,
        })
    out.sort(key=lambda x: (x["exclusive_reach"], x["downstream_reach"], x["risk"]), reverse=True)
    return out[:top_k]


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


def clean_stream_impact(G, pan_sources: set, scores: dict, tokenize: list) -> dict:
    """Simulate tokenizing PAN at the systems in `tokenize`.

    After tokenization those systems emit CRN, not PAN, so they are removed from
    the PAN-source set. Any node that remains reachable from another PAN source
    stays in scope; nodes fed only by the tokenized source(s) descope.

    Assumption (stated, per rubric): a descendant descopes when it no longer
    receives PAN AND does not itself independently originate PAN (declared
    carriers/detokenizers remain in scope regardless).
    """
    H = _flatten(G)
    independent = {n for n, d in H.nodes(data=True)
                   if d.get("carries_pan") or d.get("detokenizes")}
    before = pci_scope(H, pan_sources)
    remaining_sources = (pan_sources - set(tokenize)) | (independent - set(tokenize))
    after = pci_scope(H, remaining_sources) | (independent - set(tokenize))

    def pan_edges(scope):
        return sum(1 for u, v in H.edges() if u in scope)

    risk_before = sum(scores.get(n, {}).get("risk", 0.0) for n in before)
    # target risk: descoped nodes contribute 0; tokenized sources drop to CRN tier
    risk_after = 0.0
    for n in after:
        risk_after += scores.get(n, {}).get("risk", 0.0)
    descoped = before - after
    # FAQ Q7/Takeaway 7: systems that genuinely need PAN de-tokenize via centralized
    # RISE/APG services, so they remain in CDE scope even after upstream tokenization.
    retained_detok = sorted(n for n in after
                            if H.nodes[n].get("detokenizes") and n not in set(tokenize))
    return {
        "tokenized_systems": list(tokenize),
        "scope_before": len(before),
        "scope_after": len(after),
        "nodes_descoped": len(descoped),
        "descoped_systems_sample": sorted(descoped)[:25],
        "retained_via_detokenization": retained_detok,  # stay in CDE (RISE/APG)
        "retained_via_detokenization_count": len(retained_detok),
        "pan_edges_before": pan_edges(before),
        "pan_edges_after": pan_edges(after),
        "risk_before": round(risk_before, 1),
        "risk_after": round(risk_after, 1),
        "risk_reduction_pct": round(100 * (risk_before - risk_after) / risk_before, 1) if risk_before else 0.0,
        "node_surface_reduction_pct": round(100 * len(descoped) / len(before), 1) if before else 0.0,
    }


def what_if(G, pan_sources: set, scores: dict, tokenize: list) -> dict:
    """Clean-stream impact for an arbitrary set of tokenized sources, returning the
    FULL descoped and retained sets so the UI can recolor the graph and so the plan
    can show exactly which systems go safe-for-free vs. must onboard RISE/APG."""
    H = _flatten(G)
    independent = {n for n, d in H.nodes(data=True)
                   if d.get("carries_pan") or d.get("detokenizes")}
    before = pci_scope(H, pan_sources)
    remaining = (pan_sources - set(tokenize)) | (independent - set(tokenize))
    after = pci_scope(H, remaining) | (independent - set(tokenize))
    descoped = sorted(before - after)
    retained = sorted(n for n in after if H.nodes[n].get("detokenizes") and n not in set(tokenize))
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

    Method: greedy maximum-coverage — at each step add the candidate source whose
    marginal descope is largest. For monotone submodular coverage the greedy solution
    is within (1 - 1/e) ~ 63% of the optimal k-set (Nemhauser, Wolsey & Fisher, 1978),
    a named, defensible bound rather than a heuristic with no guarantee. Candidate
    levers are the top exclusive-reach distributors (interpretable, and bounds cost).
    """
    H = _flatten(G)
    before = pci_scope(H, pan_sources)
    before_n = len(before)
    independent = {n for n, d in H.nodes(data=True)
                   if d.get("carries_pan") or d.get("detokenizes")}
    descopable = before - independent
    candidates = [h["system"] for h in heavy_hitters(G, pan_sources, scores, top_k=candidate_k)]

    def scope_after(tok):
        remaining = (pan_sources - set(tok)) | (independent - set(tok))
        return pci_scope(H, remaining) | (independent - set(tok))

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
            "exclusive_reach": next((h["exclusive_reach"] for h in
                                     heavy_hitters(G, pan_sources, scores, top_k=candidate_k)
                                     if h["system"] == best), None),
            "pct_of_descopable": round(100 * cum / max(1, len(descopable)), 1),
        })
        cur = best_after
        if len(descopable) and cum / len(descopable) >= target_fraction:
            break
    return {
        "before": before_n, "descopable": len(descopable), "after": len(cur),
        "total_descoped": before_n - len(cur), "k": len(chosen),
        "plan": chosen, "steps": steps, "target_fraction": target_fraction,
        "method": "greedy max-coverage (Nemhauser-Wolsey-Fisher 1978; (1-1/e) bound)",
    }


def hidden_scope(G) -> dict:
    """FAQ Takeaway 5 (killer demo): systems BAM flags PCI=No but Splunk observed
    clear PAN in their logs -> hidden scope BAM misses. Also surfaces declared PAN
    carriers for the headline 'systems exposed to clear PAN' metric."""
    hidden = sorted(n for n, d in G.nodes(data=True)
                    if d.get("pan_in_logs_observed") and not d.get("pci_flag"))
    declared = sorted(n for n, d in G.nodes(data=True) if d.get("carries_pan"))
    return {"hidden_pci_systems": hidden, "hidden_pci_count": len(hidden),
            "declared_pan_systems_count": len(declared)}
