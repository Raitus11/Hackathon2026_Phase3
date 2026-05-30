# PCI-SENTINEL
**Intelligent Mapping of Interdependencies Across PCI Systems** — an explainable,
upload-driven engine that maps how cardholder data (PAN) flows across enterprise
systems and shows where tokenization most reduces PCI scope.

## What it does
1. **Ingest & sanitise** the BAM + supplemental CSVs (upload-driven; auto-detects
   which dataset is which). PAN is masked first-6/last-4 on entry; an unmasked,
   Luhn-valid PAN past this boundary **fails the run**.
2. **Provenance-typed data-flow graph** — `metadata` edges (DS1/DS2/DS3,
   authoritative BAM) kept first-class-distinct from `inferred` edges (DS5 survey
   / DS6 Splunk, signals only). No systems/edges invented beyond the data.
3. **From-graph → to-graph** — the cyclic source is condensed into a verified
   **DAG** via Tarjan SCC + condensation; every cycle is preserved as an auditable
   super-node (cycle resolution is explicit and explainable, per the FAQ).
4. **Defensible scoring** — risk = sensitivity × downstream-reach × betweenness
   (Freeman/Brandes) × true-source; all factors named, bounded, reproducible.
5. **Heavy-hitter query + clean-stream impact** — ranks primary PAN distributors
   by exclusive downstream reach and quantifies current-vs-target PCI scope and
   risk reduction. RISE/APG de-tokenizers correctly remain in CDE.
6. **Killer finding** — surfaces systems BAM marks `PCI=No` that Splunk shows
   leaking clear PAN (hidden scope BAM misses).

Orchestrated as a **LangGraph** state machine (supervisor → ingest → validate →
graph → DAG → score → analyze → **human-in-the-loop gate** → report). Hybrid
Intelligence: deterministic code does all verifiable work; the LLM only narrates
already-computed, grounded numbers.

## Run
```
# backend
cd backend && pip install -r requirements.txt
make demo      # full agentic pipeline on sample_data/, prints audit + results   (or: python run_demo.py)
make test      # 13 V-checks incl. masking-leak + HITL interrupt/resume
make api       # FastAPI at :8000 — POST CSVs to /api/analyze ; docs at /docs

# frontend — two paths
#  (a) zero-setup demo:  open frontend/standalone.html in a browser (real data embedded)
#  (b) production SPA:    cd frontend-app && npm install && npm run dev   (proxies /api to :8000)
```
Upload any subset of DS1–DS6 in any order; the server identifies each by
filename/header signature. With the API running and an analysis done, the UI
auto-switches from the embedded snapshot to live data.

## Live LLM (optional — narration only)
Set these env vars to use any OpenAI-compatible provider; the model id stays in
config, never in source. Unset = fully-grounded offline explanation.
```
PCISENTINEL_LLM_BASE_URL   PCISENTINEL_LLM_API_KEY   PCISENTINEL_LLM_MODEL
```

## Edge-direction convention
`Parent App ID = From Application (Consumes)`, `Child App ID = To Application
(Provides)` → PAN flows provider→consumer, so the canonical edge is **Child →
Parent**. Out-reach therefore = "systems this one distributes PAN to." Flip in
`config.py` (`data_flow_edges`).

## Layout
```
backend/
  pci_sentinel/  config security schema ingest graph_build dag_transform
                 scoring analytics llm_client pipeline orchestrator(LangGraph)
  app.py  run_demo.py  tests/
frontend/         standalone.html  (zero-build demo) + snapshot.json
frontend-app/     Vite React 18 + D3 + Tailwind SPA (npm run build verified)
evidence/         analysis_snapshot.json  metrics.md  DEMO_SCRIPT.md
sample_data/      the 6 sample CSVs
```

## Honest scope
Current-state lineage + decision support only. Not remediation, not business-need
judgment, not real-time access. Inferred signals are labeled, never treated as
ground truth. BAM is authoritative; DS5/DS6 are signals.
