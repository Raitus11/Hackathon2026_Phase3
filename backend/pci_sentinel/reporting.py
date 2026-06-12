"""Downloadable deliverables — executive PDF report and XLSX data pack.

Both are generated from the already-computed, grounded RunResult plus the graph
artifacts; nothing here re-derives analysis, so a report can never disagree with
the dashboard. The PDF is the non-technical decision-support artifact (Documentation
+ Communication scoring); the XLSX is the technical data trail (evidence bundle).
"""
from __future__ import annotations

import io
import re
from datetime import datetime, timezone

# headless rendering for the embedded graph
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx

from . import analytics
from . import report_charts

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                Image as RLImage, HRFlowable)

INK = colors.HexColor("#1F2329")
PAN = colors.HexColor("#C77800")
SAFE = colors.HexColor("#0E7C4A")
HOT = colors.HexColor("#D71E28")
COOL = colors.HexColor("#2563EB")
DIM = colors.HexColor("#5A6472")
LINE = colors.HexColor("#DDD8CE")


def _ts():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _rl(buf, w_mm, h_mm):
    """Wrap a PNG BytesIO as a reportlab Image at the given mm box (preserve ratio)."""
    return RLImage(buf, width=w_mm * mm, height=h_mm * mm, kind="proportional")


def _two_col(left_buf, right_buf, w_mm=83, h_mm=64):
    """Two charts side by side in a borderless table."""
    cells = [[_rl(left_buf, w_mm, h_mm) if left_buf else "",
              _rl(right_buf, w_mm, h_mm) if right_buf else ""]]
    t = Table(cells, colWidths=[(w_mm + 3) * mm, (w_mm + 3) * mm])
    t.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"),
                           ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("LEFTPADDING", (0, 0), (-1, -1), 0),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    return t


def _caption(text, style):
    return Paragraph(text, style)


# ---------------------------------------------------------------------------
# Markdown -> ReportLab flowables.
# The grounded narration (executive summary, decision memo) can come back from
# the model as light Markdown (## headings, **bold**, * bullets). ReportLab's
# Paragraph only understands a small set of inline HTML tags, so feeding raw
# Markdown to it prints the literal markers. This converts the common Markdown
# the narrators emit into proper flowables. Deterministic-template prose carries
# no Markdown, so it passes through unchanged (paragraph-split only).
# ---------------------------------------------------------------------------

_MD_H = re.compile(r"^\s*#{1,6}\s+(.*)$")
_MD_BULLET = re.compile(r"^\s*[\*\-+]\s+(.*)$")
_MD_NUM = re.compile(r"^\s*\d+[.)]\s+(.*)$")


def _md_inline(s: str) -> str:
    """Escape for ReportLab, then re-apply bold/italic from Markdown markers."""
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)        # **bold**
    s = re.sub(r"__(.+?)__", r"<b>\1</b>", s)            # __bold__
    s = re.sub(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)", r"<i>\1</i>", s)  # *italic*
    s = re.sub(r"`([^`]+)`", r"\1", s)                   # strip inline code ticks
    return s.strip()


def _md_split_lines(text: str):
    """Recover line structure even if newlines were flattened into spaces:
    break before heading markers and before bullets that follow sentence
    punctuation, so a single run still decomposes into headings/bullets/prose."""
    t = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"\s+(#{1,6}\s)", r"\n\1", t)                 # break before headings
    t = re.sub(r"([.:;)])\s+([\*\-+]\s)", r"\1\n\2", t)      # break before bullets after punctuation
    return t.split("\n")


def _md_flowables(text, body_style):
    """Convert light Markdown into a list of reportlab Paragraph flowables."""
    head = ParagraphStyle("md_head", parent=body_style, fontName="Helvetica-Bold",
                          fontSize=body_style.fontSize + 1, textColor=INK,
                          spaceBefore=6, spaceAfter=2)
    bullet = ParagraphStyle("md_bullet", parent=body_style, leftIndent=12,
                            bulletIndent=2, spaceAfter=1)
    out, para = [], []

    def flush():
        if para:
            out.append(Paragraph(" ".join(para), body_style))
            para.clear()

    for raw in _md_split_lines(text):
        line = raw.strip()
        if not line:
            flush()
            continue
        m = _MD_H.match(line)
        if m:
            flush()
            out.append(Paragraph(_md_inline(m.group(1)), head))
            continue
        m = _MD_BULLET.match(line) or _MD_NUM.match(line)
        if m:
            flush()
            out.append(Paragraph("&bull;&nbsp;" + _md_inline(m.group(1)), bullet))
            continue
        para.append(_md_inline(line))
    flush()
    return out or [Paragraph(_md_inline(text or ""), body_style)]


