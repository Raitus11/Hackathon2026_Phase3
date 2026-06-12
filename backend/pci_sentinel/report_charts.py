"""Business-analyst report charts (matplotlib, headless).

Every figure is built from the already-computed, grounded RunResult / plan, so a
chart can never disagree with the dashboard. The design brief is non-technical
legibility: each chart answers one question, labels the absolute number AND the
percentage, and uses one consistent palette. Returns PNG bytes buffers for
embedding into the reportlab PDF.
"""
from __future__ import annotations

import io

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

# palette (matches reporting.py)
INK = "#1F2329"
PAN = "#C77800"
SAFE = "#0E7C4A"
HOT = "#D71E28"
COOL = "#2563EB"
DIM = "#5A6472"
GRID = "#ECE9E2"
LIGHT = "#F6F4EF"

plt.rcParams.update({
    "font.size": 9, "axes.edgecolor": "#CFC9BE", "axes.linewidth": 0.8,
    "axes.titlesize": 10, "axes.titleweight": "bold", "axes.titlecolor": INK,
    "axes.labelcolor": DIM, "xtick.color": DIM, "ytick.color": DIM,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.7,
})


def _fig(w=7.4, h=3.2, dpi=150):
    fig, ax = plt.subplots(figsize=(w, h), dpi=dpi)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    return fig, ax


def _save(fig) -> io.BytesIO:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white", dpi=150)
    plt.close(fig)
    buf.seek(0)
    return buf


# --------------------------------------------------------------------------- 1. THE frontier
def chart_optimal_vs_greedy(frontier_block: dict) -> io.BytesIO | None:
    """Certified-optimal vs greedy descope frontier — the centrepiece. Shows that an
    exact solver beats greedy at the small budgets a business actually considers."""
    fr = (frontier_block or {}).get("frontier") or []
    if len(fr) < 2:
        return None
    ks = [r["k"] for r in fr]
    opt = [r["optimal_descoped"] for r in fr]
    grd = [r["greedy_descoped"] for r in fr]
    desc = frontier_block.get("descopable", max(opt) or 1)

    fig, ax = _fig(7.4, 3.4)
    ax.fill_between(ks, grd, opt, color=PAN, alpha=0.12, zorder=1,
                    label="greedy shortfall")
    ax.plot(ks, opt, "-o", color=SAFE, lw=2.4, ms=5, zorder=3,
            label="certified optimal (MILP / branch-and-bound)")
    ax.plot(ks, grd, "--s", color=PAN, lw=1.8, ms=4, zorder=2, label="greedy heuristic")

    # annotate the widest gap
    gaps = [o - g for o, g in zip(opt, grd)]
    gi = max(range(len(gaps)), key=lambda i: gaps[i])
    if gaps[gi] > 0:
        ax.annotate(f"+{gaps[gi]} systems\nthe optimum finds\nthat greedy misses",
                    xy=(ks[gi], opt[gi]), xytext=(ks[gi] + 0.4, opt[gi] - desc * 0.28),
                    fontsize=8, color=HOT, ha="left",
                    arrowprops=dict(arrowstyle="->", color=HOT, lw=1.2))

    ax.axhline(desc, color=DIM, ls=":", lw=1)
    ax.text(ks[-1], desc, f"  all {desc} descopable", va="center", ha="right",
            fontsize=7.5, color=DIM)
    ax.set_xlabel("number of true PAN sources tokenized (budget k)")
    ax.set_ylabel("systems fully descoped")
    ax.set_title("Optimal vs greedy tokenization — systems freed per budget")
    ax.xaxis.set_major_locator(MaxNLocator(integer=True))
    ax.set_ylim(0, desc * 1.14 + 1)
    ax.legend(loc="lower right", frameon=False, fontsize=7.8)
    return _save(fig)


