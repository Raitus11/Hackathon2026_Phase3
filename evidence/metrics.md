# PCI-SENTINEL — Key Metrics

_Generated from the live pipeline run on the provided datasets. Every figure below is reproducible from the source CSVs via the deterministic engine; the dashboard, PDF, and XLSX render the same grounded result._

## Scope
- **Systems exposed to clear PAN:** 95
  - Confirmed by authoritative BAM metadata: **44**
  - Inferred-only candidate scope (Splunk/survey signals, kept separate, never treated as ground truth): **51**
- **Hidden PCI — clear PAN in systems BAM flags PCI=No:** **48** (of which 4 propagate PAN further downstream)
- **Cycle clusters resolved into the DAG:** 2

## Graph
- Nodes: 239
- Metadata edges: 338 (deduped 234)
- Inferred edges (distinguished, source-tagged): 57
- True PAN-source nodes: 72
- DAG after Tarjan SCC condensation: 233 nodes / 229 edges (acyclic: True)

## Primary PAN distributors (heavy hitters, ranked by downstream reach)

| System | Downstream reach | Solo descope | Out-degree | Risk |
|---|---|---|---|---|
| 6CWC | 29 | 2 | 7 | 56.36 |
| 8CCF | 28 | 1 | 3 | 75.45 |
| 8MEC | 27 | 0 | 1 | 74.55 |
| 8DEM | 27 | 0 | 2 | 64.63 |
| 8AQB | 26 | 0 | 19 | 83.64 |
| 8BCC | 26 | 0 | 13 | 70.72 |
| 8AFN | 26 | 0 | 3 | 67.42 |
| 8BY | 26 | 0 | 2 | 63.92 |
| 8CCCM | 3 | 0 | 1 | 42.74 |
| 8DFB | 2 | 1 | 1 | 51.82 |

_Solo descope = systems freed if only that one source is tokenized. It is small everywhere because downstream systems are fed by several PAN sources simultaneously — which is exactly why a minimum-intervention set matters more than any single source._

## Tokenization leverage (minimum-intervention optimizer)
- Greedy max-marginal full-descope over the true PAN sources (transparent heuristic; the freed-systems objective is supermodular under conjunctive true-source coverage, so the (1−1/e) submodular guarantee does not apply and is not claimed).
- Tokenizing **3** source system(s) descopes **27** of 32 descopable systems (95 → 68 in PCI scope).
- Clean-stream impact of the recommended top-3 sources: descopes 27 systems (28.4% of the in-scope surface), aggregate exposure risk −17.9%.
- 3 system(s) genuinely need PAN and remain in the CDE, de-tokenizing via centralized RISE/APG services.

### Where the lift concentrates
Tokenizing the recommended source(s) removes **27** system(s) from scope. Because most downstream systems are fed by several PAN sources at once, the optimizer selects the minimum-intervention set rather than over-claiming any single source — and the broader value is **visibility and lineage**: the true scope the catalogue understates, the 48 hidden-PCI systems BAM misses, and the widest distributors (top: 6CWC) for prioritized intervention.

## Method & honest scope
- Risk R(v)∈[0,100] = 0.40·sensitivity-tier + 0.30·reachability (transitive closure, scaled to the widest distributor) + 0.20·betweenness centrality (Brandes 2001, scaled to the most-central system) + 0.10·true-source flag.
- Cycles in the BAM/ServiceNow relationships are resolved by Tarjan strongly-connected-component detection then condensation, yielding a provable DAG. The rule is explicit.
- Inferred edges (Splunk/survey) carry their source and are never merged with metadata edges.
- **What this does not do:** it does not remediate controls, assert business need, or execute tokenization. It maps current-state lineage and shows where intervention has the greatest lift.
- Card numbers are masked first-6/last-4 on ingest; an unmasked PAN fails the run.
