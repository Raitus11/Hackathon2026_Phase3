"""Regenerate the downloadable evidence bundle from the real run.

Uses the application's OWN report builders (reporting.build_pdf / build_xlsx) and
the same minimal-tokenization-plan call the FastAPI /api/report endpoints use, so
the bundle can never disagree with the dashboard. Nothing here re-derives analysis;
every figure comes straight from the grounded pipeline result.

This mirrors build_snapshot.py: it invokes the app's components headlessly so the
deliverables are a product of the pipeline, not hand-assembled.

Run from the backend/ directory with the venv active:
    python build_evidence.py

Writes into ../evidence/:
    pci-sentinel-report.pdf       (executive, non-technical decision-support)
    pci-sentinel-data-pack.xlsx   (technical data trail)
    metrics.md                    (key metrics, plain text)
"""
import os
import glob
import sys

sys.path.insert(0, ".")
from pci_sentinel import pipeline, reporting, analytics          # noqa: E402
from pci_sentinel import graph_build, ingest as ingest_mod       # noqa: E402
from pci_sentinel.scoring import compute_scores                  # noqa: E402

SAMPLE = os.path.abspath("../sample_data")
OUT = os.path.abspath("../evidence")
os.makedirs(OUT, exist_ok=True)

files = []
for p in sorted(glob.glob(os.path.join(SAMPLE, "*.csv"))):
    with open(p, encoding="utf-8-sig") as fh:
        files.append((os.path.basename(p), fh.read()))
print(f"[evidence] loaded {len(files)} CSVs from {SAMPLE}")

# The grounded result the dashboard and snapshot also use.
r = pipeline.run(files, recommend_top=3)

# Re-derive the deterministic graph artifacts (identical build the pipeline used).
ing = ingest_mod.ingest_files(files)
art = graph_build.build_graph(ing)
scores = compute_scores(art.G)

# EXACT plan call the /api/report/pdf and /api/report/xlsx endpoints make.
plan = analytics.minimal_tokenization_plan(
    art.G, art.pan_sources, scores, target_fraction=0.8, max_k=8
)

# ----------------------------------------------------------------- PDF + XLSX
pdf = reporting.build_pdf(r, art, scores, plan)
xlsx = reporting.build_xlsx(r, art, scores, plan)

pdf_path = os.path.join(OUT, "pci-sentinel-report.pdf")
xlsx_path = os.path.join(OUT, "pci-sentinel-data-pack.xlsx")
with open(pdf_path, "wb") as fh:
    fh.write(pdf)
with open(xlsx_path, "wb") as fh:
    fh.write(xlsx)
print(f"[evidence] wrote {pdf_path}  ({len(pdf):,} bytes)")
print(f"[evidence] wrote {xlsx_path}  ({len(xlsx):,} bytes)")

# ----------------------------------------------------------------- metrics.md
h = r.headline
br = r.scope_breakdown
hid = r.hidden
imp = r.impact
gs = r.graph_stats
ds = r.dag_stats


def g(d, k, default="—"):
    try:
        v = d.get(k, default)
        return default if v is None else v
    except AttributeError:
        return default


lines = []
lines.append("# PCI-SENTINEL — Key Metrics")
lines.append("")
lines.append("_Generated from the live pipeline run on the provided datasets. "
             "Every figure below is reproducible from the source CSVs via the "
             "deterministic engine; the dashboard, PDF, and XLSX render the same "
             "grounded result._")
lines.append("")
lines.append("## Scope")
lines.append(f"- **Systems exposed to clear PAN:** {g(h, 'systems_exposed_to_clear_pan', r.scope_size)}")
lines.append(f"  - Confirmed by authoritative BAM metadata: **{g(br, 'metadata_confirmed')}**")
lines.append(f"  - Inferred-only candidate scope (Splunk/survey signals, kept separate, "
             f"never treated as ground truth): **{g(br, 'inferred_only')}**")
lines.append(f"- **Hidden PCI — clear PAN in systems BAM flags PCI=No:** "
             f"**{g(hid, 'hidden_pci_count')}** "
             f"(of which {g(hid, 'hidden_propagating_count', 0)} propagate PAN further downstream)")
lines.append(f"- **Cycle clusters resolved into the DAG:** {g(ds, 'cycle_clusters')}")
lines.append("")
lines.append("## Graph")
lines.append(f"- Nodes: {g(gs, 'nodes')}")
lines.append(f"- Metadata edges: {g(gs, 'metadata_edges')} "
             f"(deduped {g(gs, 'metadata_edges_deduped')})")
lines.append(f"- Inferred edges (distinguished, source-tagged): {g(gs, 'inferred_edges')}")
lines.append(f"- True PAN-source nodes: {g(gs, 'pan_source_nodes')}")
lines.append(f"- DAG after Tarjan SCC condensation: "
             f"{g(ds, 'dag_nodes')} nodes / {g(ds, 'dag_edges')} edges "
             f"(acyclic: {g(ds, 'is_acyclic')})")
