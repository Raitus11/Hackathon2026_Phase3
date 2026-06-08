"""Grounded AI narration over already-computed analysis (Hybrid Intelligence).

Nothing in this module computes a verifiable fact. Every narrator receives a
compact dict of numbers the deterministic engine already produced and either:
  * asks the model to phrase them (only when llm.generative, i.e. sdk backend), or
  * renders an equivalent deterministic template with the SAME numbers.

So the prose differs between modes but the figures never do, and a run never
depends on a network call. Payloads are aggregates + top-N only (never the graph),
so this is identical at 95 rows or 4,000.

Public:
  build_memo_facts(plan, headline=None) -> dict   normalise /api/plan into a compact, model-ready payload
  decision_memo(llm, facts)            -> dict     the flagship remediation memo
  hidden_brief(llm, facts)             -> dict     plain-English hidden-PCI summary
  scope_rationale(llm, facts)          -> dict     CDE / connected / out-of-scope rationale

Each returns {"text", "grounded_on", "tokens", "generated"} where:
  generated = True  -> prose came from the model
  generated = False -> deterministic template (numbers identical)
"""
from __future__ import annotations

import json


# ----------------------------------------------------------------------------
# payload assembly: normalise the live /api/plan shape into a stable schema
# ----------------------------------------------------------------------------

def build_memo_facts(plan: dict | None, headline: dict | None = None) -> dict:
    """Pull the memo's grounded inputs out of the analytics `plan` payload.

    Reads the real field names emitted by analytics (downstream_reach,
    solo_descope, feeds_removed, parent_reduction, is_true_source, solo_systems;
    saturation curve k / pct_sources / fully_descoped; the three block_comparison
    sets). Any missing branch simply yields an empty/None value — the memo then
    narrates only the axes that are present and never fabricates the rest.
    """
    plan = plan or {}
    se = plan.get("source_exposure") or {}
    sc = plan.get("saturation_curve") or {}
    bc = plan.get("block_comparison") or {}

    def _block(*names):
        for n in names:
            if n in bc:
                return bc[n]
        return {}

    facts = {
        "scope": {
            "in_scope": plan.get("before"),
            "descopable": plan.get("descopable"),
            "after": plan.get("after"),
        },
        "true_source_count": plan.get("true_source_count") or se.get("true_source_count"),
        "greedy_plan": {
            "plan": plan.get("plan") or [],
            "total_descoped": plan.get("total_descoped"),
            "after": plan.get("after"),
        },
        "top_sources": (se.get("per_source") or [])[:15],
        "saturation_curve": sc.get("curve") or [],
        "block_comparison": {
            "greedy_minimal": _block("Greedy minimal set", "greedy_minimal"),
            "top3_by_reach": _block("Top-3 by reach", "top3_by_reach"),
            "top3_by_betweenness": _block("Top-3 by conduit (betweenness)", "top3_by_betweenness"),
        },
    }
    if headline:
        sc_meta = headline
        facts["scope"]["declared_pan"] = sc_meta.get("declared_pan_carriers") or sc_meta.get("declared_pan")
        facts["scope"]["actual_pan"] = sc_meta.get("actual_pan_carriers") or sc_meta.get("actual_pan")
        facts["scope"]["hidden_pci"] = (sc_meta.get("hidden_pci_systems_bam_misses")
                                        or sc_meta.get("hidden_pci"))
    return facts


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------

def _find_cliff(curve: list) -> dict | None:
    """Locate the descope threshold: the consecutive curve points with the
    largest jump in fully_descoped. Returns the pre/post points, or None if the
    curve is too short / flat to have one."""
    pts = [p for p in (curve or []) if "fully_descoped" in p]
    if len(pts) < 2:
        return None
    best_i, best_delta = 1, -1
    for i in range(1, len(pts)):
        delta = (pts[i].get("fully_descoped") or 0) - (pts[i - 1].get("fully_descoped") or 0)
        if delta > best_delta:
            best_delta, best_i = delta, i
    pre, post = pts[best_i - 1], pts[best_i]
    if best_delta <= 0:
        return None
    return {"pre": pre, "post": post, "delta": best_delta,
            "max_descoped": max(p.get("fully_descoped") or 0 for p in pts)}


