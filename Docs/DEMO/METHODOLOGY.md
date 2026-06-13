# PCI-SENTINEL — Methodology & Architecture

PCI-SENTINEL maps how cardholder data (PAN) flows across an enterprise's systems, identifies where that data originates, and quantifies what tokenizing each origin would remove from PCI-DSS audit scope. It is built on one principle we call **Hybrid Intelligence**: a deterministic graph engine performs every verifiable computation, and a language model is used only to narrate the numbers that engine has already produced. Nothing the system reports as a fact is invented by an LLM — every score, edge, and recommendation traces back to a rule, a graph operation, or a cited algorithm.

That separation is not cosmetic. It is what lets the output survive expert scrutiny: a reviewer can re-derive any number by hand, and the same inputs always produce the same result.

---

## 1. Architecture

![System architecture](architecture.svg)

**Inputs.** The system distinguishes two classes of input and never conflates them. The four BAM extracts (DS1–DS4) are the authoritative system of record — they define which systems exist and the documented data-flow relationships between them. The two supplemental feeds, the CDE end-state survey (DS5) and the Splunk clear-PAN findings (DS6), are treated as *signals only*: they can surface a candidate that BAM missed, but they are rendered distinctly throughout and are never silently promoted to ground truth.

**The agent pipeline is the core of the system.** Work is decomposed into nine single-responsibility agents wired together as an explicit, checkpointed LangGraph state machine. Each agent owns one job, has typed inputs and outputs, and emits an audit line so the agentic structure and run cost are visible end to end. Critically, the agents are colour-coded by what they actually do:

- The **Supervisor** (control) owns graph state, routing, and retries — it is the agent that drives every other agent.
- The **deterministic engine** is six agents doing verifiable, reproducible work with no black box: ingestion and PAN masking, the masking-leak validator, the graph builder, the cycle resolver, the quant/scoring agent, and the core analyst.
- The **Human-in-the-Loop Gate** genuinely pauses the run for a reviewer to approve, revise, or abort before anything is reported.
- The **Reporter** is the *only* step that uses an LLM, and it is constrained to narrating the already-computed numbers. It explains; it never decides.

Eight of the nine agents are deterministic. This is the concrete form of the Hybrid-Intelligence claim, and it is enforced by the architecture rather than asserted in a slide.

**Delivery.** Results are served by an async FastAPI service with typed Pydantic contracts, consumed by a React 18 + D3 frontend (thirteen analyst views), and packaged as a PDF executive report and an XLSX workbook with a charted dashboard, plus a metrics-and-audit evidence bundle for reproducibility.

**Cross-cutting guarantees** apply at every stage: the run *fails hard* if any unmasked PAN is ever detected, each stage writes an audit record, metadata-versus-inferred provenance is preserved throughout, and the LLM sits behind a config-swappable client so there is no vendor lock-in.

---

## 2. Process flow

![Process flow](process_flow.svg)

The pipeline runs as nine explicit LangGraph stages. Because state is checkpointed at every step, the run is **resumable** — a paused or interrupted run continues from where it stopped rather than recomputing from scratch.

1. **Supervisor** initializes run context, routing, and the audit trail.
2. **Ingest & Sanitise** loads the CSV exports, validates their schema, and masks PAN to first-6/last-4 *at the boundary* — nothing unmasked passes downstream.
3. **Validate (masking leak)** is the first safety gate: a Luhn-plus-pattern scan of every ingested cell. Any unmasked PAN aborts the entire run.
4. **Build Graph** constructs the system interdependency graph of PAN flow as a typed MultiDiGraph, keeping metadata (BAM) and inferred (survey/Splunk) edges separate.
5. **Condense to DAG** finds circular dependencies with Tarjan's strongly-connected-components algorithm and condenses each cycle into a super-node, so lineage becomes a valid directed acyclic graph.
6. **Score (Quant)** assigns every system a bounded composite risk score (Section 3).
7. **Analyze (Core)** computes PCI scope, the heavy-hitter distributors, the clean-stream tokenization impact, and the hidden-PCI findings, and shapes them into the contracts the UI consumes.
8. **Human-in-the-Loop Gate** pauses for a reviewer. Approve sends the run to the Reporter; *revise* loops back to Analyze with reviewer feedback; abort halts safely.
9. **Report** uses the LLM to narrate the computed findings in plain language and emits the PDF, XLSX, and UI JSON.