lines.append("")
lines.append("## Primary PAN distributors (heavy hitters, ranked by downstream reach)")
lines.append("")
lines.append("| System | Downstream reach | Solo descope | Out-degree | Risk |")
lines.append("|---|---|---|---|---|")
for hh in r.heavy_hitters[:10]:
    solo = hh.get("solo_descope", hh.get("exclusive_reach", 0))
    lines.append(f"| {hh.get('system')} | {hh.get('downstream_reach')} | {solo} "
                 f"| {hh.get('out_degree', '—')} | {hh.get('risk')} |")
lines.append("")
lines.append("_Solo descope = systems freed if only that one source is tokenized. It is small "
             "everywhere because downstream systems are fed by several PAN sources simultaneously — "
             "which is exactly why a minimum-intervention set matters more than any single source._")
lines.append("")
lines.append("## Tokenization leverage (minimum-intervention optimizer)")
lines.append(f"- Greedy maximum-coverage (Nemhauser, Wolsey & Fisher 1978, (1−1/e) bound).")
lines.append(f"- Tokenizing **{g(plan, 'k')}** source system(s) descopes "
             f"**{g(plan, 'total_descoped')}** of {g(plan, 'descopable')} descopable systems "
             f"({g(plan, 'before')} → {g(plan, 'after')} in PCI scope).")
lines.append(f"- Clean-stream impact of the recommended top-3 sources: "
             f"descopes {g(imp, 'nodes_descoped')} systems "
             f"({g(imp, 'node_surface_reduction_pct')}% of the in-scope surface), "
             f"aggregate exposure risk −{g(imp, 'risk_reduction_pct')}%.")
lines.append(f"- {g(imp, 'retained_via_detokenization_count', 0)} system(s) genuinely need PAN "
             f"and remain in the CDE, de-tokenizing via centralized RISE/APG services.")
lines.append("")
_descoped = g(imp, "nodes_descoped", 0)
try:
    _descoped_n = int(_descoped)
except (TypeError, ValueError):
    _descoped_n = 0
if _descoped_n == 0:
    lines.append("### Honest finding at enterprise scale")
    lines.append("Because in-scope systems are reachable from **many** PAN sources at once, tokenizing "
                 "any single or small set of sources does not remove systems from scope — the optimizer "
                 "correctly reports this (greedy halts at zero marginal benefit) rather than inventing a "
                 "reduction. The system's value here is **visibility and lineage**: it surfaces the true "
                 f"{g(h, 'systems_exposed_to_clear_pan', r.scope_size)}-system scope the catalogue understates, "
                 f"the {g(hid, 'hidden_pci_count')} hidden-PCI systems BAM misses, and the widest distributors "
                 f"(top: {g(h, 'top_distributor')}) so intervention can be prioritized with full knowledge.")
else:
    lines.append("### Where the lift concentrates")
    lines.append(f"Tokenizing the recommended source(s) removes **{_descoped_n}** system(s) from scope. "
                 "Because most downstream systems are fed by several PAN sources at once, the optimizer "
                 "selects the minimum-intervention set rather than over-claiming any single source — and "
                 "the broader value is **visibility and lineage**: the true scope the catalogue understates, "
                 f"the {g(hid, 'hidden_pci_count')} hidden-PCI systems BAM misses, and the widest distributors "
                 f"(top: {g(h, 'top_distributor')}) for prioritized intervention.")
lines.append("")
lines.append("## Method & honest scope")
lines.append("- Risk R(v)∈[0,100] = 0.40·sensitivity-tier + 0.30·reachability (transitive closure, "
             "scaled to the widest distributor) + 0.20·betweenness centrality (Brandes 2001, scaled "
             "to the most-central system) + 0.10·true-source flag.")
lines.append("- Cycles in the BAM/ServiceNow relationships are resolved by Tarjan strongly-connected-"
             "component detection then condensation, yielding a provable DAG. The rule is explicit.")
lines.append("- Inferred edges (Splunk/survey) carry their source and are never merged with metadata edges.")
lines.append("- **What this does not do:** it does not remediate controls, assert business need, or "
             "execute tokenization. It maps current-state lineage and shows where intervention has the "
             "greatest lift.")
lines.append("- Card numbers are masked first-6/last-4 on ingest; an unmasked PAN fails the run.")
lines.append("")

md_path = os.path.join(OUT, "metrics.md")
with open(md_path, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines))
print(f"[evidence] wrote {md_path}")

print("\n=== EVIDENCE BUNDLE NUMBERS (real run) ===")
print(f"scope {r.scope_size} = meta {g(br, 'metadata_confirmed')} + inferred {g(br, 'inferred_only')}")
print(f"hidden PCI (BAM misses): {g(hid, 'hidden_pci_count')}")
print(f"plan: tokenize {g(plan, 'k')} -> descopes {g(plan, 'total_descoped')} "
      f"of {g(plan, 'descopable')} ({g(plan, 'before')} -> {g(plan, 'after')})")
print(f"clean-stream: descoped {g(imp, 'nodes_descoped')} | risk -{g(imp, 'risk_reduction_pct')}%")
print(f"top distributor: {g(h, 'top_distributor')}")
