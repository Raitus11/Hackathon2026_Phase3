# PCI-SENTINEL
**Intelligent Mapping of Interdependencies Across PCI Systems** — an explainable,
upload-driven engine that maps how cardholder data (PAN) flows across enterprise
systems, finds the scope the business catalogue misses, and computes where
tokenization most reduces PCI scope.

## What it does
1. **Ingest & sanitise** the BAM + supplemental CSVs (upload-driven; auto-detects
   which dataset is which by header/filename signature). PAN is masked
   first-6/last-4 on entry; an unmasked, Luhn-valid PAN past this boundary
   **fails the run**.
2. **Provenance-typed data-flow graph** — `metadata` edges (DS1/DS2/DS3,
   authoritative BAM) are kept first-class-distinct from `inferred` edges (DS5
   survey / DS6 Splunk, signals only). Inferred edges carry their source label and
   are never merged with metadata. No systems or edges are invented beyond the data.
3. **From-graph → to-graph** — the cyclic source graph is condensed into a verified
   **DAG** via Tarjan SCC detection + condensation; every cycle is preserved as an
   auditable super-node, so cycle resolution is explicit and explainable.
4. **Defensible scoring** — `R(v) ∈ [0,100] = 0.40·sensitivity + 0.30·reach +
   0.20·betweenness (Brandes 2001) + 0.10·true-source`. Every term is named,
   bounded, config-tunable, and reproducible — no magic constants.
5. **Heavy-hitter analysis (two honest axes).** Distributors are ranked by
   **downstream reach** (the organizer's definition — how many systems each feeds
   clear PAN). Alongside, **solo descope** (exclusive reach via set difference) is
   reported: the systems freed if *only* that source is tokenized. It is small for
   everyone because downstream systems are fed by several PAN sources — which is
   exactly why the minimal *set* matters more than any single source.
6. **Minimum-intervention planner.** A greedy maximum-coverage optimizer
   (Nemhauser–Wolsey–Fisher 1978; provably within (1−1/e) of optimal on this
   monotone submodular objective) finds the fewest sources to tokenize for the most
   descope. **Clean-stream model:** a downstream system descopes only when *every*
   clear-PAN source reaching it emits CRN; a tokenized source itself stays in the
   CDE as a tokenization point but drops from live PAN (tier 4) to non-reversible
   token (tier 3); systems that genuinely need PAN remain in the CDE and
   de-tokenize via centralized RISE/APG. The what-if simulator recomputes scope and
   downstream safety live.
7. **Hidden scope — the killer finding.** Systems BAM marks `PCI=No` that Splunk
   shows leaking clear PAN. Each is presented with an **evidence ledger** (the
   Splunk finding, the owner's stated source, and how far the leaked PAN
   propagates). In the sample data this surfaces **48** misses — **4 of which
   actively propagate**, including the single widest PAN distributor in the estate.

Orchestrated as a **LangGraph** state machine (supervisor → ingest → validate →
graph → DAG → score → analyze → **human-in-the-loop gate** → report). **Hybrid
Intelligence:** deterministic code does all verifiable work; the LLM only narrates
already-computed, grounded numbers — it cannot invent one.

## The UI (8 views)
A persistent **verdict banner** leads every analytical tab with the one-sentence
answer. **Pipeline** (agentic run + masking gate) · **Overview** (KPIs,
clean-stream impact, heavy hitters, prioritization quadrant) · **Hidden Scope**
(evidence ledger of BAM misses) · **Planner** (minimum-intervention roadmap +
what-if) · **Data-Flow Graph** (PAN-flow / heavy-hitter / all-systems views;
metadata vs inferred edges visually distinct) · **Drill-down** (per-system risk,
scope basis, PAN lineage, providers/consumers) · **Methods** (every algorithm with
citation) · **Ask** (grounded Q&A — deterministic for common questions, LLM
constrained to computed facts otherwise).

## Run
```
# backend
cd backend && pip install -r requirements.txt
make demo      # full agentic pipeline on sample_data/, prints audit + results   (or: python run_demo.py)
make test      # 20 V-checks: masking-leak, HITL interrupt/resume, scoring + descope invariants
make api       # FastAPI at :8000 — POST CSVs to /api/analyze ; docs at /docs

# frontend — two paths
#  (a) zero-setup demo:  open frontend/standalone.html in a browser (real data embedded)
#  (b) production SPA:    cd frontend-app && npm install && npm run dev   (proxies /api to :8000)
```
Upload any subset of DS1–DS6 in any order; the server identifies each by
filename/header signature. With the API running and an analysis done, the UI
auto-switches from the embedded snapshot to live data, and the PDF/XLSX export
buttons appear.

## Exports
- **Executive PDF** — KPIs, grounded summary, tokenization roadmap, heavy hitters,
  hidden-PCI list, methods. For leadership.
- **Data XLSX** — Summary, Systems, HeavyHitters, **HiddenPCI_Evidence** (system ·
  name · propagates-to · stated source · BAM flag · Splunk finding), and the
  TokenizationPlan. For analysts and auditors.

## Live LLM (optional — narration only)
Set these to use any OpenAI-compatible provider; the model id lives in config,
never in source. Unset = fully-grounded offline explanation (deterministic template).
```
PCISENTINEL_LLM_BASE_URL   PCISENTINEL_LLM_API_KEY   PCISENTINEL_LLM_MODEL
```

## Edge-direction convention
`Parent App ID = From Application (Consumes)`, `Child App ID = To Application
(Provides)` → PAN flows provider→consumer, so the canonical edge is **Child →
Parent**. Downstream reach therefore = "systems this one distributes PAN to." Flip
in `config.py` (`data_flow_edges`).

## Layout
```
backend/
  pci_sentinel/  config security schema ingest graph_build dag_transform
                 scoring analytics llm_client pipeline orchestrator(LangGraph)
                 agents chat reporting
  app.py  run_demo.py  build_snapshot.py  tests/
frontend/         standalone.html  (zero-build demo) + snapshot.json
frontend-app/     Vite React 18 + D3 + Tailwind SPA (npm run build verified)
evidence/         analysis_snapshot.json  metrics.md  DEMO_SCRIPT.md
sample_data/      the 6 sample CSVs + data dictionary
```

## Honest scope
Current-state lineage + decision support only. **Not** remediation, **not**
business-need judgment, **not** real-time access. Inferred signals are labeled and
never treated as ground truth — BAM is authoritative; DS5/DS6 are signals. Card
numbers are masked first-6/last-4 on ingest; an unmasked PAN fails the run.
