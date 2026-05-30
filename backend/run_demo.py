"""One-command demo: run the agentic pipeline on the sample CSVs, print a summary.
Usage:  python run_demo.py [dir_of_csvs]
"""
import json, sys, glob, os
from pci_sentinel.orchestrator import run_agentic

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "sample_data")
files = []
for p in sorted(glob.glob(os.path.join(d, "*.csv"))):
    with open(p, encoding="utf-8-sig") as fh:
        files.append((os.path.basename(p), fh.read()))
print(f"Loaded {len(files)} CSVs from {d}")
st = run_agentic(files, recommend_top=3)
r = st["result"]
print("\n=== AGENTIC AUDIT (LangGraph nodes) ===")
for a in r.audit: print("  ", a["stage"], f"{a['ms']}ms")
print("\n=== HEADLINE ===", json.dumps(r.headline, indent=2))
print("=== GRAPH ===", json.dumps(r.graph_stats, indent=2))
print("=== DAG ===", json.dumps(r.dag_stats, indent=2))
print(f"\nHidden PCI (BAM misses): {r.hidden['hidden_pci_count']} -> {r.hidden['hidden_pci_systems'][:10]}")
print("\n=== TOP HEAVY HITTERS ===")
for h in r.heavy_hitters[:5]:
    print(f"  {h['system']:8} excl_reach={h['exclusive_reach']:4} reach={h['downstream_reach']:4} out_deg={h['out_degree']:4} risk={h['risk']}")
print("\n=== CLEAN-STREAM IMPACT ===", json.dumps(r.impact, indent=2))
print("\n=== EXPLANATION ===\n", r.explanation)