# --------------------------------------------------------------------------- 2. scope composition
def chart_scope_composition(result) -> io.BytesIO | None:
    """Two stacked bars: evidence basis (confirmed vs inferred) and PCI category
    (CDE / connected / out). Answers 'what is in scope and how do we know'."""
    br = getattr(result, "scope_breakdown", {}) or {}
    conf = br.get("metadata_confirmed", 0) or 0
    inf = br.get("inferred_only", 0) or 0
    total = (conf + inf) or 1
    cats = (getattr(result, "categories", {}) or {}).get("counts", {}) or {}
    cde, conn, out = cats.get("cde", 0), cats.get("connected", 0), cats.get("out", 0)

    fig, ax = _fig(7.4, 2.5)
    # bar 1: evidence basis
    ax.barh(1, conf, color=COOL, label="BAM-confirmed")
    ax.barh(1, inf, left=conf, color=PAN, label="inferred-only (Splunk/survey)")
    ax.text(conf / 2, 1, f"{conf}\n{100*conf/total:.0f}%", ha="center", va="center",
            color="white", fontsize=8, fontweight="bold")
    if inf:
        ax.text(conf + inf / 2, 1, f"{inf}\n{100*inf/total:.0f}%", ha="center", va="center",
                color="white", fontsize=8, fontweight="bold")
    # bar 2: PCI category (only if present)
    yticks, ylabels = [1], [f"Evidence\n(n={total})"]
    if (cde + conn + out) > 0:
        tot2 = cde + conn + out
        ax.barh(0, cde, color=HOT, label="CDE (in scope)")
        ax.barh(0, conn, left=cde, color="#E8A33D", label="connected-to")
        ax.barh(0, out, left=cde + conn, color=SAFE, label="out of scope")
        for val, left in ((cde, 0), (conn, cde), (out, cde + conn)):
            if val:
                ax.text(left + val / 2, 0, f"{val}", ha="center", va="center",
                        color="white", fontsize=8, fontweight="bold")
        yticks = [0, 1]; ylabels = [f"PCI category\n(n={tot2})", f"Evidence\n(n={total})"]
    ax.set_yticks(yticks); ax.set_yticklabels(ylabels, fontsize=8)
    ax.set_xlabel("systems")
    ax.set_title("Scope composition — evidence basis and PCI category")
    ax.grid(axis="y", visible=False)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.28), ncol=3, frameon=False, fontsize=7.3)
    return _save(fig)


# --------------------------------------------------------------------------- 3. scope reduction / economics
def chart_scope_reduction(result) -> io.BytesIO | None:
    """Before -> achievable-floor scope with the removable slice and % called out."""
    econ = getattr(result, "economics", {}) or {}
    now = econ.get("in_scope_now")
    floor = econ.get("achievable_floor")
    if now is None or floor is None:
        return None
    removable = max(0, now - floor)
    fig, ax = _fig(3.5, 3.0)
    bars = ax.bar(["In scope\nnow", "Achievable\nfloor"], [now, floor],
                  color=[HOT, SAFE], width=0.6)
    for b, v in zip(bars, [now, floor]):
        ax.text(b.get_x() + b.get_width() / 2, v + max(now, 1) * 0.02, str(v),
                ha="center", va="bottom", fontsize=10, fontweight="bold", color=INK)
    if removable and now:
        ax.annotate("", xy=(1, floor), xytext=(1, now),
                    arrowprops=dict(arrowstyle="<->", color=DIM, lw=1.2))
        ax.text(1.12, (now + floor) / 2, f"−{removable}\n(−{100*removable/now:.0f}%)",
                color=PAN, fontsize=9, fontweight="bold", va="center")
    ax.set_ylabel("systems in PCI scope")
    ax.set_title("Scope reduction potential")
    ax.grid(axis="x", visible=False)
    ax.set_ylim(0, now * 1.18 + 1)
    return _save(fig)


def chart_economics(result) -> io.BytesIO | None:
    """Assessor-days and cost: now vs floor, with the saving labelled."""
    econ = getattr(result, "economics", {}) or {}
    en, ef = econ.get("effort_now", {}), econ.get("effort_floor", {})
    dn, df = en.get("qsa_days"), ef.get("qsa_days")
    if dn is None or df is None:
        return None
    cn, cf = en.get("est_cost", 0), ef.get("est_cost", 0)
    fig, ax = _fig(3.5, 3.0)
    bars = ax.bar(["Assessor-days\nnow", "Assessor-days\nat floor"], [dn, df],
                  color=[HOT, SAFE], width=0.6)
    for b, v in zip(bars, [dn, df]):
        ax.text(b.get_x() + b.get_width() / 2, v + max(dn, 1) * 0.02, f"{v:g}",
                ha="center", va="bottom", fontsize=10, fontweight="bold", color=INK)
    saving = econ.get("cost_saving", max(0, cn - cf))
    ax.set_title("Audit effort & cost")
    ax.set_ylabel("assessor-days")
    ax.grid(axis="x", visible=False)
    ax.set_ylim(0, dn * 1.22 + 1)
    ax.text(0.5, dn * 1.12, f"est. saving ≈ {saving:,.0f}", ha="center",
            fontsize=8.5, color=PAN, fontweight="bold", transform=ax.transData)
    return _save(fig)


# --------------------------------------------------------------------------- 4. hidden scope
def chart_hidden_scope(result) -> io.BytesIO | None:
    """Top hidden-PCI systems (BAM=No, PAN in Splunk) by how far the leaked PAN
    propagates downstream — the killer finding, ranked."""
    hidden = getattr(result, "hidden", {}) or {}
    detail = hidden.get("hidden_detail") or []
    if not detail:
        return None
    rows = sorted(detail, key=lambda d: -(d.get("downstream_reach") or 0))[:10]
    rows = [r for r in rows if (r.get("downstream_reach") or 0) > 0] or rows[:6]
    names = [r["system"] for r in rows][::-1]
    reach = [r.get("downstream_reach", 0) for r in rows][::-1]
    fig, ax = _fig(7.4, max(2.2, 0.32 * len(names) + 1.1))
    ax.barh(names, reach, color=HOT)
    for i, v in enumerate(reach):
        ax.text(v + max(reach + [1]) * 0.01, i, str(v), va="center", fontsize=8, color=INK)
    ax.set_xlabel("downstream systems the leaked PAN can reach")
    cnt = hidden.get("hidden_pci_count", len(detail))
    prop = hidden.get("hidden_propagating_count", 0)
    ax.set_title(f"Hidden PCI — {cnt} BAM misses ({prop} propagate PAN onward)")
    ax.grid(axis="y", visible=False)
    return _save(fig)


