"""LangGraph orchestration of the PCI-SENTINEL pipeline.

The deterministic spine (ingest -> validate -> graph -> dag -> score -> analyze
-> report) is expressed as an explicit StateGraph so the agentic structure is
real, inspectable, and resumable. A human-in-the-loop approval gate sits between
analysis and reporting (approve / revise / abort). auto_approve=True runs
unattended on sample data; set False to require a human decision via interrupt.

LangGraph state is checkpointed (MemorySaver) and must stay serializable, so
heavy objects (networkx graphs, dataclasses) live in an in-process store keyed
by thread_id; state carries only serializable summaries. Hybrid Intelligence
holds: nodes do deterministic work; the LLM is touched only in report_node to
narrate already-computed, grounded numbers.
"""
from __future__ import annotations

import time
from typing import TypedDict

from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt, Command

from . import analytics, dag_transform, graph_build, ingest as ingest_mod
from .pipeline import RunResult, _viz_payload, finalize
from .scoring import compute_scores
from .security import scan_for_leaks

_STORE: dict = {}


def store(tid: str) -> dict:
    return _STORE.setdefault(tid, {})


class SentinelState(TypedDict, total=False):
    files: list
    recommend_top: int
    auto_approve: bool
    human_decision: str
    feedback: str
    audit: list
    status: str
    error: str
    scope_size: int
    heavy_hitters: list
    impact: dict
    hidden: dict
    headline: dict


def _tid(config) -> str:
    return (config or {}).get("configurable", {}).get("thread_id", "demo")


def _log(state, stage, t0, **extra):
    return state.get("audit", []) + [
        {"stage": stage, "ms": round((time.perf_counter() - t0) * 1000, 1), **extra}]


def supervisor(state, config):
    return {"status": "started",
            "audit": _log(state, "supervisor", time.perf_counter(), files=len(state.get("files", [])))}


def ingest_node(state, config):
    t = time.perf_counter()
    ing = ingest_mod.ingest_files(state["files"])
    store(_tid(config))["ing"] = ing
    return {"audit": _log(state, "ingest", t, **ing.quality)}


def validate_node(state, config):
    t = time.perf_counter()
    ing = store(_tid(config))["ing"]
    leak = scan_for_leaks(ing.edge_rows + ing.bam_rows + ing.survey_rows + ing.splunk_rows)
    if not leak.clean:
        return {"status": "aborted", "error": "masking-leak check FAILED",
                "audit": _log(state, "validate_masking_leak", t, clean=False)}
    return {"audit": _log(state, "validate_masking_leak", t, clean=True)}


def graph_node(state, config):
    t = time.perf_counter()
    s = store(_tid(config))
    art = graph_build.build_graph(s["ing"])
    s["art"] = art
    return {"audit": _log(state, "build_graph", t, **art.stats)}


def dag_node(state, config):
    t = time.perf_counter()
    s = store(_tid(config))
    H = analytics._flatten(s["art"].G)
    dagr = dag_transform.condense_to_dag(H)
    s["dagr"] = dagr
    return {"audit": _log(state, "condense_to_dag", t, **dagr.stats)}


def score_node(state, config):
    t = time.perf_counter()
    s = store(_tid(config))
    s["scores"] = compute_scores(s["art"].G)
    return {"audit": _log(state, "score", t, scored_nodes=len(s["scores"]))}


def analyze_node(state, config):
    t = time.perf_counter()
    s = store(_tid(config))
    art, scores = s["art"], s["scores"]
    H = analytics._flatten(art.G)
    scope = analytics.pci_scope(H, art.pan_sources)
    hh = analytics.heavy_hitters(art.G, art.pan_sources, scores, top_k=10)
    top = max(1, int(state.get("recommend_top", 3)))
    recommend = [h["system"] for h in hh[:top]]
    impact = analytics.clean_stream_impact(art.G, art.pan_sources, scores, recommend)
    hidden = analytics.hidden_scope(art.G)
    s["scope"] = scope
    return {"scope_size": len(scope), "heavy_hitters": hh, "impact": impact, "hidden": hidden,
            "audit": _log(state, "analytics", t, scope=len(scope),
                          recommend_top=top, hidden_pci=hidden["hidden_pci_count"])}


def human_gate(state, config):
    if state.get("auto_approve", True):
        return {"human_decision": "approve",
                "audit": _log(state, "human_gate", time.perf_counter(), decision="approve(auto)")}
    hh = state.get("heavy_hitters") or []
    top = max(1, int(state.get("recommend_top", 3)))
    # build a grounded preview so the reviewer can interrogate the analysis at the gate
    try:
        s = store(_tid(config))
        s["preview"] = finalize(s["ing"], s["art"], s["dagr"], s["scores"], s["scope"],
                                hh, state.get("impact", {}), state.get("hidden", {}),
                                state.get("audit", []))
    except Exception:
        pass
    decision = interrupt({
        "ask": "Review the analysis, then approve to report, revise the recommendation depth, or abort.",
        "scope_size": state.get("scope_size"),
        "hidden_pci": (state.get("hidden") or {}).get("hidden_pci_count"),
        "recommend_top": top,
        "recommended_interventions": [h["system"] for h in hh[:top]],
        "top_intervention": hh[0]["system"] if hh else None,
    })
    d = decision if isinstance(decision, dict) else {"decision": str(decision)}
    return {"human_decision": d.get("decision", "approve"), "feedback": d.get("feedback", ""),
            "audit": _log(state, "human_gate", time.perf_counter(), decision=d.get("decision"))}


