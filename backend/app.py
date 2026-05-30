"""FastAPI backend — upload-driven, agentic.

The frontend uploads the real CSV exports (any of DS1-DS6, in any order; the
server auto-identifies each). The LangGraph pipeline runs server-side and returns
the analysis + the exact JSON the React/D3 views consume. The most recent run is
cached in memory so the view endpoints can be polled cheaply.

Run:  uvicorn app:app --reload    (from backend/)
Docs: http://localhost:8000/docs
"""
from __future__ import annotations

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from pci_sentinel.orchestrator import run_agentic
from pci_sentinel.security import PanLeakError

app = FastAPI(title="PCI-SENTINEL", version="0.1.0",
              description="Explainable PCI data-flow mapping and scope-reduction engine.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_LAST = {"result": None}


@app.get("/health")
def health():
    return {"status": "ok", "has_run": _LAST["result"] is not None}


@app.post("/api/analyze")
async def analyze(files: list[UploadFile] = File(...), recommend_top: int = Query(3)):
    """Upload CSVs and run the full agentic analysis (auto-detects datasets)."""
    payload = []
    for f in files:
        raw = (await f.read()).decode("utf-8-sig", errors="replace")
        payload.append((f.filename, raw))
    if not payload:
        raise HTTPException(400, "No files uploaded.")
    try:
        st = run_agentic(payload, recommend_top=recommend_top, auto_approve=True)
    except PanLeakError as e:
        raise HTTPException(422, f"Run aborted by masking-leak safety check: {e}")
    if st.get("status") == "aborted":
        raise HTTPException(422, f"Run aborted: {st.get('error', 'see audit')}")
    r = st["result"]
    _LAST["result"] = r
    return {
        "headline": r.headline, "hidden": r.hidden, "quality": r.quality,
        "graph_stats": r.graph_stats, "dag_stats": r.dag_stats, "scope_size": r.scope_size,
        "heavy_hitters": r.heavy_hitters, "impact": r.impact, "cycles": r.cycles,
        "unresolved_signals_sample": r.unresolved_signals, "explanation": r.explanation,
        "audit": r.audit,
    }


def _need():
    if _LAST["result"] is None:
        raise HTTPException(409, "No analysis yet. POST CSVs to /api/analyze first.")
    return _LAST["result"]


@app.get("/api/graph")
def graph():
    """Node/edge graph for the D3 view (metadata vs inferred edges distinguished)."""
    return _need().viz


@app.get("/api/heavy-hitters")
def hh(top_k: int = 10):
    return {"heavy_hitters": _need().heavy_hitters[:top_k]}


@app.get("/api/impact")
def impact():
    return _need().impact


@app.get("/api/headline")
def headline():
    r = _need()
    return {"headline": r.headline, "hidden": r.hidden}


@app.get("/api/explanation")
def explanation():
    return {"explanation": _need().explanation}
