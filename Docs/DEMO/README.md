# PCI-SENTINEL

**Intelligent Mapping of Interdependencies Across PCI Systems** — an explainable,
upload-driven engine that maps how cardholder data (PAN) flows across enterprise
systems, surfaces the scope the business catalogue never recorded, and computes
where tokenization most reduces PCI DSS audit scope.

The design philosophy is **Hybrid Intelligence**: a deterministic graph engine does
every measured, verifiable computation; a language model is used *only* to narrate
numbers it never computes. Nothing in the analysis depends on a network call, and the
system can neither hang nor hallucinate a figure.

> Companion docs: [`solutionoverview.md`](solutionoverview.md) (what & why),
> [`architecture.md`](architecture.md) (how it's built),
> [`processflow.md`](processflow.md) (what happens at runtime).

---

## What it does

1. **Ingest & sanitise** the BAM + supplemental CSVs (auto-detects which dataset is
   which by header/filename signature). PAN is masked first-6/last-4 on entry; an
   unmasked, Luhn-valid PAN past this boundary **fails the run**.
2. **Build a provenance-typed data-flow graph** — `metadata` edges (DS1/DS2/DS3,
   authoritative BAM) are kept first-class-distinct from `inferred` edges (DS5 survey /
   DS6 Splunk, signals only). No systems or relationships are invented beyond the data.
3. **Condense to a DAG** — the cyclic source graph is resolved with Tarjan
   strongly-connected-component detection and condensation; every cycle is preserved as
   an auditable super-node, and acyclicity of the result is asserted.
4. **Score** every system with a defensible composite risk `R(v) ∈ [0,100]`.
5. **Analyse** PCI scope, heavy-hitter distributors, the clean-stream tokenization
   impact, hidden (BAM-missed) scope, audit-cost economics, and a certified-optimal
   tokenization frontier.
6. **Gate, then narrate** — a human-in-the-loop approval gate sits between analysis and
   reporting; the LLM only explains the already-computed, grounded results.

---

## Quickstart

### Prerequisites
- Python 3.13
- Node 18+ (only for the React dev server; the engine runs without it)

### Backend
```bash
make install                      # pip install -r backend/requirements.txt
make demo                         # headless run over sample_data/, prints a summary
make api                          # uvicorn app:app on :8000 (OpenAPI docs at /docs)
make test                         # pytest suite (incl. the masking-leak safety check)
```
Equivalently, by hand:
```bash
cd backend
pip install -r requirements.txt
PYTHONPATH=. python3 run_demo.py            # one-command demo
PYTHONPATH=. uvicorn app:app --reload --port 8000
PYTHONPATH=. python3 -m pytest -q
```

### Frontend
```bash
cd frontend-app
npm install
npm run dev                       # Vite dev server on :5173, proxies /api -> :8000
```
The UI also runs fully offline against an embedded snapshot (`src/snapshot.json`), so
the dashboard renders even with no backend running. A dependency-free fallback
(`frontend/standalone.html`) is provided for locked environments.

---

## Configuration (environment variables)

Everything tunable lives in `backend/pci_sentinel/config.py` or the environment — no
inference-provider name, model id, or magic constant is hard-coded in source.

### LLM backend (narration only)
| Variable | Purpose |
|---|---|
| `PCISENTINEL_LLM_BACKEND` | `offline` \| `http` \| `sdk` (default: auto) |
| `PCISENTINEL_LLM_MODEL` | model identifier (kept in env, never in source) |
| `PCISENTINEL_LLM_BASE_URL` / `PCISENTINEL_LLM_API_KEY` | for the `http` (OpenAI-compatible) backend |
| `PCISENTINEL_LLM_SDK_MODULE` / `PCISENTINEL_LLM_SDK_CLASS` | for the `sdk` (enterprise-gateway) backend |

The model is allowed to *generate* text only on the `sdk` backend; every other backend
returns deterministic, fully-grounded templates with identical numbers. If the chosen
backend is unavailable, the client silently degrades to `offline` so a run never breaks.

### Risk-score weights (must sum to 1.0)
| Variable | Default |
|---|---|
| `PCISENTINEL_W_SENSITIVITY` | 0.40 |
| `PCISENTINEL_W_REACH` | 0.30 |
| `PCISENTINEL_W_BETWEENNESS` | 0.20 |
| `PCISENTINEL_W_SOURCE` | 0.10 |

### Audit-cost model (labeled estimates, surfaced on screen)
| Variable | Default |
|---|---|
| `PCISENTINEL_QSA_DAY_RATE` | 2500 |
| `PCISENTINEL_DAYS_PER_CDE` | 0.5 |
| `PCISENTINEL_DAYS_PER_CONN` | 0.15 |
| `PCISENTINEL_ROC_THRESHOLD` | 1000 |

Place secrets in `backend/.env` (git-ignored); it is auto-loaded at import time.

---

## Repository layout

```
pci-sentinel/
├─ backend/
│  ├─ app.py                      FastAPI surface (upload, gate, views, reports, chat)
│  ├─ run_demo.py                 one-command headless pipeline run
│  ├─ build_snapshot.py           regenerate the UI JSON snapshot
│  ├─ build_evidence.py           regenerate PDF / XLSX / metrics evidence bundle
│  ├─ requirements.txt
│  ├─ tests/test_core.py          unit + integration + masking-leak safety tests
│  └─ pci_sentinel/               the deterministic engine
│     ├─ orchestrator.py          LangGraph StateGraph + human gate + resume
│     ├─ pipeline.py              linear spine + finalize() (assembles RunResult)
│     ├─ ingest.py                CSV load, dataset detection, PAN masking
│     ├─ schema.py                header normalization + dataset signatures
│     ├─ security.py              Luhn, mask first-6/last-4, leak scanner
│     ├─ graph_build.py           provenance-typed MultiDiGraph builder
│     ├─ dag_transform.py         Tarjan SCC → condensation → DAG
│     ├─ scoring.py               composite risk model R(v)
│     ├─ analytics.py             scope, heavy hitters, impact, economics, hidden scope
│     ├─ optimize.py              certified-optimal frontier + min-cut segmentation
│     ├─ llm_client.py            generic LLMClient (offline / http / sdk)
│     ├─ narrate.py               grounded AI decision memo
│     ├─ chat.py                  grounded Q&A
│     ├─ reporting.py             PDF + XLSX builders
│     ├─ report_charts.py         matplotlib business figures
│     ├─ pci_requirements.py      PCI DSS v4 requirement-family mapping
│     ├─ scoring.py / config.py   weights, tiers, cost model, provenance labels
│     └─ agents.py                agent roster the UI renders
├─ frontend-app/                  React 18 + Vite + Tailwind + D3 (single App.jsx)
├─ frontend/                      standalone.html + snapshot fallback
├─ sample_data/                   DS1–DS6 sample CSVs
├─ evidence/                      generated report / metrics artifacts
├─ Docs/                          methodology notes, diagrams
└─ Makefile
```

---

## Inputs

| Dataset | Contents | Provenance |
|---|---|---|
| **DS1** | PCI↔PCI dependencies | authoritative (`metadata`) |
| **DS2** | downstream dependencies of PCI apps | authoritative (`metadata`) |
| **DS3** | upstream dependencies of PCI apps | authoritative (`metadata`) |
| **DS4** | BAM report — all apps with cardholder-data attributes | authoritative (`metadata`) |
| **DS5** | CDE end-state survey responses | signal (`inferred`) |
| **DS6** | PCI=No apps with PAN observed in Splunk logs | signal (`inferred`) |

BAM (DS1–DS4) is the system of record; DS5/DS6 are treated strictly as signals and
their derived edges are visually and structurally distinguished, never merged into the
authoritative graph.

---

## Key API endpoints

| Method & path | Purpose |
|---|---|
| `POST /api/analyze` | upload CSVs and run (`?require_approval=true` pauses at the gate) |
| `POST /api/approve` | resume a paused run (`approve` / `revise` / `abort`) |
| `GET /api/headline` | the executive headline + hidden-scope + scope split |
| `GET /api/graph` | the node/edge/DAG payload the D3 views consume |
| `GET /api/heavy-hitters`, `/api/impact`, `/api/structure` | analysis views |
| `GET /api/plan`, `/api/decision-memo` | tokenization plan + grounded memo |
| `POST /api/whatif`, `/api/onboard` | tokenize-set simulation; pre-onboarding assessment |
| `GET /api/report/pdf`, `/api/report/xlsx` | downloadable executive report + data pack |
| `POST /api/chat`, `GET /api/suggested` | grounded Q&A over the latest run |
| `GET /api/agents`, `/health` | agent roster; service + LLM-mode health |

Interactive OpenAPI docs are served at `/docs` when the API is running.

---

## Data-handling rules (inviolable)

- Raw PAN/CVV is never stored, logged, echoed, or displayed. PAN is masked
  first-6/last-4 (PCI-DSS 3.4) on ingest.
- An unmasked, Luhn-valid (ISO/IEC 7812) PAN detected past the ingestion boundary
  **fails the entire run** (`PanLeakError`).
- No systems or edges are invented beyond the data; a supplemental token becomes an
  edge only if it resolves to a node already known from the authoritative universe.
- The git-ignored `backend/.env` holds the only deployment identity; no provider,
  vendor, or model name appears in shipped source.

---

## Tech stack

- **Backend:** Python 3.13 · FastAPI · LangGraph (StateGraph + checkpointing + human
  interrupt) · networkx · numpy · matplotlib · reportlab · openpyxl · pydantic
- **Frontend:** React 18 · Vite · Tailwind · D3
- **Method foundations:** Tarjan 1972 (SCC) · Freeman 1977 / Brandes 2001 / Brandes &
  Pich 2007 (betweenness) · Nemhauser–Wolsey–Fisher 1978 (greedy coverage) · Menger
  (max-flow/min-cut segmentation)