There are exactly **two branch points**, and both are deliberate: the masking-leak validator can abort on a safety failure, and the human gate can approve, loop back, or abort. Everything else is a straight, deterministic path.

---

## 3. Risk score — calculation logic

![Risk model](risk_model.svg)

Each system receives a composite exposure score on a 0–100 scale:

> **R(v) = 100 × ( 0.40·S + 0.30·R + 0.20·B + 0.10·T )**

It is a weighted sum of four normalized factors, each individually defensible:

- **S — Sensitivity (weight 0.40).** `sensitivity_tier / 4`. What cardholder data the system declares, from BAM/DS4: tier 4 for untokenized PAN, track data, PIN, or a detokenization service; tier 3 for CRN-only / PCI-connected; tier 2 for inferred PAN from the DS6 signal. This follows the PCI-DSS ordering of how decisive each data element is, which is why it carries the largest weight.
- **R — Reach (weight 0.30).** `|descendants(v)| / max_reach`. The downstream blast radius: how many systems v can propagate PAN to, via the transitive closure of the data-flow graph. It is scaled to the most-reaching system so that "the widest distributor" carries the full reach weight relative to the actual estate.
- **B — Betweenness (weight 0.20).** `betweenness(v) / max_betweenness`. The conduit role — how many shortest PAN paths route through v — which captures choke-points that raw reach misses. It is exact on small graphs and uses pivot-sampled betweenness (k = 400, fixed seed) above 600 nodes so scoring stays sub-second at enterprise scale.
- **T — True-source flag (weight 0.10).** 1 if v has in-degree 0 in the data-flow graph and originates PAN, else 0. True sources are where tokenization produces the clean-stream effect, so this is a small but decisive tie-breaker toward where intervention has leverage.

**Why max-scaling.** Each varying factor is scaled to its observed maximum rather than divided by (N−1). Without this, reach on a large estate occupies only a tiny sub-range and a nominal 0.30 weight would move the score by a couple of points at most. Max-scaling makes the published weights reflect real influence on the result.

**Worked example (verifies against the shipped number).** For system **8MEC**, a tier-4 true PAN source:

```
S = 4/4               = 1.000   → 0.40 × 1.000 = 0.400
R = 27 / 33           = 0.818   → 0.30 × 0.818 = 0.245
B = betweenness norm  = 0.000   → 0.20 × 0.000 = 0.000
T = true source       = 1       → 0.10 × 1     = 0.100
R(8MEC) = 100 × (0.400 + 0.245 + 0.000 + 0.100) = 74.55
```

That equals the score the system actually reports for 8MEC — the arithmetic is fully transparent and checkable.

**Why it is defensible.** The weights are configurable (they sum to 1.0 and can be overridden via environment for tuning), but the ranking is **structural, not tuned**: re-running with different weights leaves the ordering essentially unchanged (a weight-sensitivity correlation of ρ ≈ 1.00), because the order is driven by the graph rather than fitted to a desired answer. Every term is named, bounded, and cited (Freeman 1977 and Brandes 2001 for betweenness, Brandes & Pich 2007 for the unbiased sampled estimator, PCI-DSS for the data-element ordering, Tarjan for the cycle resolver), the four factor values are exposed per system for audit, and the computation is deterministic.

---

## 4. What the system claims — and what it does not

PCI-SENTINEL presents current-state PCI data-flow lineage from BAM (authoritative) plus clearly-marked inferred signals, with cycle resolution and a reproducible risk model. It does **not** remediate controls, assert business need, or treat inferred signals as ground truth. Card numbers are masked first-6/last-4 on ingest, and an unmasked PAN fails the run. Where Splunk findings are shown, absence of a finding is not treated as proof a system is clean — the feed lists observations, not a comprehensive sweep. This honesty boundary is deliberate: the value is in a defensible map of where cardholder data really flows, not in over-claiming.