def _route_gate(state):
    return {"approve": "report", "revise": "revise", "abort": "aborted"}.get(
        state.get("human_decision", "approve"), "report")


def revise_node(state, config):
    top = state.get("recommend_top", 3)
    for tok in str(state.get("feedback", "")).split():
        if tok.isdigit():
            top = int(tok)
    # keep auto_approve False so the gate pauses again with the revised recommendation
    return {"recommend_top": top, "auto_approve": False,
            "audit": _log(state, "revise", time.perf_counter(), new_recommend_top=top)}


def report_node(state, config):
    t = time.perf_counter()
    s = store(_tid(config))
    art, dagr, scores, scope = s["art"], s["dagr"], s["scores"], s["scope"]
    hh, impact, hidden = state["heavy_hitters"], state["impact"], state["hidden"]
    audit = _log(state, "report", t)
    result = finalize(s["ing"], art, dagr, scores, scope, hh, impact, hidden, audit)
    s["result"] = result
    return {"status": "complete", "headline": result.headline, "audit": audit}


def aborted_node(state, config):
    return {"status": "aborted",
            "audit": _log(state, "aborted", time.perf_counter(),
                          reason=state.get("error", "human abort"))}


def _route_after_validate(state):
    return "aborted" if state.get("status") == "aborted" else "graph"


def build_orchestrator():
    g = StateGraph(SentinelState)
    for name, fn in [("supervisor", supervisor), ("ingest", ingest_node),
                     ("validate", validate_node), ("graph", graph_node), ("dag", dag_node),
                     ("score", score_node), ("analyze", analyze_node), ("human_gate", human_gate),
                     ("revise", revise_node), ("report", report_node), ("aborted", aborted_node)]:
        g.add_node(name, fn)
    g.add_edge(START, "supervisor")
    g.add_edge("supervisor", "ingest")
    g.add_edge("ingest", "validate")
    g.add_conditional_edges("validate", _route_after_validate, {"graph": "graph", "aborted": "aborted"})
    g.add_edge("graph", "dag")
    g.add_edge("dag", "score")
    g.add_edge("score", "analyze")
    g.add_edge("analyze", "human_gate")
    g.add_conditional_edges("human_gate", _route_gate,
                            {"report": "report", "revise": "revise", "aborted": "aborted"})
    g.add_edge("revise", "analyze")
    g.add_edge("report", END)
    g.add_edge("aborted", END)
    return g.compile(checkpointer=MemorySaver())


# The compiled app (and its checkpointer) must persist across HTTP calls so an
# interrupted run can be resumed in a later request. One process-wide instance.
_APP = None


def get_app():
    global _APP
    if _APP is None:
        _APP = build_orchestrator()
    return _APP


def _shape(final, thread_id):
    """Translate a LangGraph return into a transport-friendly status object."""
    if "__interrupt__" in final:
        gate = final["__interrupt__"][0].value
        return {"status": "awaiting_approval", "thread_id": thread_id,
                "gate": gate, "audit": final.get("audit", [])}
    if final.get("status") == "aborted":
        return {"status": "aborted", "thread_id": thread_id,
                "error": final.get("error", "see audit"), "audit": final.get("audit", [])}
    return {"status": "complete", "thread_id": thread_id,
            "result": store(thread_id).get("result"),
            "headline": final.get("headline"), "audit": final.get("audit", [])}


def start_run(files, recommend_top: int = 3, auto_approve: bool = True, thread_id: str = "demo"):
    """Begin a run. With auto_approve=False the graph pauses at the human gate and
    returns status='awaiting_approval' with the gate payload + a thread_id to resume."""
    _STORE.pop(thread_id, None)
    app = get_app()
    cfg = {"configurable": {"thread_id": thread_id}}
    final = app.invoke({"files": files, "recommend_top": recommend_top,
                        "auto_approve": auto_approve, "audit": []}, cfg)
    return _shape(final, thread_id)


def resume_run(thread_id: str, decision: str, feedback: str = ""):
    """Resume a paused run with a human decision (approve / revise / abort)."""
    app = get_app()
    cfg = {"configurable": {"thread_id": thread_id}}
    final = app.invoke(Command(resume={"decision": decision, "feedback": feedback}), cfg)
    return _shape(final, thread_id)


def run_agentic(files, recommend_top: int = 3, auto_approve: bool = True, thread_id: str = "demo"):
    """Back-compatible unattended entry (used by tests and the snapshot generator)."""
    _STORE.pop(thread_id, None)
    app = get_app()
    cfg = {"configurable": {"thread_id": thread_id}}
    final = app.invoke({"files": files, "recommend_top": recommend_top,
                        "auto_approve": auto_approve, "audit": []}, cfg)
    if "__interrupt__" in final:                       # resume immediately when unattended
        final = app.invoke(Command(resume={"decision": "approve"}), cfg)
    final["result"] = store(thread_id).get("result")
    return final
