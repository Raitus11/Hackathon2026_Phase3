# PCI-SENTINEL — scale benchmark (measured, not claimed)

Synthetic estates with the real data's structural character (small true-source
front, hub fan-out, dense convergence, cycles), timed through the **shipped** code
paths. Single process, commodity hardware; absolute numbers vary by machine —
the shape (near-linear in V+E for everything except sampled betweenness) is the claim.

## 5,000 systems · 13,120 flows · 83 PAN sources (83 true origins, 4,188 in scope)

| Stage | ms |
|---|---|
| flatten (Multi→Di) | 30 |
| true PAN origins (SCC pass) | 75 |
| scope (memoized reachability) | 20 |
| scoring (incl. betweenness, sampled at scale) | 877 |
| heavy hitters (top 10) | 145 |
| greedy plan (max_k=5, pool=15) | 1,305 |
| hidden-scope + ownership rollup | 41 |
| **end-to-end analytics core** | **2,492** |

## 20,000 systems · 51,861 flows · 333 PAN sources (333 true origins, 16,652 in scope)

| Stage | ms |
|---|---|
| flatten (Multi→Di) | 230 |
| true PAN origins (SCC pass) | 456 |
| scope (memoized reachability) | 97 |
| scoring (incl. betweenness, sampled at scale) | 9,985 |
| heavy hitters (top 10) | 834 |
| greedy plan (max_k=5, pool=15) | 20,645 |
| hidden-scope + ownership rollup | 396 |
| **end-to-end analytics core** | **32,644** |

## 40,000 systems · 103,573 flows · 666 PAN sources (666 true origins, 33,252 in scope)

| Stage | ms |
|---|---|
| flatten (Multi→Di) | 516 |
| true PAN origins (SCC pass) | 763 |
| scope (memoized reachability) | 181 |
| scoring (incl. betweenness, sampled at scale) | 32,611 |
| heavy hitters (top 10) | 2,236 |
| greedy plan (max_k=5, pool=15) | 89,039 |
| hidden-scope + ownership rollup | 938 |
| **end-to-end analytics core** | **126,283** |

## Reading the numbers

The estate-mapping core — flatten, Tarjan origin pass, memoized reachability scope,
hidden-scope, ownership — is **near-linear in V+E and stays sub-second at 40,000
systems**. Two stages are deliberately heavier and are run once per analysis, not per
interaction: composite scoring (dominated by betweenness; the engine switches to the
Brandes–Pich pivot-sampled estimator above ~600 nodes, which is what keeps 40k under
35 s) and the greedy tokenization plan (the supermodular set-cover step — its cost is
bounded by the candidate pool `candidate_k`, independent of estate size, and every
interactive surface reads its cached result). At the real estate's scale (~4,000
systems) the full pipeline is interactive; at 10× it is a batch step measured in
minutes, not hours.