def _pdf_table(rows, widths):
    """A consistently-styled reportlab table (mono first column in PAN, zebra rows)."""
    t = Table(rows, colWidths=widths)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F6F1E7")),
        ("TEXTCOLOR", (0, 0), (-1, 0), DIM), ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("FONTNAME", (0, 1), (0, -1), "Courier-Bold"), ("TEXTCOLOR", (0, 1), (0, -1), PAN),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAF8F4")]),
        ("GRID", (0, 0), (-1, -1), 0.3, LINE), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    return t


# ----------------------------------------------------------------------------- graph image
def _graph_png(art, scores, viz, max_nodes=70) -> io.BytesIO:
    """Render the PAN-flow neighbourhood: heavy hitters + their downstream, coloured by
    role (true source / hidden-PCI / in-scope). Deterministic layout (fixed seed)."""
    H = nx.DiGraph()
    nodes = viz.get("nodes", [])
    rank = {n["id"]: n for n in nodes}
    pan_nodes = [n for n in nodes if n.get("carries_pan") or n.get("hidden_pci")]
    pan_nodes = sorted(pan_nodes, key=lambda n: -(n.get("downstream_reach") or 0))[:max_nodes]
    keep = {n["id"] for n in pan_nodes}
    for n in pan_nodes:
        H.add_node(n["id"])
    for e in viz.get("edges", []):
        if e["source"] in keep and e["target"] in keep:
            H.add_edge(e["source"], e["target"])

    fig, ax = plt.subplots(figsize=(7.4, 4.6), dpi=150)
    fig.patch.set_facecolor("white")
    if H.number_of_nodes() == 0:
        ax.text(0.5, 0.5, "no PAN-flow edges in sample", ha="center", color="#888")
        ax.axis("off"); buf = io.BytesIO(); fig.savefig(buf, format="png", bbox_inches="tight"); plt.close(fig); buf.seek(0); return buf
    pos = nx.spring_layout(H, seed=7, k=0.9, iterations=60)

    def color(nid):
        m = rank.get(nid, {})
        if m.get("hidden_pci"): return "#8F0E1E"
        if m.get("is_true_source"): return "#D71E28"
        if m.get("carries_pan"): return "#E8A33D"
        return "#2563EB"
    sizes = [120 + 26 * (rank.get(n, {}).get("downstream_reach") or 0) for n in H.nodes()]
    nx.draw_networkx_edges(H, pos, ax=ax, edge_color="#9AA4B2", arrows=True,
                           arrowsize=7, width=0.7, alpha=0.7)
    nx.draw_networkx_nodes(H, pos, ax=ax, node_color=[color(n) for n in H.nodes()],
                           node_size=sizes, linewidths=0.4, edgecolors="white")
    big = sorted(H.nodes(), key=lambda n: -(rank.get(n, {}).get("downstream_reach") or 0))[:14]
    nx.draw_networkx_labels(H, pos, labels={n: n for n in big}, ax=ax, font_size=6,
                            font_color="#1F2329")
    ax.axis("off")
    ax.set_title("PAN data-flow — heavy hitters and downstream (arrow = provider → consumer)",
                 fontsize=8, color="#1F2329")
    buf = io.BytesIO(); fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white")
    plt.close(fig); buf.seek(0); return buf