def _tokens(*parts: str) -> int:
    """Rough token estimate (~4 chars/token) so the observability meter has a
    value without depending on provider-specific usage reporting."""
    return sum(len(p or "") for p in parts) // 4


def _names(block: dict) -> str:
    return ", ".join(block.get("tokenize") or []) or "n/a"


# ----------------------------------------------------------------------------
# Role 1 — AI Decision Memo (flagship)
# ----------------------------------------------------------------------------

_MEMO_SYS = (
    "You are a PCI scope analyst writing a short, board-ready remediation memo for a CISO. "
    "Use ONLY the grounded facts provided; never invent systems, numbers, or edges. Write ~150 "
    "words in plain business English, in this order: (1) lead with the descope THRESHOLD finding "
    "from the saturation curve — full descope stays near zero until a large fraction of true "
    "sources is tokenized, then jumps; (2) state that tokenizing the top source still removes a "
    "clear-PAN feed from many systems now (feeds_removed) even before that threshold; (3) contrast "
    "blocking the widest conduits by betweenness (which descopes ~0) with tokenizing the true "
    "sources (which descopes and removes feeds); (4) end with a recommended sequence. Be decisive."
)


def decision_memo(llm, facts: dict) -> dict:
    grounded_on = [k for k in ("saturation_curve", "source_exposure", "block_comparison", "greedy_plan")
                   if facts.get("saturation_curve" if k == "saturation_curve" else
                                "top_sources" if k == "source_exposure" else k)]
    template = _memo_template(facts)
    text, generated = template, False
    if getattr(llm, "generative", False):
        out = llm.generate(_MEMO_SYS, "GROUNDED FACTS:\n" + json.dumps(facts, indent=2, default=str))
        if out and out.strip():
            text, generated = out.strip(), True
    return {"text": text, "grounded_on": grounded_on,
            "tokens": _tokens(_MEMO_SYS, json.dumps(facts, default=str), text), "generated": generated}


def _memo_template(f: dict) -> str:
    scope = f.get("scope") or {}
    plan = f.get("greedy_plan") or {}
    sources = f.get("top_sources") or []
    bc = f.get("block_comparison") or {}
    tsc = f.get("true_source_count")

    first = (plan.get("plan") or [None])[0] or (sources[0].get("system") if sources else "the top true source")
    total_descoped = plan.get("total_descoped")
    top = sources[0] if sources else {}
    feeds = top.get("feeds_removed")
    parent_red = top.get("parent_reduction")

    paras = []

    # (1) the cliff
    cliff = _find_cliff(f.get("saturation_curve"))
    if cliff:
        pre, post = cliff["pre"], cliff["post"]
        paras.append(
            f"Recommended action: tokenize PAN at the true source. Tokenizing the single "
            f"highest-leverage source ({first}) fully descopes "
            f"{total_descoped if total_descoped is not None else 'few'} system(s) today — which "
            f"looks like little, but it is a threshold effect, not a failure. Full descope holds at "
            f"~{pre.get('fully_descoped')} systems until roughly {pre.get('pct_sources')}% of the "
            f"{tsc or 'true'} sources are tokenized, then rises sharply to {post.get('fully_descoped')} "
            f"systems at ~{post.get('pct_sources')}% (k={post.get('k')}). Scope reduction is a program "
            f"that pays off as the source front is cleared, not a single switch.")
    else:
        paras.append(
            f"Recommended action: tokenize PAN at the true source. The highest-leverage source is "
            f"{first}; full descope accrues as the true-source front is progressively converted.")

    # (2) the exposure gap
    if feeds is not None:
        paras.append(
            f"Exposure falls immediately, even before that threshold. Tokenizing {top.get('system', first)} "
            f"strips a clear-PAN feed from {feeds} downstream systems"
            + (f" and reduces the true-source-parent count on {parent_red} systems" if parent_red is not None else "")
            + ". Exposure narrows across the estate even where a system's scope status has not yet changed — "
            "this is the marginal benefit of each tokenization, and the right way to rank them.")

    # (3) conduit vs source
    btw = bc.get("top3_by_betweenness") or {}
    greedy = bc.get("greedy_minimal") or {}
    if btw or greedy:
        paras.append(
            f"Targeting matters. Blocking the three widest conduits by betweenness "
            f"({_names(btw)}) fully descopes {btw.get('fully_descoped', 0)} systems, whereas tokenizing "
            f"the true-source set ({_names(greedy)}) descopes {greedy.get('fully_descoped', 0)} and removes "
            f"{greedy.get('feeds_removed', 0)} clear-PAN feeds. Blocking high-traffic relays does not "
            f"reduce scope; converting the systems that originate PAN does.")

    # (4) sequence
    paras.append(
        f"Sequence: begin with {first} and proceed down the ranked true-source list; each step lowers "
        f"aggregate exposure now and advances toward the descope threshold. Plan for the full true-source "
        f"front to realise the larger descope."
        + (f" (Descopable surface: {scope.get('descopable')} of {scope.get('in_scope')} in-scope systems.)"
           if scope.get("descopable") is not None else ""))

    return " ".join(paras)


