"""End-to-end pipeline orchestration with an audit trail.

ingest -> validate (masking-leak V-check) -> build graph -> condense to DAG ->
score -> analytics/impact -> shape viz JSON -> grounded explanation.

This is the deterministic spine the LangGraph supervisor will wrap in a later
slice; today it runs straight through and emits one audit line per stage.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from . import analytics, dag_transform, graph_build, ingest as ingest_mod
from .llm_client import LLMClient
from .scoring import compute_scores
from .security import scan_for_leaks


@dataclass
class RunResult:
    quality: dict = field(default_factory=dict)
    graph_stats: dict = field(default_factory=dict)
    dag_stats: dict = field(default_factory=dict)
    scope_size: int = 0
    scope_breakdown: dict = field(default_factory=dict)
    heavy_hitters: list = field(default_factory=list)
    impact: dict = field(default_factory=dict)
    cycles: list = field(default_factory=list)
    unresolved_signals: list = field(default_factory=list)
    explanation: str = ""
    audit: list = field(default_factory=list)
    viz: dict = field(default_factory=dict)
    headline: dict = field(default_factory=dict)
    hidden: dict = field(default_factory=dict)
    structure: dict = field(default_factory=dict)
    plan: dict = field(default_factory=dict)


def _audit(log, stage, t0, **extra):
    log.append({"stage": stage, "ms": round((time.perf_counter() - t0) * 1000, 1), **extra})


def _viz_payload(art, dagr, scores, scope, hh, inferred_scope=frozenset()):
    """Exact JSON contract the React/D3 views consume."""
    scope = set(scope)
    inferred_scope = set(inferred_scope)
    nodes = []
    for n, d in art.G.nodes(data=True):
        sc = scores.get(n, {})
        in_scope = n in scope
        nodes.append({
            "id": n, "name": d.get("app_name", ""),
            "in_scope": in_scope, "carries_pan": sc.get("carries_pan", False),
            "tier": d.get("sensitivity_tier", 0), "risk": sc.get("risk", 0.0),
            "reach": sc.get("downstream_reach", 0), "true_source": sc.get("is_true_source", False),
            "pan_in_logs_observed": bool(d.get("pan_in_logs_observed")),
            "hidden_pci": bool(d.get("pan_in_logs_observed") and not d.get("pci_flag")),
            "scope_prov": (("inferred" if n in inferred_scope else "metadata") if in_scope else None),
            "super_node": dagr.node_to_super.get(n),
        })
    # Collapse parallel edges (the MultiDiGraph carries one edge per source dataset,
    # so a pair present in DS1+DS2+DS3 appears 3x). One visual edge per (u,v):
    # provenance is 'metadata' if ANY contributing edge is authoritative, else 'inferred'.
    agg: dict = {}
    for u, v, d in art.G.edges(data=True):
        key = (u, v)
        e = agg.get(key)
        prov = d.get("provenance")
        ds = d.get("source_dataset") or d.get("dataset") or ""
        if e is None:
            agg[key] = {"source": u, "target": v, "provenance": prov,
                        "signal": d.get("signal", ""), "datasets": [ds] if ds else [], "count": 1}
        else:
            e["count"] += 1
            if ds and ds not in e["datasets"]:
                e["datasets"].append(ds)
            if prov == "metadata":           # any authoritative edge wins the provenance
                e["provenance"] = "metadata"
            if not e["signal"] and d.get("signal"):
                e["signal"] = d.get("signal")
    edges = [{**e, "dataset": ", ".join(e["datasets"])} for e in agg.values()]
    return {"nodes": nodes, "edges": edges,
            "dag": {"nodes": [{"id": s, **dd} for s, dd in dagr.DAG.nodes(data=True)],
                    "edges": [{"source": u, "target": v, "weight": dd.get("weight", 1)}
                              for u, v, dd in dagr.DAG.edges(data=True)]},
            "heavy_hitters": hh}


def finalize(ing, art, dagr, scores, scope, hh, impact, hidden, audit, plan=None) -> RunResult:
    """Single source of truth for assembling the final RunResult.

    Both the linear pipeline and the LangGraph orchestrator call this so the
    headline, scope split, grounded explanation, and viz payload can never
    drift apart.
    """
    breakdown, _meta_scope, inferred_only = analytics.scope_split(
        art.G_meta, art.pan_sources, art.inferred_pan_sources, scope)

    headline = {
        "systems_exposed_to_clear_pan": len(scope),     # FAQ: THE goal metric
        "scope_metadata_confirmed": breakdown["metadata_confirmed"],
        "scope_inferred_only": breakdown["inferred_only"],
        "hidden_pci_systems_bam_misses": hidden["hidden_pci_count"],
        "cycle_clusters_resolved": dagr.stats["cycle_clusters"],
        # top distributor (widest reach) is hh[0]; the top INTERVENTION is the best
        # solo-descope lever (== greedy step 1), which is a different question.
        "top_distributor": hh[0]["system"] if hh else None,
        "top_intervention": analytics.top_intervention(hh),
        "scope_reduction_if_top3_tokenized_pct": impact.get("node_surface_reduction_pct", 0.0),
    }

    llm = LLMClient()
    lever_sys = analytics.top_intervention(hh)
    lever_rec = next((h for h in hh if h["system"] == lever_sys), (hh[0] if hh else {}))
    grounded = {"scope_size": len(scope), "dag_nodes": dagr.stats["dag_nodes"],
                "cycle_clusters": dagr.stats["cycle_clusters"],
                "scope_metadata_confirmed": breakdown["metadata_confirmed"],
                "scope_inferred_only": breakdown["inferred_only"],
                "hidden_pci_systems_bam_misses": hidden["hidden_pci_count"],
                # two distinct axes — keep them separate so narration can't conflate them:
                "top_distributor": ({"system": hh[0]["system"], "downstream_reach": hh[0]["downstream_reach"]} if hh else {}),
                "top_lever": ({"system": lever_rec.get("system"),
                               "solo_descope": lever_rec.get("solo_descope", lever_rec.get("exclusive_reach", 0))} if lever_rec else {}),
                "impact": impact}
    explanation = llm.explain(
        "You are a PCI scope analyst. Explain the data-flow analysis to a mixed "
        "technical/non-technical audience using only the grounded facts.", grounded)

    return RunResult(
        quality=ing.quality, graph_stats=art.stats, dag_stats=dagr.stats,
        scope_size=len(scope), scope_breakdown=breakdown,
        heavy_hitters=hh, impact=impact, cycles=dagr.cycles[:20],
        unresolved_signals=art.unresolved_signals[:50], explanation=explanation,
        audit=audit, viz=_viz_payload(art, dagr, scores, scope, hh, inferred_only),
        headline=headline, hidden=hidden,
        structure=analytics.graph_structure_metrics(art.G, art.pan_sources, scores, hh),
        plan=plan or {})


def run(files: list, recommend_top: int = 3) -> RunResult:
    log = []
    t = time.perf_counter()
    ing = ingest_mod.ingest_files(files)
    _audit(log, "ingest", t, **ing.quality)

    t = time.perf_counter()
    leak = scan_for_leaks(ing.edge_rows + ing.bam_rows + ing.survey_rows + ing.splunk_rows)
    leak.raise_if_leaked()                      # FAIL the run on any unmasked PAN
    _audit(log, "validate_masking_leak", t, clean=leak.clean)

    t = time.perf_counter()
    art = graph_build.build_graph(ing)
    _audit(log, "build_graph", t, **art.stats)

    t = time.perf_counter()
    H_simple = analytics._flatten(art.G)        # all nodes + attributes, simple digraph
    dagr = dag_transform.condense_to_dag(H_simple)
    _audit(log, "condense_to_dag", t, **dagr.stats)

    t = time.perf_counter()
    scores = compute_scores(art.G)
    _audit(log, "score", t, scored_nodes=len(scores))

    t = time.perf_counter()
    H = analytics._flatten(art.G)
    scope = analytics.pci_scope(H, art.pan_sources)
    hh = analytics.heavy_hitters(art.G, art.pan_sources, scores, top_k=10)
    # recommendation = best greedy tokenization levers (NOT the reach-ranked
    # distributor table), so the gate/impact recommend the highest-leverage targets.
    recommend = analytics.recommended_levers(art.G, art.pan_sources, scores, recommend_top)
    impact = analytics.clean_stream_impact(art.G, art.pan_sources, scores, recommend)
    plan = analytics.minimal_tokenization_plan(art.G, art.pan_sources, scores,
                                               target_fraction=0.8, max_k=8)
    hidden = analytics.hidden_scope(art.G)
    _audit(log, "analytics", t, scope=len(scope), heavy_hitters=len(hh),
           hidden_pci=hidden["hidden_pci_count"])

    return finalize(ing, art, dagr, scores, scope, hh, impact, hidden, log, plan=plan)
