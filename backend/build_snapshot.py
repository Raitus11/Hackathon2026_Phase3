"""Regenerate the embedded analysis snapshot from the sample CSVs.
Writes the exact JSON contract the React app consumes as its offline-demo fallback.
Run from the backend/ directory:  python /home/claude/build_snapshot.py <out.json> [<out.json> ...]
"""
import json, sys, glob, os
sys.path.insert(0, ".")
from pci_sentinel import pipeline, agents as agents_mod, chat as chat_mod, analytics
from pci_sentinel import graph_build, ingest as ingest_mod
from pci_sentinel.scoring import compute_scores

SAMPLE = os.path.abspath("../sample_data")
files = []
for p in sorted(glob.glob(os.path.join(SAMPLE, "*.csv"))):
    with open(p, encoding="utf-8-sig") as fh:
        files.append((os.path.basename(p), fh.read()))

r = pipeline.run(files, recommend_top=3)

# artifacts for what-if (reuse the same deterministic build the pipeline used)
ing = ingest_mod.ingest_files(files)
art = graph_build.build_graph(ing)
scores = compute_scores(art.G)
recommend = analytics.recommended_levers(art.G, art.pan_sources, scores, 3)
whatif_top3 = analytics.what_if(art.G, art.pan_sources, scores, recommend)

snap = {
    "headline": r.headline, "hidden": r.hidden, "quality": r.quality,
    "graph_stats": r.graph_stats, "dag_stats": r.dag_stats, "scope_size": r.scope_size,
    "scope_breakdown": r.scope_breakdown, "heavy_hitters": r.heavy_hitters,
    "impact": r.impact, "cycles": r.cycles,
    "unresolved_signals_sample": r.unresolved_signals,
    "explanation": r.explanation, "audit": r.audit, "viz": r.viz,
    "agents": agents_mod.ROSTER,
    "suggested_questions": chat_mod.suggested_questions(r),
    "plan": r.plan, "whatif_top3": whatif_top3, "structure": r.structure,
    "categories": r.categories, "economics": r.economics, "sankey": r.sankey,
}

for out in sys.argv[1:]:
    with open(out, "w") as fh:
        json.dump(snap, fh, indent=2)
    print("wrote", out)

i = r.impact
print("\n=== CORRECTED SNAPSHOT NUMBERS ===")
print(f"scope {r.scope_size} = meta {r.scope_breakdown['metadata_confirmed']} + inferred {r.scope_breakdown['inferred_only']}")
print(f"hidden PCI (BAM misses): {r.hidden['hidden_pci_count']}")
print(f"top distributor (reach): {r.headline.get('top_distributor')}  |  top intervention (lever): {r.headline.get('top_intervention')}")
print(f"recommended levers (gate/impact): {recommend}")
print(f"clean-stream: descoped {i['nodes_descoped']} | surface {i['node_surface_reduction_pct']}% | risk -{i['risk_reduction_pct']}%")
print(f"   sources downgraded 4->3: {i['sources_downgraded']} | retained tier4: {i['sources_retained_tier4']}")
print(f"plan: tokenize {r.plan['k']} -> descopes {r.plan['total_descoped']} of {r.plan['descopable']} descopable")
print("HH (reach-ranked) invariant check:")
for h in r.heavy_hitters:
    assert h["solo_descope"] <= h["downstream_reach"], f"INVARIANT VIOLATED: {h}"
print(f"   solo_descope <= reach holds for all {len(r.heavy_hitters)} rows: OK")
