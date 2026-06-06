# PCI-SENTINEL — ≤3-minute demo narrative

> Numbers below are from the bundled `sample_data/`. They update automatically
> for any uploaded dataset; the *story beats* stay identical.

---

**0:00 — The problem (15s).**
Enterprises pass cardholder data (PAN) system-to-system — often in cycles, and
frequently to systems that don't even know they hold it. The business catalogue
(BAM) is the system of record, but it's self-reported, so it's incomplete. Two
questions decide your PCI audit cost: *which systems actually touch clear card
numbers*, and *where do you tokenize to shrink that scope the most?*

**0:15 — One sentence, the whole answer (15s).** *[land on Overview — the
verdict banner is the first thing on screen]*
"**48 systems are handling clear card numbers that BAM never flagged as PCI.**"
That's the headline. Everything else explains and acts on it.

**0:30 — Overview, four numbers an exec reads in ten seconds (35s).**
- **95 systems** in PCI scope — split honestly: **44 confirmed** by BAM metadata,
  **51 inferred-only** from survey/Splunk signals (kept separate, never claimed as fact).
- **48 hidden-PCI** — `PCI=No` in BAM, clear PAN in their Splunk logs.
- **2 cyclic clusters** resolved into a clean 233-node DAG.
- **Top intervention: 8CCF** — the highest-leverage single tokenization point.
The heavy-hitters table ranks distributors by **downstream reach**; "**solo
descope**" sits beside it and is near-zero for everyone — a deliberate, honest
signal that no single source frees much alone. Hold that thought.

**1:05 — Hidden Scope, the finding that matters most (40s).** *[click "see the evidence →"]*
This is unmanaged exposure no compliance program currently knows about. Of the 48,
**4 actively propagate** that PAN further downstream — those hide the most scope.
The **evidence ledger** gives every miss its proof: the Splunk finding and the
application owner's own stated source. And the punchline — *[point to 6CWC]* —
**the single widest PAN distributor in the whole estate, 6CWC, reaching 29
systems, is itself a BAM miss.** BAM says it isn't PCI. It's the biggest spreader
of it.

**1:45 — Planner, fewest moves for the most descope (35s).** *[Planner tab]*
Because the same downstream systems are fed by *several* PAN sources, the right
question isn't "which one source" — it's "which minimal *set*." A greedy
max-coverage optimizer (Nemhauser–Wolsey–Fisher 1978 — applied here as a
transparent heuristic, since the freed-systems objective is supermodular under
conjunctive true-source coverage, so the (1−1/e) bound does *not* hold) picks **8CCF, 8DFB, 8EFW**: tokenizing those **descopes 3 downstream
systems** and **converts 3 sources from live PAN (tier 4) to non-reversible tokens
(tier 3)**. The what-if simulator recomputes scope live as you toggle sources;
systems that genuinely need PAN stay in the CDE and de-tokenize via RISE/APG — we
model that, we don't pretend it disappears.

**2:20 — Graph + Drill-down, trace it to the row (30s).** *[Data-Flow Graph →
click 6CWC → Drill-down]*
**Solid edges = authoritative BAM metadata; dashed amber = inferred** — structural,
not cosmetic. Drill into 6CWC: zero upstream providers (a true source), scope basis
*inferred-only*, **Hidden PCI: YES — BAM miss**, and a PAN-lineage view that walks
every path back to its true source. Every claim traces to a row, a rule, or a
cited algorithm.

**2:50 — Why it wins (10s).**
**Hybrid Intelligence:** deterministic graph math does every verifiable step
(Tarjan SCC→DAG, transitive-closure reachability, Brandes betweenness, greedy
coverage); the LLM *only* narrates already-computed numbers — it can't invent one.
Human-gated, masking enforced on ingest (an unmasked PAN fails the run), honest
about being lineage and decision-support, not remediation. That's the system.

---

### One-line version (if cut to 60s)
"BAM misses 48 PCI systems — including the single biggest PAN distributor in the
estate. We find them from the data, prove each with its Splunk evidence, and compute
the fewest tokenization moves that shrink scope the most — with deterministic math a
judge can re-derive, and an LLM that only narrates, never decides."
