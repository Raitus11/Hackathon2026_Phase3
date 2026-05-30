# PCI-SENTINEL — 3-minute demo narrative

**0:00 — Problem (15s).** Enterprises pass cardholder data (PAN) system-to-system,
often in cycles, frequently to systems that don't even know they hold it. BAM is
the system of record but it's self-reported and incomplete. Where do you tokenize
to shrink PCI scope the most?

**0:15 — Upload (15s).** Drop the BAM extracts + Splunk/survey CSVs. The engine
masks every PAN on ingest (first-6/last-4); if one unmasked card number slips
through, the run fails by design. [show audit line: `validate_masking_leak clean=True`]

**0:30 — Overview (45s).** Four numbers a non-technical exec reads in 10 seconds:
- **95 systems** exposed to clear PAN today.
- **48 hidden-PCI systems** — flagged `PCI=No` in BAM but caught leaking clear PAN
  in Splunk logs. *This is the scope BAM misses.*
- **2 circular-dependency clusters** resolved into a clean DAG.
- **Top intervention: 8CCF.** Heavy-hitter table ranks the primary PAN distributors.

**1:15 — Data-flow graph (45s).** The DAG. Amber = PAN sources, red-ringed =
hidden PCI, blue = in-scope. **Solid edges = authoritative BAM metadata; dashed
amber = inferred from Splunk/survey** — the distinction is structural, not
cosmetic. Click the heavy hitter to trace its downstream blast radius.

**2:00 — Clean-stream impact (40s).** Tokenize PAN at the top true-sources →
recompute scope. Systems descope only when *all* their upstreams send CRN; systems
that genuinely need PAN stay in the CDE via RISE/APG de-tokenization (we model
that). Before/after bars show the surface reduction.

**2:40 — Differentiators (20s).** Hybrid Intelligence: deterministic graph math
does the verifiable work, the LLM only narrates grounded numbers. Every edge,
score, and recommendation traces to a source row, a rule, or a cited algorithm
(Tarjan 1972; Freeman 1977 / Brandes 2001). Honest about what it is — lineage and
decision support, not remediation.