# --------------------------------------------------------------------------- 5. source exposure scatter
def chart_source_exposure(plan: dict) -> io.BytesIO | None:
    """Per-source 'block this parent -> who benefits' scatter: x = downstream reach,
    y = risk, bubble = feeds removed, colour = whether it frees any system alone."""
    se = (plan or {}).get("source_exposure") or {}
    rows = se.get("per_source") or []
    if not rows:
        return None
    rows = sorted(rows, key=lambda r: -(r.get("feeds_removed") or 0))[:30]
    x = [r.get("downstream_reach", 0) for r in rows]
    y = [r.get("risk", 0) for r in rows]
    fr = [r.get("feeds_removed", 0) for r in rows]
    solo = [r.get("solo_descope", 0) for r in rows]
    mx = max(fr + [1])
    sizes = [40 + 360 * (f / mx) for f in fr]
    colors = [SAFE if s > 0 else PAN for s in solo]
    fig, ax = _fig(7.4, 3.3)
    ax.scatter(x, y, s=sizes, c=colors, alpha=0.55, edgecolors="white", linewidths=0.6, zorder=3)
    # label the few highest-leverage sources
    for r in sorted(rows, key=lambda r: -(r.get("feeds_removed") or 0))[:6]:
        ax.annotate(r["system"], (r.get("downstream_reach", 0), r.get("risk", 0)),
                    fontsize=7.5, color=INK, xytext=(4, 4), textcoords="offset points")
    ax.set_xlabel("downstream reach (systems fed clear PAN)")
    ax.set_ylabel("risk score R(v)")
    ax.set_title("Tokenization leverage by source — bubble = systems that lose a clear-PAN feed")
    # legend proxies
    from matplotlib.lines import Line2D
    leg = [Line2D([0], [0], marker="o", color="w", markerfacecolor=SAFE, markersize=9,
                  label="frees ≥1 system alone"),
           Line2D([0], [0], marker="o", color="w", markerfacecolor=PAN, markersize=9,
                  label="narrows exposure only")]
    ax.legend(handles=leg, loc="best", frameon=False, fontsize=7.6)
    return _save(fig)


def chart_fate_grid(plan: dict) -> io.BytesIO | None:
    """'Every square is a system in PCI scope today' — the unit chart a business
    reader parses in one glance. Green leaves the audit under full true-source
    tokenization; red stays as the tokenization points; blue stays via RISE/APG.
    Mirrors the dashboard FateGrid (same V-022-guarded numbers)."""
    before = (plan or {}).get("before") or 0
    if not before:
        return None
    fb = plan.get("floor_breakdown") or {}
    green = plan.get("descopable") or 0
    red = fb.get("origins_in_scope", max(0, before - green))
    blue = fb.get("always_cde_in_scope", 0)
    unit = max(1, -(-before // 180))            # ceil; ≤180 squares at any scale
    cells = ([SAFE] * round(green / unit) + [HOT] * round(red / unit)
             + [COOL] * round(blue / unit))
    cols = 30
    rows = -(-len(cells) // cols)
    fig, ax = _fig(7.4, 0.28 * rows + 0.9)
    ax.grid(False)
    for i, c in enumerate(cells):
        x, y = i % cols, rows - 1 - i // cols
        ax.add_patch(plt.Rectangle((x * 1.0, y * 1.0), 0.86, 0.86, color=c, alpha=0.9))
    ax.set_xlim(-0.2, cols)
    ax.set_ylim(-0.2, rows)
    ax.set_aspect("equal")
    ax.axis("off")
    legend = [f"{green:,} can leave PCI scope", f"{red:,} stay — tokenization points"]
    handles = [plt.Rectangle((0, 0), 1, 1, color=SAFE), plt.Rectangle((0, 0), 1, 1, color=HOT)]
    if blue:
        legend.append(f"{blue:,} stay — need RISE/APG")
        handles.append(plt.Rectangle((0, 0), 1, 1, color=COOL))
    ax.legend(handles, legend, loc="upper center", bbox_to_anchor=(0.5, -0.02),
              ncol=3, frameon=False, fontsize=8.5)
    unit_txt = f" (each square ≈ {unit} systems)" if unit > 1 else ""
    ax.set_title(f"Every square is a system in PCI scope today{unit_txt}")
    return _save(fig)
