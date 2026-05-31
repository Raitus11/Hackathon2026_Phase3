"""One-command demo: run the agentic pipeline on the sample CSVs, print a summary.
Usage:  python run_demo.py [dir_of_csvs]
"""
import json, sys, glob, os, logging

# Setup logging - print EVERYTHING
logging.basicConfig(level=logging.DEBUG, format='[%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

log.info("=" * 80)
log.info("PCI-SENTINEL HEADLESS PIPELINE START")
log.info("=" * 80)

try:
    log.info("[STEP 1] Importing orchestrator...")
    from pci_sentinel.orchestrator import run_agentic
    log.info("[STEP 1] ✓ Orchestrator imported successfully")

    log.info("[STEP 2] Locating CSV files...")
    d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "sample_data")
    log.info(f"[STEP 2] Looking in: {d}")
    
    csv_paths = sorted(glob.glob(os.path.join(d, "*.csv")))
    log.info(f"[STEP 2] Found {len(csv_paths)} CSV files:")
    for p in csv_paths:
        log.info(f"         - {os.path.basename(p)}")

    log.info("[STEP 3] Loading CSV contents...")
    files = []
    for p in csv_paths:
        with open(p, encoding="utf-8-sig") as fh:
            content = fh.read()
            files.append((os.path.basename(p), content))
            log.info(f"         Loaded {os.path.basename(p)}: {len(content)} bytes")
    log.info(f"[STEP 3] ✓ Loaded {len(files)} CSVs")

    log.info("[STEP 4] Running agentic pipeline (this may take 2-5 minutes)...")
    st = run_agentic(files, recommend_top=3)
    log.info("[STEP 4] ✓ Pipeline completed")
    
    r = st["result"]
    log.info("[STEP 5] Extracting results...")
    
    log.info("\n" + "=" * 80)
    log.info("=== AGENTIC AUDIT (LangGraph nodes) ===")
    log.info("=" * 80)
    for a in r.audit:
        log.info(f"  {a['stage']:20s} {a['ms']:6.1f}ms")

    log.info("\n" + "=" * 80)
    log.info("=== HEADLINE ===")
    log.info("=" * 80)
    log.info(json.dumps(r.headline, indent=2))

    log.info("\n" + "=" * 80)
    log.info("=== GRAPH STATS ===")
    log.info("=" * 80)
    log.info(json.dumps(r.graph_stats, indent=2))

    log.info("\n" + "=" * 80)
    log.info("=== DAG STATS ===")
    log.info("=" * 80)
    log.info(json.dumps(r.dag_stats, indent=2))

    log.info("\n" + "=" * 80)
    log.info("=== HIDDEN PCI (BAM MISSES) ===")
    log.info("=" * 80)
    log.info(f"Hidden PCI count: {r.hidden['hidden_pci_count']}")
    log.info(f"Sample systems: {r.hidden['hidden_pci_systems'][:10]}")

    log.info("\n" + "=" * 80)
    log.info("=== TOP 5 HEAVY HITTERS ===")
    log.info("=" * 80)
    for h in r.heavy_hitters[:5]:
        log.info(f"  {h['system']:8s}  reach={h['downstream_reach']:3d}  excl={h['exclusive_reach']:2d}  out_deg={h['out_degree']:2d}  risk={h['risk']:6.2f}")

    log.info("\n" + "=" * 80)
    log.info("=== TOKENIZATION IMPACT (CLEAN-STREAM) ===")
    log.info("=" * 80)
    log.info(json.dumps(r.impact, indent=2))

    log.info("\n" + "=" * 80)
    log.info("=== LLM EXPLANATION ===")
    log.info("=" * 80)
    log.info(r.explanation)

    log.info("\n" + "=" * 80)
    log.info("✓✓✓ PIPELINE RAN SUCCESSFULLY ✓✓✓")
    log.info("=" * 80)

except KeyboardInterrupt:
    log.error("Pipeline interrupted by user (Ctrl+C)")
    sys.exit(1)

except Exception as e:
    log.error(f"FATAL ERROR: {e}", exc_info=True)
    import traceback
    traceback.print_exc()
    sys.exit(1)
