"""FastAPI backend — upload-driven, agentic, with human-in-the-loop + grounded chat.

Flow:
  POST /api/analyze (multipart CSVs, ?require_approval=bool)
        -> require_approval=false: runs end-to-end, returns the full analysis.
        -> require_approval=true : runs to the human gate and returns
           status='awaiting_approval' + thread_id + gate summary.
  POST /api/approve {thread_id, decision: approve|revise|abort, feedback?}
        -> resumes the paused run; 'revise' re-pauses with a new recommendation depth.
  GET  /api/agents            -> the agent roster the UI renders.
  POST /api/chat {question}   -> grounded Q&A over the latest completed analysis.
  GET  /api/graph|heavy-hitters|impact|headline|explanation -> views of the last run.
"""
from __future__ import annotations

import uuid

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pci_sentinel import agents as agents_mod
from pci_sentinel import chat as chat_mod
from pci_sentinel.orchestrator import start_run, resume_run, store as _store
from pci_sentinel.security import PanLeakError

app = FastAPI(title="PCI-SENTINEL", version="0.2.0",
              description="Explainable PCI data-flow mapping and scope-reduction engine.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_LAST = {"result": None}


def _full(r):
    return {
        "headline": r.headline, "hidden": r.hidden, "quality": r.quality,
        "graph_stats": r.graph_stats, "dag_stats": r.dag_stats, "scope_size": r.scope_size,
        "scope_breakdown": r.scope_breakdown, "heavy_hitters": r.heavy_hitters,
        "impact": r.impact, "cycles": r.cycles, "unresolved_signals_sample": r.unresolved_signals,
        "explanation": r.explanation, "audit": r.audit,
    }


@app.get("/health")
def health():
    return {"status": "ok", "has_run": _LAST["result"] is not None}


@app.get("/api/agents")
def agents():
    return {"agents": agents_mod.ROSTER, "order": agents_mod.ORDER}


async def _read(files):
    payload = []
    for f in files:
        raw = (await f.read()).decode("utf-8-sig", errors="replace")
        payload.append((f.filename, raw))
    if not payload:
        raise HTTPException(400, "No files uploaded.")
    return payload


def _handle(st):
    status = st.get("status")
    if status == "complete":
        _LAST["result"] = st["result"]
        return {"status": "complete", "thread_id": st["thread_id"], **_full(st["result"])}
    if status == "awaiting_approval":
        return {"status": "awaiting_approval", "thread_id": st["thread_id"],
                "gate": st["gate"], "audit": st.get("audit", [])}
    raise HTTPException(422, f"Run aborted: {st.get('error', 'see audit')}")


@app.post("/api/analyze")
async def analyze(files: list[UploadFile] = File(...), recommend_top: int = Query(3),
                  require_approval: bool = Query(False)):
    payload = await _read(files)
    tid = uuid.uuid4().hex[:12]
    try:
        st = start_run(payload, recommend_top=recommend_top,
                       auto_approve=not require_approval, thread_id=tid)
    except PanLeakError as e:
        raise HTTPException(422, f"Run aborted by masking-leak safety check: {e}")
    return _handle(st)


class Approval(BaseModel):
    thread_id: str
    decision: str = "approve"          # approve | revise | abort
    feedback: str = ""                 # e.g. "5" to set recommend_top during revise


@app.post("/api/approve")
def approve(body: Approval):
    st = resume_run(body.thread_id, body.decision, body.feedback)
    return _handle(st)


def _need():
    if _LAST["result"] is None:
        raise HTTPException(409, "No analysis yet. POST CSVs to /api/analyze first.")
    return _LAST["result"]


@app.get("/api/graph")
def graph():
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
    return {"headline": r.headline, "hidden": r.hidden, "scope_breakdown": r.scope_breakdown}


@app.get("/api/explanation")
def explanation():
    return {"explanation": _need().explanation}


def _chat_target(thread_id):
    """Resolve what the analyst chats against: a thread's result/preview, else the last run."""
    if thread_id:
        s = _store(thread_id)
        r = s.get("result") or s.get("preview")
        if r is not None:
            return r
    return _need()


@app.get("/api/suggested")
def suggested(thread_id: str = ""):
    return {"questions": chat_mod.suggested_questions(_chat_target(thread_id or None))}


class ChatBody(BaseModel):
    question: str
    history: list = []
    thread_id: str = ""


@app.post("/api/chat")
def chat(body: ChatBody):
    return chat_mod.answer(_chat_target(body.thread_id or None), body.question, body.history)