# ----------------------------------------------------------------------------- PDF
def build_pdf(result, art, scores, plan: dict) -> bytes:
    # The enriched plan (optimization frontier, source_exposure, block_comparison,
    # saturation_curve) is attached to result.plan in finalize(); callers may pass only
    # the raw minimal_tokenization_plan. Merge so the report always has the rich fields,
    # with the caller's plan taking precedence on shared core keys.
    plan = {**(getattr(result, "plan", {}) or {}), **(plan or {})}
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=16 * mm, bottomMargin=14 * mm,
                            leftMargin=16 * mm, rightMargin=16 * mm,
                            title="PCI-SENTINEL Executive Report")
    ss = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=ss["Title"], fontSize=20, textColor=INK, spaceAfter=2, alignment=TA_LEFT)
    sub = ParagraphStyle("sub", parent=ss["Normal"], fontSize=9, textColor=DIM, spaceAfter=10)
    h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontSize=12.5, textColor=INK, spaceBefore=12, spaceAfter=4)
    body = ParagraphStyle("body", parent=ss["Normal"], fontSize=9.5, textColor=colors.HexColor("#22303f"), leading=14)
    small = ParagraphStyle("small", parent=ss["Normal"], fontSize=8, textColor=DIM, leading=11)
    E = []

    head = result.headline
    br = result.scope_breakdown
    imp = result.impact
    hidden = result.hidden

    E.append(Paragraph("PCI-SENTINEL — Executive Report", h1))
    E.append(Paragraph(f"Cardholder-data flow, scope &amp; tokenization-leverage analysis · generated {_ts()}", sub))
    E.append(HRFlowable(width="100%", thickness=0.6, color=LINE, spaceAfter=10))

    # KPI strip
    kpis = [["Systems exposed to clear PAN", "Hidden PCI (BAM misses)", "Cycle clusters resolved", "Top intervention"],
            [str(head.get("systems_exposed_to_clear_pan")), str(hidden.get("hidden_pci_count")),
             str(result.dag_stats.get("cycle_clusters", "—")),
             (plan.get("plan") or ["—"])[0]]]
    t = Table(kpis, colWidths=[42 * mm] * 4)
    t.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, 0), 7.5), ("TEXTCOLOR", (0, 0), (-1, 0), DIM),
        ("FONTSIZE", (0, 1), (-1, 1), 19), ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
        ("TEXTCOLOR", (0, 1), (0, 1), PAN), ("TEXTCOLOR", (1, 1), (1, 1), HOT),
        ("TEXTCOLOR", (2, 1), (2, 1), COOL), ("TEXTCOLOR", (3, 1), (3, 1), SAFE),
        ("TOPPADDING", (0, 1), (-1, 1), 4), ("BOTTOMPADDING", (0, 1), (-1, 1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 3),
        ("LINEBELOW", (0, 0), (-1, 0), 0, colors.white)]))
    E.append(t)
    E.append(Spacer(1, 4))
    E.append(Paragraph(f"Of {head.get('systems_exposed_to_clear_pan')} systems in scope, "
                       f"<b>{br.get('metadata_confirmed')}</b> are confirmed by authoritative BAM metadata and "
                       f"<b>{br.get('inferred_only')}</b> are inferred-only candidate scope from survey/Splunk "
                       f"signals (kept separate, never treated as ground truth).", small))

    # ---------------------------------------------------------------- visual decision dashboard
    # Business-analyst figures: every chart answers one question and labels the number AND %.
    E.append(Paragraph("Decision dashboard", h2))
    try:
        c_comp = report_charts.chart_scope_composition(result)
        if c_comp:
            E.append(_rl(c_comp, 170, 58))
            E.append(_caption("Where the in-scope number comes from, and how each system is classified "
                              "under PCI DSS v4.0.1 (CDE / connected-to / out).", small))
    except Exception:
        pass
    try:
        c_red = report_charts.chart_scope_reduction(result)
        c_eco = report_charts.chart_economics(result)
        if c_red or c_eco:
            E.append(Spacer(1, 4))
            E.append(_two_col(c_red, c_eco, w_mm=82, h_mm=62))
            E.append(_caption("Left: systems removable from PCI scope if the full true-source front is "
                              "tokenized. Right: the assessor-day and cost effect at current assumptions "
                              "(all figures labelled estimates).", small))
    except Exception:
        pass
    try:
        c_hid = report_charts.chart_hidden_scope(result)
        if c_hid:
            E.append(Spacer(1, 4))
            E.append(_rl(c_hid, 170, 70))
            E.append(_caption("Systems BAM records as PCI=No but Splunk shows carrying clear PAN, ranked by "
                              "how far that leaked PAN can propagate — the scope the catalogue misses.", small))
    except Exception:
        pass

    # audit-scope economics — the business headline (in scope -> floor -> cost)
    econ = getattr(result, "economics", {}) or {}
    if econ.get("in_scope_now"):
        ass = econ.get("assumptions", {})
        posture_txt = (f", and shifts the assessment posture {econ['posture_now']} → {econ['posture_floor']}"
                       if econ.get("posture_now") != econ.get("posture_floor") else "")
        E.append(Paragraph("Audit-scope economics", h2))
        E.append(Paragraph(
            f"PCI audit surface today: <b>{econ['in_scope_now']}</b> in-scope (CDE) systems — assessment "
            f"posture <b>{econ['posture_now']}</b>. The data-permitted floor, if the entire true-PAN-source "
            f"front is tokenized, is <b>{econ['achievable_floor']}</b> systems "
            f"(<b>{econ['removable']}</b> removable), moving effort from "
            f"<b>{econ['effort_now']['qsa_days']}</b> to <b>{econ['effort_floor']['qsa_days']}</b> "
            f"assessor-days (~{econ['cost_saving']:,} estimated saving{posture_txt}). "
            f"Figures are labeled estimates: {ass.get('qsa_day_rate', 0):,.0f}/assessor-day, "
            f"{ass.get('days_per_cde_system')} day per CDE system, {ass.get('days_per_connected')} day per "
            f"connected-to system, ROC above {ass.get('roc_threshold', 0):,} in-scope. Floor = current scope "
            f"minus the maximum fully-descoped count on the saturation curve.", body))

    E.append(Paragraph("Executive summary", h2))
    E.extend(_md_flowables(result.explanation or "", body))

    # AI Decision Memo — grounded remediation memo (built once in finalize(); on the
    # sdk backend this is live model prose, otherwise the deterministic template with
    # identical numbers). Rendered only if present so the section never appears empty.
    _memo = (getattr(result, "decision_memo", {}) or {})
    if _memo.get("text"):
        _tag = "AI-generated" if _memo.get("generated") else "deterministic narration"
        E.append(Paragraph(f"AI decision memo — recommended sequence ({_tag})", h2))
        E.extend(_md_flowables(_memo["text"], body))

    # tokenization leverage
    E.append(Paragraph("Where tokenization has the greatest leverage", h2))

    # CERTIFIED-OPTIMAL frontier (centrepiece): exact solver, not greedy.
    opt = plan.get("optimization") or {}
    fr = opt.get("frontier") or []
    if fr:
        try:
            c_fr = report_charts.chart_optimal_vs_greedy(opt)
            if c_fr:
                E.append(_rl(c_fr, 170, 80))
        except Exception:
            pass
        ms = opt.get("milestones_min_sources", {})
        best = max(fr, key=lambda r: r.get("gap", 0))
        E.append(Paragraph(
            f"We do not settle for a greedy heuristic here. Because a system descopes only when EVERY true "
            f"PAN source reaching it emits CRN (a conjunctive condition), the freed-systems objective is "
            f"<b>supermodular</b> — the (1−1/e) greedy guarantee does not hold. Instead the minimum-intervention "
            f"problem is solved to <b>certified optimality</b> as a 0/1 integer program "
            f"(<i>{opt.get('method', 'exact')}</i>): maximize systems fully descoped subject to a budget of k "
            f"tokenized sources. The curve above is the provably-best scope reduction at every budget. "
            f"At k={best.get('k')}, the optimal plan frees <b>{best.get('optimal_descoped')}</b> systems versus "
            f"greedy's <b>{best.get('greedy_descoped')}</b> — a <b>{best.get('gap')}-system</b> gap greedy never "
            f"finds, because that win only materializes once a whole set of sources is tokenized together. "
            f"Minimum sources to free 50% of descopable systems: <b>{ms.get('50pct', '—')}</b>; to free 100%: "
            f"<b>{ms.get('100pct', '—')}</b>.", body))
        rows = [["Budget k", "Optimal descoped", "Greedy descoped", "Gap", "% of descopable"]]
        for r in fr[1:]:
            rows.append([str(r["k"]), str(r["optimal_descoped"]), str(r["greedy_descoped"]),
                         (f"+{r['gap']}" if r["gap"] else "0"), f"{r['pct_of_descopable']}%"])
        E.append(_pdf_table(rows, [22 * mm, 38 * mm, 38 * mm, 18 * mm, 34 * mm]))
        E.append(_caption("Optimal = provably-best source set at that budget (exact solver, verified against "
                          "the engine's clean-stream recomputation). Greedy = incremental max-marginal pick. "
                          "Where the gap is large, a greedy roadmap would under-deliver at that budget.", small))
        E.append(Spacer(1, 6))

    E.append(Paragraph(
        f"As an interpretable baseline, a greedy max-marginal optimizer over the true PAN sources "
        f"tokenizes <b>{plan.get('k')}</b> source system(s) to fully descope "
        f"<b>{plan.get('total_descoped')}</b> of {plan.get('descopable')} descopable systems "
        f"({plan.get('before')} → {plan.get('after')} in PCI scope). A system goes fully safe only when every "
        f"true PAN source reaching it emits CRN — the conjunctive condition that makes full descope ramp only "
        f"once most of the source front is tokenized (the curve below). Greedy is reported transparently as a "
        f"heuristic; the certified optimum above is the defensible target.", body))
    # Cumulative descope curve (always populated, even when single-source full descope is 0).
    # Falls back to greedy steps if the curve is unavailable.
    curve = plan.get("cumulative_curve") or []
    if curve:
        rows = [["k", "Tokenize source", "Marginal descoped", "Cumulative descoped",
                 "Cumulative feeds removed"]]
        for c in curve[:12]:
            rows.append([str(c["k"]), c["last_source"], f"+{c['marginal_descoped']}",
                         str(c["cumulative_descoped"]), str(c["cumulative_feeds_removed"])])
        pt = Table(rows, colWidths=[8 * mm, 34 * mm, 30 * mm, 30 * mm, 34 * mm])
    else:
        rows = [["#", "Tokenize source", "Marginal descoped", "Cumulative", "Scope after", "% of descopable"]]
        for s in plan.get("steps", []):
            rows.append([str(s["step"]), s["tokenize"], f"+{s['marginal_descoped']}",
                         str(s["cumulative_descoped"]), str(s["scope_after"]), f"{s['pct_of_descopable']}%"])
        pt = Table(rows, colWidths=[8 * mm, 34 * mm, 30 * mm, 24 * mm, 24 * mm, 28 * mm])
    pt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F6F1E7")),
        ("TEXTCOLOR", (0, 0), (-1, 0), DIM), ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("FONTNAME", (1, 1), (1, -1), "Courier-Bold"), ("TEXTCOLOR", (1, 1), (1, -1), PAN),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAF8F4")]),
        ("GRID", (0, 0), (-1, -1), 0.3, LINE), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    E.append(pt)

    # clean-stream
    E.append(Paragraph("Clean-stream impact (recommended top-3 sources)", h2))
    E.append(Paragraph(
        f"Tokenizing the recommended source(s) fully descopes <b>{imp.get('nodes_descoped')}</b> systems "
        f"({imp.get('node_surface_reduction_pct')}% of the in-scope surface) and lowers aggregate exposure "
        f"risk by {imp.get('risk_reduction_pct')}%. Even where a system is not fully freed, the benefit is "
        f"non-zero: <b>{imp.get('feeds_removed', 0)}</b> system(s) lose a clear-PAN feed and "
        f"<b>{imp.get('parent_reduction', 0)}</b> have their true-source-parent count reduced (exposure "
        f"narrowed). {imp.get('retained_via_detokenization_count', 0)} system(s) "
        f"genuinely need PAN and remain in the CDE, de-tokenizing via centralized RISE/APG services.", body))

    # per-source 'block this parent -> who benefits' scatter
    try:
        c_se = report_charts.chart_source_exposure(plan)
        if c_se:
            E.append(Spacer(1, 4))
            E.append(_rl(c_se, 170, 76))
            E.append(_caption("Each bubble is one true PAN source. Right = feeds more systems; higher = riskier; "
                              "bigger bubble = more systems that lose a clear-PAN feed if it is tokenized. Green "
                              "sources free at least one system on their own; amber narrow exposure only.", small))
    except Exception:
        pass

    # PCI scope categories + requirement families (v4.0.1)
    cats = getattr(result, "categories", {}) or {}
    if cats.get("counts"):
        c = cats["counts"]
        E.append(Paragraph("PCI scope categories (v4.0.1)", h2))
        E.append(Paragraph(
            f"Under the three official PCI SSC categories: <b>{c.get('cde', 0)}</b> in scope (CDE — handle "
            f"cardholder data), <b>{c.get('connected', 0)}</b> connected-to (can affect a CDE system, also in "
            f"scope), and <b>{c.get('out', 0)}</b> out of scope. Tokenizing a true source moves systems "
            f"CDE → connected-to → out. The v4.0.1 requirement families triggered across in-scope systems:", body))
        labels, fc = cats.get("family_labels", {}), cats.get("family_counts", {})
        if fc:
            frows = [["Requirement family", "Systems triggering"]]
            for k, v in sorted(fc.items(), key=lambda kv: -kv[1]):
                frows.append([labels.get(k, k), str(v)])
            E.append(_pdf_table(frows, [128 * mm, 34 * mm]))

    # embedded graph
    try:
        img = _graph_png(art, scores, result.viz)
        E.append(Spacer(1, 4)); E.append(RLImage(img, width=170 * mm, height=106 * mm))
    except Exception:
        pass

    # heavy hitters
    E.append(Paragraph("Primary PAN distributors (heavy hitters)", h2))
    hh_rows = [["System", "Downstream reach", "Solo descope", "Out-degree", "Risk"]]
    for h in result.heavy_hitters[:10]:
        solo = h.get("solo_descope", h.get("exclusive_reach", 0))
        hh_rows.append([h["system"], str(h["downstream_reach"]), str(solo),
                        str(h.get("out_degree", "—")), str(h["risk"])])
    ht = Table(hh_rows, colWidths=[34 * mm, 32 * mm, 30 * mm, 26 * mm, 26 * mm])
    ht.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F6F1E7")), ("TEXTCOLOR", (0, 0), (-1, 0), DIM),
        ("FONTSIZE", (0, 0), (-1, -1), 8), ("FONTNAME", (0, 1), (0, -1), "Courier-Bold"),
        ("TEXTCOLOR", (0, 1), (0, -1), PAN),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAF8F4")]),
        ("GRID", (0, 0), (-1, -1), 0.3, LINE), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    E.append(ht)
    E.append(Paragraph("Ranked by downstream reach (distribution blast radius). Solo descope = systems freed if only that source "
                       "is tokenized; it is small everywhere because downstream systems are fed by several PAN sources, which is "
                       "why the minimum-intervention set (above) matters more than any single source.", small))

    # segmentation choke points (alternative lever)
    seg = (getattr(result, "structure", {}) or {}).get("segmentation_candidates") or []
    if seg:
        E.append(Paragraph("Segmentation choke points (alternative lever)", h2))
        E.append(Paragraph(
            "Articulation points of the in-scope PAN subgraph: network-isolating the PAN feed at one of these "
            "removes its whole downstream branch from CDE scope — the other canonical scope-reduction lever "
            "besides tokenization.", body))
        srows = [["System", "Branch isolated", "Downstream reach", "Role"]]
        for s in seg[:10]:
            srows.append([s["system"], str(s["branch_size"]), str(s.get("downstream_reach", 0)),
                          "true source" if s.get("is_true_source") else "relay"])
        E.append(_pdf_table(srows, [34 * mm, 36 * mm, 36 * mm, 30 * mm]))

    # hidden PCI
    E.append(Paragraph("Hidden PCI — clear PAN in non-PCI-flagged systems", h2))
    prop = hidden.get("hidden_propagating_count", 0)
    hidden_ids = hidden.get("hidden_pci_systems", [])[:40]
    E.append(Paragraph(
        f"{hidden.get('hidden_pci_count')} system(s) are flagged PCI=No in BAM, yet clear PAN was observed in "
        f"their Splunk logs — scope the authoritative metadata misses, of which {prop} actively propagate that "
        f"PAN further downstream. " +
        (", ".join(hidden_ids) if hidden_ids else "none in sample") + ".", body))

    # methodology + honesty
    E.append(Paragraph("Method &amp; honest scope", h2))
    E.append(Paragraph(
        "Risk R(v)∈[0,100] = 0.40·sensitivity-tier + 0.30·reachability (transitive closure, scaled to the "
        "widest distributor) + 0.20·betweenness centrality (Brandes 2001, scaled to the most-central system) "
        "+ 0.10·true-source flag. Cycles in the BAM/ServiceNow "
        "relationships are resolved by Tarjan strongly-connected-component detection then condensation, yielding "
        "a provable DAG. Inferred edges (Splunk/survey) carry their source and are never merged with metadata "
        "edges. <b>What this does not do:</b> it does not remediate controls, assert business need, or execute "
        "tokenization — it maps current-state lineage and shows where intervention has the greatest lift. Card "
        "numbers are masked first-6/last-4 on ingest; an unmasked PAN fails the run.", small))
    E.append(Spacer(1, 6))
    E.append(HRFlowable(width="100%", thickness=0.5, color=LINE, spaceAfter=4))
    E.append(Paragraph("PCI-SENTINEL · deterministic engine + grounded narration · figures reproducible from the "
                       "source CSVs." + (
                           f" Grounded narration: ~{(getattr(result, 'decision_memo', {}) or {}).get('tokens', 0):,} tokens."
                           if (getattr(result, 'decision_memo', {}) or {}).get('tokens') else ""), small))

    doc.build(E)
    buf.seek(0)
    return buf.read()


