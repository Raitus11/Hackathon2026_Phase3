# PCI-SENTINEL — Solution Overview

## The problem

Large enterprises must prove, to a PCI DSS assessor, exactly which systems touch
cardholder data. The trouble is that the authoritative business catalogue (BAM, a
ServiceNow system of record) is **self-reported and therefore incomplete**: some
systems that handle real card numbers were never flagged as PCI, and the way card
data *flows* between systems is not captured anywhere in one place. Audit scope is
consequently larger, fuzzier, and more expensive than it needs to be.

PCI-SENTINEL answers four questions an assessment team actually has:

1. **What is really in scope?** Map how the Primary Account Number (PAN) flows across
   systems and compute the true cardholder-data environment, not just what BAM declares.
2. **What did the catalogue miss?** Find systems handling clear PAN that BAM never
   flagged as PCI — *hidden scope*.
3. **Where does tokenization pay off most?** Identify the upstream "true sources" of PAN
   whose tokenization (PAN → CRN) cascades downstream and removes systems from scope —
   the **clean-stream effect**.
4. **What is it worth?** Translate scope reduction into assessor-effort and cost terms,
   and into a posture change (full Report on Compliance vs a lighter self-assessment).

## The data

Six inputs, split by trust level:

| | Dataset | Role |
|---|---|---|
| **Authoritative (BAM)** | DS1 PCI↔PCI deps · DS2 downstream deps · DS3 upstream deps · DS4 cardholder-data attributes | the system of record — `metadata` |
| **Signals only** | DS5 CDE end-state survey · DS6 PCI=No apps with PAN seen in Splunk logs | leads, not truth — `inferred` |

BAM is treated as ground truth. DS5/DS6 are treated strictly as signals: the edges and
scope they imply are kept **provenance-distinct** at every layer (data, graph, chart,
report) and are never silently merged into the authoritative picture. No system or
relationship is ever invented beyond what the data states.

## The core ideas

### 1. A provenance-typed data-flow graph
Every system is a node; every "PAN flows from A to B" is a directed edge (provider →
consumer). Each edge is labeled `metadata` (from DS1–DS4) or `inferred` (from DS5–DS6).
This distinction is first-class — it is what lets the tool be both *complete* (it shows
the signals) and *honest* (it never passes a signal off as a fact).

### 2. Honest cycle resolution
Real dependency data contains cycles (self-references, mutual "depends-on/used-by"
links), so the raw graph is **not** acyclic. Rather than hand-wave them away, the engine
applies Tarjan strongly-connected-component detection and condenses each cycle into a
single super-node — a transformation that is provably acyclic and fully auditable: every
collapsed cycle keeps its member systems and internal edges as inspectable detail.

### 3. Defensible, interpretable scoring
Each system gets a composite exposure score `R(v) ∈ [0,100]` from four named, bounded
factors — data sensitivity, downstream reach, betweenness centrality, and whether it is
a true PAN source. There are no magic constants: every weight is documented, tunable, and
sums to 1.0, and every factor traces to an established method (see `architecture.md`).

### 4. Hidden scope — the headline finding
By reconciling what BAM *declares* against what Splunk *observes*, the engine surfaces
systems carrying clear PAN that the catalogue flagged `PCI = No`. These are unmanaged
exposure — scope no compliance program currently knows about — and the ones that also
propagate PAN downstream are ranked first, because they hide the most scope.

### 5. The clean-stream effect and the minimal intervention set
Tokenizing a *true source* (where PAN originates) replaces live PAN with a
non-reversible Card Reference Number (CRN) for everything it feeds. A downstream system
leaves scope only when **every** clear-PAN source reaching it emits CRN — a conjunctive
condition. The engine computes:
- per-source exposure impact and the systems each source exclusively feeds,
- a **minimum-intervention plan** (greedy maximum-coverage), and
- a **certified-optimal tokenization frontier** solved to proven optimality, with the
  greedy optimality gap quantified.

It also states an honest caveat that many tools would gloss over: because descope is
conjunctive, marginal returns *increase* as the source front is covered, so the freed-
systems objective is **supermodular, not submodular** — the classic `(1 − 1/e)` greedy
guarantee does not apply here. Greedy is therefore presented as a transparent heuristic
alongside the certified-optimal answer and the saturation curve, not dressed up with a
guarantee it doesn't have.

### 6. Scope economics
Scope counts are translated into labeled, assumption-driven estimates: assessor-days for
CDE and connected-to systems, an indicative cost, and whether crossing a threshold moves
the posture from a full Report on Compliance to a lighter self-assessment. Every figure
is shown with its assumptions and is never presented as an organization's real numbers.

## What a reviewer sees

The dashboard leads with a plain-English headline triad — **declared vs. actual vs.
hidden** PAN-carrying systems — then lets the reviewer drill in:

- **Overview / Business View** — the scope picture and the "what to do next" actions.
- **Hidden Scope** — the BAM misses, each with its Splunk evidence and PCI DSS gap.
- **Flow Graph / Drill-down / Exposure Map** — lineage with `metadata` vs `inferred`
  edges visibly distinguished, a per-system "why in scope" trace, and a scale-proof
  exposure heatmap.
- **Planner / Block & Benefit / Roadmap** — the tokenization plan, source-vs-source
  comparison, the saturation curve, and a migration sequence.
- **Methods** — the scoring model, risk-weight sensitivity analysis, and algorithm
  citations.
- **Ask** — grounded Q&A over the computed results.

Exports (PDF executive report, XLSX data pack) carry the same numbers as the UI.

## Why the approach is trustworthy

- **Hybrid Intelligence.** Every measured number comes from deterministic graph
  algorithms and classical statistics. The language model only narrates figures it never
  computed; on most deployments it does not write at all (deterministic templates with
  identical numbers). Analysis cannot hang on a network call or hallucinate a metric.
- **Auditability.** Each pipeline stage emits an audit line; every classification, score,
  and recommendation traces back to a rule, a statistic, or a cited standard.
- **Safety.** PAN is masked first-6/last-4 on ingest; an unmasked PAN past that boundary
  fails the run outright.
- **Human-in-the-loop.** A real approval gate pauses the run between analysis and
  reporting, so a person approves, revises, or aborts before anything is published.

## What it claims — and what it does not

**Claims:** a current-state PCI data-flow lineage from BAM (authoritative) plus
clearly-marked inferred signals, with explicit cycle resolution and a reproducible,
defensible risk and scope-reduction model.

**Does not claim:** to remediate controls, to assert business need, or to treat inferred
signals as ground truth. Inferred scope is always shown separately from
metadata-confirmed scope; cost figures are labeled estimates; and the tool reports the
honest optimization result rather than an inflated one.
