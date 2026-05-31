"""Downloadable deliverables — executive PDF report and XLSX data pack.

Both are generated from the already-computed, grounded RunResult plus the graph
artifacts; nothing here re-derives analysis, so a report can never disagree with
the dashboard. The PDF is the non-technical decision-support artifact (Documentation
+ Communication scoring); the XLSX is the technical data trail (evidence bundle).
"""
from __future__ import annotations

import io
from datetime import datetime, timezone

# headless rendering for the embedded graph
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx

from . import analytics

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                Image as RLImage, HRFlowable)

INK = colors.HexColor("#0f1622")
PAN = colors.HexColor("#d98b1f")
SAFE = colors.HexColor("#0f9b8e")
HOT = colors.HexColor("#d64545")
COOL = colors.HexColor("#3f6fd1")
DIM = colors.HexColor("#5b6b82")
LINE = colors.HexColor("#d6deea")


def _ts():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


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
        if m.get("hidden_pci"): return "#d64545"
        if m.get("is_true_source"): return "#d98b1f"
        if m.get("carries_pan"): return "#e3a83a"
        return "#3f6fd1"
    sizes = [120 + 26 * (rank.get(n, {}).get("downstream_reach") or 0) for n in H.nodes()]
    nx.draw_networkx_edges(H, pos, ax=ax, edge_color="#b9c4d4", arrows=True,
                           arrowsize=7, width=0.7, alpha=0.7)
    nx.draw_networkx_nodes(H, pos, ax=ax, node_color=[color(n) for n in H.nodes()],
                           node_size=sizes, linewidths=0.4, edgecolors="white")
    big = sorted(H.nodes(), key=lambda n: -(rank.get(n, {}).get("downstream_reach") or 0))[:14]
    nx.draw_networkx_labels(H, pos, labels={n: n for n in big}, ax=ax, font_size=6,
                            font_color="#1b2536")
    ax.axis("off")
    ax.set_title("PAN data-flow — heavy hitters and downstream (arrow = provider → consumer)",
                 fontsize=8, color="#1b2536")
    buf = io.BytesIO(); fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white")
    plt.close(fig); buf.seek(0); return buf


# ----------------------------------------------------------------------------- PDF
def build_pdf(result, art, scores, plan: dict) -> bytes:
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

    E.append(Paragraph("Executive summary", h2))
    E.append(Paragraph(result.explanation, body))

    # tokenization leverage
    E.append(Paragraph("Where tokenization has the greatest leverage", h2))
    E.append(Paragraph(
        f"A minimum-intervention optimizer (greedy max-marginal full-descope over the true PAN sources) "
        f"finds that tokenizing <b>{plan.get('k')}</b> source system(s) fully descopes "
        f"<b>{plan.get('total_descoped')}</b> of {plan.get('descopable')} descopable systems "
        f"({plan.get('before')} → {plan.get('after')} in PCI scope). A system goes fully safe only when every "
        f"true PAN source reaching it emits CRN — a conjunctive condition, so full descope ramps only once most "
        f"of the source front is tokenized (the curve below). Greedy is used as a transparent heuristic: the "
        f"freed-systems objective is supermodular under this AND-coverage, so the (1−1/e) submodular guarantee "
        f"does not apply and is not claimed.", body))
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
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f7")),
        ("TEXTCOLOR", (0, 0), (-1, 0), DIM), ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("FONTNAME", (1, 1), (1, -1), "Courier-Bold"), ("TEXTCOLOR", (1, 1), (1, -1), PAN),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f6f8fb")]),
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
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f7")), ("TEXTCOLOR", (0, 0), (-1, 0), DIM),
        ("FONTSIZE", (0, 0), (-1, -1), 8), ("FONTNAME", (0, 1), (0, -1), "Courier-Bold"),
        ("TEXTCOLOR", (0, 1), (0, -1), PAN),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f6f8fb")]),
        ("GRID", (0, 0), (-1, -1), 0.3, LINE), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    E.append(ht)
    E.append(Paragraph("Ranked by downstream reach (distribution blast radius). Solo descope = systems freed if only that source "
                       "is tokenized; it is small everywhere because downstream systems are fed by several PAN sources, which is "
                       "why the minimum-intervention set (above) matters more than any single source.", small))

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
                       "source CSVs.", small))

    doc.build(E)
    buf.seek(0)
    return buf.read()


# ----------------------------------------------------------------------------- XLSX
def build_xlsx(result, art, scores, plan: dict) -> bytes:
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
    rows = []
    for n in result.viz.get("nodes", []):
        # NOTE: read the keys _viz_payload actually emits (tier/reach/scope_prov/true_source),
        # not the analytics-internal names — that mismatch is what left these columns blank.
        rows.append([n["id"], n.get("risk"), n.get("tier"), n.get("reach"),
                     "yes" if n.get("carries_pan") else "no", "yes" if n.get("in_scope") else "no",
                     (n.get("scope_prov") or ("out of scope" if not n.get("in_scope") else "")),
                     "yes" if n.get("hidden_pci") else "no",
                     "yes" if n.get("true_source") else "no"])
    rows.sort(key=lambda r: -(r[1] or 0))
    sheet(wb.create_sheet("Systems"),
          ["System", "Risk", "Sensitivity tier", "Downstream reach", "Carries PAN", "In scope",
           "Scope basis", "Hidden PCI", "True source"], rows,
          [12, 8, 14, 16, 12, 10, 18, 11, 12])

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

    out = io.BytesIO(); wb.save(out); out.seek(0)
    return out.read()