# ----------------------------------------------------------------------------- XLSX
def build_xlsx(result, art, scores, plan: dict) -> bytes:
    plan = {**(getattr(result, "plan", {}) or {}), **(plan or {})}
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    wb = Workbook()
    hdr_fill = PatternFill("solid", fgColor="0F1622")
    hdr_font = Font(color="FFFFFF", bold=True, size=10)

    def sheet(ws, headers, rows, widths=None):
        ws.append(headers)
        for c in ws[1]:
            c.fill = hdr_fill; c.font = hdr_font; c.alignment = Alignment(horizontal="left")
        for r in rows:
            ws.append(r)
        for i, w in enumerate(widths or [], 1):
            ws.column_dimensions[chr(64 + i)].width = w
        ws.freeze_panes = "A2"

    # Summary
    ws = wb.active; ws.title = "Summary"
    head, br, imp, hidden = result.headline, result.scope_breakdown, result.impact, result.hidden
    sheet(ws, ["Metric", "Value"], [
        ["Generated (UTC)", _ts()],
        ["Systems exposed to clear PAN", head.get("systems_exposed_to_clear_pan")],
        ["  metadata-confirmed", br.get("metadata_confirmed")],
        ["  inferred-only", br.get("inferred_only")],
        ["Hidden PCI (BAM misses)", hidden.get("hidden_pci_count")],
        ["Cycle clusters resolved", result.dag_stats.get("cycle_clusters")],
        ["Optimizer: sources to tokenize", plan.get("k")],
        ["Optimizer: systems descoped", plan.get("total_descoped")],
        ["Scope before → after", f"{plan.get('before')} → {plan.get('after')}"],
        ["Clean-stream surface reduction %", imp.get("node_surface_reduction_pct")],
        ["Clean-stream risk reduction %", imp.get("risk_reduction_pct")],
    ], [38, 26])

    # Systems
    cat_node = (getattr(result, "categories", {}) or {}).get("per_node", {})
    rows = []
    for n in result.viz.get("nodes", []):
        # NOTE: read the keys _viz_payload actually emits (tier/reach/scope_prov/true_source),
        # not the analytics-internal names — that mismatch is what left these columns blank.
        cat = n.get("category") or cat_node.get(n["id"], {}).get("category") or ""
        cat_label = {"cde": "CDE (in scope)", "connected": "connected-to", "out": "out of scope"}.get(cat, cat)
        reqs = n.get("triggered_requirements") or cat_node.get(n["id"], {}).get("families", [])
        rows.append([n["id"], n.get("risk"), n.get("tier"), n.get("reach"),
                     "yes" if n.get("carries_pan") else "no", "yes" if n.get("in_scope") else "no",
                     (n.get("scope_prov") or ("out of scope" if not n.get("in_scope") else "")),
                     cat_label, ", ".join(reqs),
                     "yes" if n.get("hidden_pci") else "no",
                     "yes" if n.get("true_source") else "no"])
    rows.sort(key=lambda r: -(r[1] or 0))
    sheet(wb.create_sheet("Systems"),
          ["System", "Risk", "Sensitivity tier", "Downstream reach", "Carries PAN", "In scope",
           "Scope basis", "PCI category", "Triggered requirements", "Hidden PCI", "True source"], rows,
          [12, 8, 14, 16, 12, 10, 18, 16, 30, 11, 12])

    # Heavy hitters
    sheet(wb.create_sheet("HeavyHitters"),
          ["System", "Downstream reach", "Solo descope", "Out-degree", "Risk"],
          [[h["system"], h["downstream_reach"], h.get("solo_descope", h.get("exclusive_reach", 0)),
            h.get("out_degree"), h["risk"]]
           for h in result.heavy_hitters], [12, 16, 14, 12, 8])

    # Hidden PCI — full evidence ledger (BAM miss + Splunk proof + propagation)
    hd = hidden.get("hidden_detail")
    if hd:
        sheet(wb.create_sheet("HiddenPCI_Evidence"),
              ["System", "Name", "Propagates to (downstream)", "Stated source (DS6)", "BAM flag", "Splunk finding"],
              [[x["system"], x.get("name", ""), x.get("downstream_reach", 0),
                x.get("stated_source", ""), "PCI=No", x.get("finding", "True PAN")] for x in hd],
              [12, 26, 22, 18, 10, 16])
    else:
        sheet(wb.create_sheet("HiddenPCI"), ["System (PCI=No in BAM, PAN seen in Splunk)"],
              [[s] for s in hidden.get("hidden_pci_systems", [])], [44])

    # Ownership — exposure by line of business (authoritative DS4 org fields), so the
    # remediation program has owners, not just system IDs. Guarded: older results
    # without the rollup simply omit the sheet.
    own = (getattr(result, "ownership", {}) or {}).get("by_lob") or []
    if own:
        sheet(wb.create_sheet("Ownership"),
              ["Line of business", "Systems known", "In PCI scope (CDE)", "Hidden PCI",
               "Clear-PAN carriers", "Hidden systems (sample)", "Business groups (sample)"],
              [[o["line_of_business"], o["systems"], o["in_scope"], o["hidden_pci"],
                o["carries_pan"], ", ".join(o.get("hidden_sample", [])),
                ", ".join(o.get("business_groups", []))] for o in own],
              [34, 13, 17, 11, 16, 34, 34])

    # Tokenization plan — cumulative descope curve (always populated, even when the
    # greedy full-descope plan halts at 0; an empty sheet reads as 'didn't finish').
    curve = plan.get("cumulative_curve") or []
    if curve:
        sheet(wb.create_sheet("TokenizationPlan"),
              ["k", "Tokenize source", "Marginal descoped", "Cumulative descoped",
               "Cumulative feeds removed"],
              [[c["k"], c["last_source"], c["marginal_descoped"], c["cumulative_descoped"],
                c["cumulative_feeds_removed"]] for c in curve],
              [6, 18, 18, 20, 24])
    else:
        sheet(wb.create_sheet("TokenizationPlan"),
              ["Step", "Tokenize source", "Marginal descoped", "Cumulative descoped", "Scope after", "% of descopable"],
              [[s["step"], s["tokenize"], s["marginal_descoped"], s["cumulative_descoped"],
                s["scope_after"], s["pct_of_descopable"]] for s in plan.get("steps", [])],
              [8, 16, 18, 20, 12, 16])

    # Source exposure — per-true-source block-this/measure-the-benefit table (§3),
    # now with % of scope and the NAMES of fully-freed systems (the block-A-benefits
    # report). Non-zero even when full descope is 0: feeds_removed = solo + parent_red.
    exp = analytics.source_exposure_impact(art.G, art.pan_sources, scores, top_k=50)
    scope_before = max(1, exp.get("scope_before", 1))
    sheet(wb.create_sheet("SourceExposure"),
          ["True source", "Downstream reach", "Solo descope (fully freed)",
           "Feeds removed", "% of scope (feed)", "Parent-count reduction", "Risk",
           "Fully-freed systems (names)"],
          [[row["system"], row["downstream_reach"], row["solo_descope"],
            row["feeds_removed"], round(100 * row["feeds_removed"] / scope_before, 1),
            row["parent_reduction"], row["risk"],
            ", ".join(row.get("solo_systems", []))]
           for row in exp.get("per_source", [])],
          [14, 16, 22, 14, 16, 22, 8, 48])

    # Optimization — certified-optimal vs greedy descope frontier (exact solver)
    opt = plan.get("optimization") or {}
    fr = opt.get("frontier") or []
    if fr:
        ws_o = wb.create_sheet("Optimization")
        sheet(ws_o, ["Budget k", "Optimal descoped", "Greedy descoped", "Gap",
                     "% of descopable", "Optimal source set"],
              [[r["k"], r["optimal_descoped"], r["greedy_descoped"], r["gap"],
                r["pct_of_descopable"], ", ".join(r.get("optimal_sources", []))] for r in fr],
              [10, 18, 18, 8, 16, 60])
        ws_o.append([])
        ws_o.append(["Method", opt.get("method", "")])
        ws_o.append(["Greedy efficiency at its halt point (%)", opt.get("greedy_efficiency_pct")])
        ws_o.append(["Max greedy gap (systems)", opt.get("max_greedy_gap")])
        ms = opt.get("milestones_min_sources", {})
        for k, v in ms.items():
            ws_o.append([f"Min sources to free {k}", v])

    # Segmentation (min-cut) — edges to sever to ring-fence each high-value target
    mc = (getattr(result, "structure", {}) or {}).get("segmentation_min_cut") or {}
    if mc.get("cuts"):
        sheet(wb.create_sheet("Segmentation_MinCut"),
              ["Target system", "Min edges to sever", "Protects downstream reach", "Edges to sever (sample)"],
              [[c["target"], c.get("min_cut_edges"), c.get("downstream_reach"),
                "; ".join(f"{e[0]}->{e[1]}" for e in c.get("edges_to_sever", []))]
               for c in mc["cuts"]], [16, 18, 24, 60])

    # Economics — audit-scope cost model (current vs achievable floor)
    econ = getattr(result, "economics", {}) or {}
    if econ.get("in_scope_now"):
        ass = econ.get("assumptions", {})
        sheet(wb.create_sheet("Economics"), ["Metric", "Value"], [
            ["In PCI scope now (CDE)", econ["in_scope_now"]],
            ["Achievable floor (full tokenization)", econ["achievable_floor"]],
            ["Systems removable from scope", econ["removable"]],
            ["Assessment posture now", econ["posture_now"]],
            ["Assessment posture at floor", econ["posture_floor"]],
            ["Assessor-days now", econ["effort_now"]["qsa_days"]],
            ["Assessor-days at floor", econ["effort_floor"]["qsa_days"]],
            ["Est. cost now", econ["effort_now"]["est_cost"]],
            ["Est. cost at floor", econ["effort_floor"]["est_cost"]],
            ["Est. saving", econ["cost_saving"]],
            ["[assumption] rate / assessor-day", ass.get("qsa_day_rate")],
            ["[assumption] days / CDE system", ass.get("days_per_cde_system")],
            ["[assumption] days / connected-to system", ass.get("days_per_connected")],
            ["[assumption] ROC threshold (in-scope)", ass.get("roc_threshold")],
        ], [40, 26])

    # ScopeCategories — counts + requirement-family tallies (v4.0.1)
    cats = getattr(result, "categories", {}) or {}
    if cats.get("counts"):
        c = cats["counts"]
        labels, fc = cats.get("family_labels", {}), cats.get("family_counts", {})
        crows = [["In scope (CDE)", c.get("cde", 0)],
                 ["Connected-to (also in scope)", c.get("connected", 0)],
                 ["Out of scope", c.get("out", 0)], ["", ""]]
        for k, v in sorted(fc.items(), key=lambda kv: -kv[1]):
            crows.append([labels.get(k, k), v])
        sheet(wb.create_sheet("ScopeCategories"), ["Category / requirement family", "Systems"],
              crows, [56, 12])

    # Segmentation — articulation choke points and the branch each would isolate
    seg = (getattr(result, "structure", {}) or {}).get("segmentation_candidates") or []
    if seg:
        sheet(wb.create_sheet("Segmentation"),
              ["System", "Branch isolated", "Downstream reach", "Risk", "Role"],
              [[s["system"], s["branch_size"], s.get("downstream_reach", 0), s.get("risk", 0),
                "true source" if s.get("is_true_source") else "relay"] for s in seg],
              [14, 16, 18, 10, 14])

    out = io.BytesIO(); wb.save(out); out.seek(0)
    return out.read()