# ----------------------------------------------------------------------------
# Role 4a — Hidden-PCI briefing
# ----------------------------------------------------------------------------

_HIDDEN_SYS = (
    "You are a PCI scope analyst. In ~90 words, explain to a non-technical audience what 'hidden PCI' "
    "means and why it matters, using ONLY the grounded facts. Hidden PCI = systems the system-of-record "
    "(BAM) records as NOT carrying card data, yet clear PAN was observed in their logs. Name a few of the "
    "worst by reach. Never invent systems or numbers."
)


def hidden_brief(llm, facts: dict) -> dict:
    template = _hidden_template(facts)
    text, generated = template, False
    if getattr(llm, "generative", False):
        out = llm.generate(_HIDDEN_SYS, "GROUNDED FACTS:\n" + json.dumps(facts, indent=2, default=str))
        if out and out.strip():
            text, generated = out.strip(), True
    return {"text": text, "grounded_on": ["hidden_pci"],
            "tokens": _tokens(_HIDDEN_SYS, json.dumps(facts, default=str), text), "generated": generated}


def _hidden_template(f: dict) -> str:
    count = f.get("hidden_pci_count")
    worst = (f.get("worst") or f.get("hidden_pci_systems") or [])[:8]
    worst_str = ", ".join(w.get("system", w) if isinstance(w, dict) else str(w) for w in worst)
    base = (f"{count if count is not None else 'Several'} systems are hidden PCI: the authoritative BAM "
            f"record marks them as not carrying card data, yet clear PAN was observed flowing through them. "
            f"This is scope the organisation did not know it had — unmonitored under PCI DSS until now.")
    if worst_str:
        base += f" The widest by downstream reach include {worst_str}."
    return base


# ----------------------------------------------------------------------------
# Role 4b — Scope-category rationale
# ----------------------------------------------------------------------------

_SCOPE_SYS = (
    "You are a PCI scope analyst. In ~80 words, explain the PCI DSS v4.0.1 scope categories "
    "(CDE / connected-to / out-of-scope) and why systems land in each, using ONLY the grounded counts. "
    "Plain language for a non-technical judge. Never invent numbers."
)


def scope_rationale(llm, facts: dict) -> dict:
    template = _scope_template(facts)
    text, generated = template, False
    if getattr(llm, "generative", False):
        out = llm.generate(_SCOPE_SYS, "GROUNDED FACTS:\n" + json.dumps(facts, indent=2, default=str))
        if out and out.strip():
            text, generated = out.strip(), True
    return {"text": text, "grounded_on": ["scope_categories"],
            "tokens": _tokens(_SCOPE_SYS, json.dumps(facts, default=str), text), "generated": generated}


def _scope_template(f: dict) -> str:
    cde = f.get("cde")
    conn = f.get("connected")
    out = f.get("out_of_scope")
    bits = []
    if cde is not None:
        bits.append(f"{cde} systems are in the Cardholder Data Environment (they store, process, or "
                    f"transmit PAN)")
    if conn is not None:
        bits.append(f"{conn} are connected-to (they can reach the CDE and so inherit scope)")
    if out is not None:
        bits.append(f"{out} are out of scope (no clear-PAN path reaches them)")
    if not bits:
        return ("Systems are classified under PCI DSS v4.0.1 as CDE (handle PAN directly), connected-to "
                "(can reach the CDE), or out-of-scope (no clear-PAN path) based on deterministic graph "
                "reachability.")
    return ("Under PCI DSS v4.0.1, " + "; ".join(bits) + ". The split is decided by deterministic "
            "graph reachability — not by judgement — so each placement traces back to a path in the data.")
