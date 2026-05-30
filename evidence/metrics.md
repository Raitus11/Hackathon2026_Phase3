# PCI-SENTINEL — Evidence / Key Metrics (sample data)

_Generated from the agentic pipeline run on the 6 sample CSVs._

## Headline
- **systems_exposed_to_clear_pan**: 95
- **hidden_pci_systems_bam_misses**: 48
- **cycle_clusters_resolved**: 2
- **top_intervention**: 8CCF
- **scope_reduction_if_top3_tokenized_pct**: 6.3

## Graph
- nodes: 239
- metadata_edges: 338
- metadata_edges_deduped: 234
- inferred_edges: 57
- unresolved_signals: 170
- pan_source_nodes: 72
- bam_nodes: 34
- self_loops: ['8AFN', '8AQB']

## DAG (from-graph → to-graph)
- source_nodes: 239
- source_edges: 283
- dag_nodes: 233
- dag_edges: 229
- cycle_clusters: 2
- nodes_in_cycles: 8
- is_acyclic: True

## Clean-stream impact (tokenize top-3 true sources)
- tokenized_systems: ['8CCF', '8DFB', '8EFW']
- scope_before: 95
- scope_after: 89
- nodes_descoped: 6
- retained_via_detokenization_count: 3
- pan_edges_before: 77
- pan_edges_after: 70
- risk_before: 2517.1
- risk_after: 2372.9
- risk_reduction_pct: 5.7
- node_surface_reduction_pct: 6.3

## Top heavy hitters (primary PAN distributors)

| System | Excl. reach | Reach | Out-deg | Risk |
|---|---|---|---|---|
| 8CCF | 2 | 28 | 3 | 53.53 |
| 8DFB | 2 | 2 | 1 | 50.25 |
| 8EFW | 2 | 1 | 1 | 40.13 |
| 6CWC | 1 | 29 | 7 | 33.66 |
| 8MEC | 1 | 27 | 1 | 53.4 |
| 8CCCM | 1 | 3 | 1 | 40.38 |
| 9CPC | 1 | 2 | 1 | 20.25 |
| 8FVE | 1 | 1 | 1 | 50.13 |
| 8LNQ | 1 | 1 | 1 | 40.13 |
| 6IVC | 1 | 1 | 1 | 30.13 |

## Pipeline audit (per-node timing)

- supervisor: 0.0 ms
- ingest: 8.6 ms
- validate_masking_leak: 4.7 ms
- build_graph: 3.7 ms
- condense_to_dag: 3.2 ms
- score: 12.9 ms
- analytics: 26.9 ms
- human_gate: 0.0 ms
- report: 0.0 ms

## Grounded explanation

Current state: 95 systems fall within PCI scope across 233 data-flow clusters; 2 circular dependency cluster(s) were resolved into the DAG. The highest-leverage true-source is 8CCF, which distributes PAN to 2 systems that depend on it exclusively. Tokenizing PAN at the recommended source(s) descopes 6 systems (6.3% of the in-scope surface) and lowers the aggregate risk score by 5.7% — the clean-stream effect.