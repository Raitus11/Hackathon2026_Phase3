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
    edges = []
    for u, v, d in art.G.edges(data=True):
        edges.append({"source": u, "target": v, "provenance": d.get("provenance"),
                      "signal": d.get("signal", ""), "dataset": d.get("source_dataset", "")})
    return {"nodes": nodes, "edges": edges,
            "dag": {"nodes": [{"id": s, **dd} for s, dd in dagr.DAG.nodes(data=True)],
                    "edges": [{"source": u, "target": v, "weight": dd.get("weight", 1)}
                              for u, v, dd in dagr.DAG.edges(data=True)]},
            "heavy_hitters": hh}


def finalize(ing, art, dagr, scores, scope, hh, impact, hidden, audit) -> RunResult:
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
        "top_intervention": hh[0]["system"] if hh else None,
        "scope_reduction_if_top3_tokenized_pct": impact.get("node_surface_reduction_pct", 0.0),
    }

    llm = LLMClient()
    grounded = {"scope_size": len(scope), "dag_nodes": dagr.stats["dag_nodes"],
                "cycle_clusters": dagr.stats["cycle_clusters"],
                "scope_metadata_confirmed": breakdown["metadata_confirmed"],
                "scope_inferred_only": breakdown["inferred_only"],
                "hidden_pci_systems_bam_misses": hidden["hidden_pci_count"],
                "top_heavy_hitter": hh[0] if hh else {}, "impact": impact}
    explanation = llm.explain(
        "You are a PCI scope analyst. Explain the data-flow analysis to a mixed "
        "technical/non-technical audience using only the grounded facts.", grounded)

    return RunResult(
        quality=ing.quality, graph_stats=art.stats, dag_stats=dagr.stats,
        scope_size=len(scope), scope_breakdown=breakdown,
        heavy_hitters=hh, impact=impact, cycles=dagr.cycles[:20],
        unresolved_signals=art.unresolved_signals[:50], explanation=explanation,
        audit=audit, viz=_viz_payload(art, dagr, scores, scope, hh, inferred_only),
        headline=headline, hidden=hidden)


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
    recommend = [h["system"] for h in hh[:recommend_top]]
    impact = analytics.clean_stream_impact(art.G, art.pan_sources, scores, recommend)
    hidden = analytics.hidden_scope(art.G)
    _audit(log, "analytics", t, scope=len(scope), heavy_hitters=len(hh),
           hidden_pci=hidden["hidden_pci_count"])

    return finalize(ing, art, dagr, scores, scope, hh, impact, hidden, log)
