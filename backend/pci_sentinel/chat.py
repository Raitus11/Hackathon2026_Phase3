"""Grounded "ask the analyst" Q&A over a completed analysis.

Design (Hybrid Intelligence, enforced): the deterministic handlers answer the
common questions exactly from the computed graph/scores — no model in the loop,
so those answers cannot hallucinate. Anything unmatched falls back to the LLM,
but only with the computed facts as context and a strict instruction to answer
from them or say it cannot. Every answer reports what it was grounded on.
"""
from __future__ import annotations

import re

from .llm_client import LLMClient

_SUGGESTED = [
    "How many systems are in PCI scope, and how many are confirmed vs inferred?",
    "Which systems are the biggest PAN distributors?",
    "What happens if we tokenize PAN at 8CCF?",
    "Why is 6PNX in PCI scope?",
    "Which systems are hidden PCI (BAM misses)?",
]


def suggested_questions(result):
    """A few safe, answerable prompts seeded with real system IDs from the run."""
    qs = list(_SUGGESTED)
    hh = getattr(result, "heavy_hitters", []) or []
    if hh:
        qs[2] = f"What happens if we tokenize PAN at {hh[0]['system']}?"
    inf = (getattr(result, "scope_breakdown", {}) or {}).get("inferred_only_sample") or []
    if inf:
        qs[3] = f"Why is {inf[0]} in PCI scope?"
    return qs


def _index(result):
    nodes = {n["id"]: n for n in result.viz["nodes"]}
    providers, consumers = {}, {}
    for e in result.viz["edges"]:
        consumers.setdefault(e["source"], []).append(e)   # source provides PAN -> target consumes
        providers.setdefault(e["target"], []).append(e)
    return nodes, providers, consumers


def _find_ids(question, node_ids):
    toks = set(re.findall(r"[0-9A-Za-z]{2,8}", question.upper()))
    return [i for i in node_ids if i.upper() in toks]


def answer(result, question: str, history=None) -> dict:
    if result is None:
        return {"answer": "No analysis loaded yet — upload the CSV exports first.", "grounded_on": []}
    q = (question or "").strip()
    if not q:
        return {"answer": "Ask about PCI scope, heavy hitters, hidden PCI, or a specific system ID.",
                "grounded_on": []}
    ql = q.lower()
    nodes, providers, consumers = _index(result)
    ids = _find_ids(q, nodes.keys())
    hh = result.heavy_hitters or []
    head = result.headline or {}
    br = result.scope_breakdown or {}
    hidden = result.hidden or {}

    # --- deterministic intents ---------------------------------------------
    # 1) scope counts
    if any(k in ql for k in ["in scope", "scope size", "how many", "confirmed", "inferred"]) and not ids:
        return {"answer":
                f"{head.get('systems_exposed_to_clear_pan')} systems are in PCI scope. Of those, "
                f"{br.get('metadata_confirmed')} are confirmed by authoritative BAM metadata and "
                f"{br.get('inferred_only')} are inferred-only candidate scope surfaced from survey/Splunk "
                f"signals (kept separate, never treated as ground truth).",
                "grounded_on": ["headline", "scope_breakdown"]}

    # 2) heavy hitters
    if any(k in ql for k in ["heavy hitter", "biggest", "distributor", "top ", "most pan", "leverage"]) and not ids:
        top = hh[:5]
        lines = "; ".join(f"{h['system']} (exclusive reach {h['exclusive_reach']}, reaches "
                          f"{h['downstream_reach']})" for h in top)
        return {"answer": f"The primary PAN distributors, ranked by exclusive downstream reach, are: {lines}. "
                          f"Tokenizing at the top sources yields the largest clean-stream descope.",
                "grounded_on": [h["system"] for h in top]}

    # 3) hidden PCI
    if any(k in ql for k in ["hidden", "splunk", "bam miss", "didn't know", "leak"]) and not ids:
        sample = (hidden.get("hidden_pci_systems") or [])[:10]
        return {"answer": f"{hidden.get('hidden_pci_count')} systems are hidden PCI — BAM records them as "
                          f"PCI=No, yet clear PAN was observed in their Splunk logs. Examples: "
                          f"{', '.join(sample)}. These are scope the organisation did not know it had.",
                "grounded_on": sample}

    # 4) tokenize / what-if at a specific system
    if ids and any(k in ql for k in ["tokenize", "tokenise", "what if", "descope", "crn", "clean-stream", "clean stream"]):
        sid = ids[0]
        h = next((x for x in hh if x["system"] == sid), None)
        n = nodes.get(sid, {})
        if h:
            return {"answer": f"{sid} is a PAN distributor reaching {h['downstream_reach']} systems, "
                              f"{h['exclusive_reach']} of which depend on it exclusively. Tokenizing PAN at "
                              f"{sid} (so it emits CRN instead of clear PAN) descopes those "
                              f"{h['exclusive_reach']} exclusively-dependent system(s); shared-dependency "
                              f"systems only descope once every upstream sends CRN. Systems that must "
                              f"de-tokenize via centralized RISE/APG services remain in the CDE.",
                    "grounded_on": [sid]}
        return {"answer": f"{sid} reaches {n.get('reach', 0)} downstream system(s). It is not among the "
                          f"top exclusive-leverage sources, so tokenizing it alone descopes fewer systems "
                          f"than the recommended targets.",
                "grounded_on": [sid]}

    # 5) why in scope / explain a system
    if ids:
        sid = ids[0]
        n = nodes.get(sid, {})
        if not n.get("in_scope"):
            return {"answer": f"{sid} is not in PCI scope: no clear-PAN flow reaches it in the data-flow graph.",
                    "grounded_on": [sid]}
        prov = n.get("scope_prov")
        ins = providers.get(sid, [])
        prov_word = "confirmed by authoritative BAM metadata" if prov == "metadata" else \
                    "inferred-only — it appears in scope solely via survey/Splunk signals, not BAM metadata"
        signals = sorted({e.get("signal") for e in ins if e.get("provenance") == "inferred" and e.get("signal")})
        src_line = ""
        if ins:
            src_line = (" PAN reaches it from: "
                        + ", ".join(f"{e['source']}" + (f" [{e['signal']}]" if e.get('signal') else "")
                                    for e in ins[:6]) + ".")
        extra = f" Hidden PCI: BAM says PCI=No but PAN was seen in its Splunk logs." if n.get("hidden_pci") else ""
        return {"answer": f"{sid} is in PCI scope and that inclusion is {prov_word}."
                          f"{src_line}{extra} Risk score {n.get('risk')}, sensitivity tier {n.get('tier')}/4, "
                          f"reaches {n.get('reach')} downstream system(s).",
                "grounded_on": [sid] + [e["source"] for e in ins[:6]]}

    # --- LLM fallback (grounded, bounded) ----------------------------------
    facts = {
        "headline": head, "scope_breakdown": br,
        "hidden_pci_count": hidden.get("hidden_pci_count"),
        "heavy_hitters": [{k: h[k] for k in ("system", "exclusive_reach", "downstream_reach", "risk")}
                          for h in hh[:10]],
        "impact": result.impact,
    }
    llm = LLMClient()
    txt = llm.chat(q, facts, history or [])
    return {"answer": txt, "grounded_on": ["headline", "heavy_hitters", "impact"]}
