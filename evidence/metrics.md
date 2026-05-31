# PCI-SENTINEL — Evidence / Key Metrics (sample data)

_Regenerated from the agentic pipeline run on the 6 sample CSVs._

## Headline
- **systems_exposed_to_clear_pan**: 95
- **scope_metadata_confirmed / inferred_only**: 44 / 51
- **hidden_pci_systems_bam_misses**: 48
- **hidden_propagating_count**: 4
- **cycle_clusters_resolved**: 2
- **top_intervention (best single lever)**: 8CCF
- **widest_distributor (by reach)**: 6CWC (reach 29)
- **node_surface_reduction_if_top3_tokenized_pct**: 3.2

## DAG (from-graph -> to-graph)
- source_nodes: 239
- source_edges: 283
- dag_nodes: 233
- dag_edges: 229
- cycle_clusters: 2
- nodes_in_cycles: 8
- is_acyclic: True

## Clean-stream impact (tokenize recommended top-3 sources)
- tokenized_levers: ['8CCF', '8DFB', '8EFW']
- scope_before -> scope_after: 95 -> 92
- nodes_descoped (downstream): 3
- sources_downgraded tier4->3: 3 ['8CCF', '8DFB', '8EFW']
- retained_via_detokenization (stay in CDE via RISE/APG): 3
- node_surface_reduction_pct: 3.2
- risk_reduction_pct: 1.1

## Minimum-intervention plan (greedy max-coverage; NWF 1978)
- plan: ['8CCF', '8DFB', '8EFW']  (k=3)
- total_descoped of descopable: 3 of 71  (95->92 in scope)

## Top heavy hitters (ranked by downstream reach)

| System | Reach | Solo descope | Out-deg | Risk |
|---|---|---|---|---|
| 6CWC | 29 | 0 | 7 | 56.36 |
| 8CCF | 28 | 1 | 3 | 75.45 |
| 8MEC | 27 | 0 | 1 | 74.55 |
| 8DEM | 27 | 0 | 2 | 64.63 |
| 8AQB | 26 | 0 | 19 | 83.64 |
| 8BCC | 26 | 0 | 13 | 70.72 |
| 8AFN | 26 | 0 | 3 | 67.42 |
| 8BY | 26 | 0 | 2 | 63.92 |
| 8CCCM | 3 | 0 | 1 | 42.74 |
| 8DFB | 2 | 1 | 1 | 51.82 |

## Hidden-scope evidence (propagating BAM misses)

| System | Propagates to | Stated source | Finding |
|---|---|---|---|
| 6CWC | 29 | KTCZP | True PAN |
| 9CPC | 2 | EC | True PAN |
| 6IVC | 1 | 8BRC | True PAN |
| JSVCH | 1 | — | True PAN |

## Pipeline audit (per-node timing)

- ingest: 11.2 ms
- validate_masking_leak: 6.0 ms
- build_graph: 4.2 ms
- condense_to_dag: 5.0 ms
- score: 16.4 ms
- analytics: 108.8 ms

## Grounded explanation

Current state: 95 systems fall within PCI scope across 233 data-flow clusters; 2 circular dependency cluster(s) were resolved into the DAG. Of these, 44 are confirmed by authoritative BAM metadata and 51 are inferred-only candidate scope surfaced from survey/Splunk signals (kept separate, never treated as ground truth). The widest PAN distributor is 6CWC, reaching 29 downstream systems; the highest-leverage single tokenization target is 8CCF. Because the same downstream systems are fed by several PAN sources, no single source frees many on its own — so the optimizer selects the minimal set. Tokenizing the recommended source(s) descopes 3 systems (3.2% of the in-scope surface), converts 3 source(s) from live PAN to non-transactable tokens, and lowers the aggregate risk score by 1.1% — the clean-stream effect.
