"""Scale benchmark — measured evidence for the enterprise-scalability claim.

Generates synthetic estates with the same structural character as the real data
(a small true-source front with hub-like fan-out, deep relay chains, dense
convergence) at increasing node counts, then times the SHIPPED code paths — the
exact functions the product calls, not simplified stand-ins. Writes
../evidence/scale_benchmark.md.

Run from backend/:  python bench_scale.py [N ...]     (default: 5000 20000 40000)
"""
import random
import sys
import time

import networkx as nx

sys.path.insert(0, ".")
from pci_sentinel import analytics                       # noqa: E402
from pci_sentinel.scoring import compute_scores          # noqa: E402


def synth_estate(n_nodes: int, n_sources: int = None, seed: int = 7):
    """Hub-heavy random DAG-ish flow graph: sources fan out widely, relays chain,
    ~2.5 edges/node, a couple of cycles to exercise the SCC path."""
    rng = random.Random(seed)
    n_sources = n_sources or max(8, n_nodes // 60)
    G = nx.MultiDiGraph()
    ids = [f"S{i:05d}" for i in range(n_nodes)]
    sources = ids[:n_sources]
    for i, x in enumerate(ids):
        G.add_node(x, carries_pan=(i < n_sources), pci_flag=True, detokenizes=False,
                   full_track=False, pin=False, pan_in_logs_observed=False,
                   sensitivity_tier=4 if i < n_sources else 3,
                   app_name="", line_of_business="")
    # hub fan-out from sources
    for s in sources:
        for _ in range(rng.randint(15, 60)):
            G.add_edge(s, ids[rng.randrange(n_sources, n_nodes)], provenance="metadata")
    # relay chains + convergence
    for i in range(n_sources, n_nodes):
        for _ in range(2):
            j = rng.randrange(n_sources, n_nodes)
            if j != i:
                G.add_edge(ids[min(i, j)], ids[max(i, j)], provenance="metadata")
    # a few cycles so Tarjan has work
    for _ in range(4):
        a, b = rng.sample(range(n_sources, n_nodes), 2)
        G.add_edge(ids[max(a, b)], ids[min(a, b)], provenance="metadata")
    return G, set(sources)


def bench(n):
    G, pan = synth_estate(n)
    H = analytics._flatten(G)
    rows = []

    def t(label, fn):
        t0 = time.perf_counter()
        out = fn()
        rows.append((label, (time.perf_counter() - t0) * 1000))
        return out

    t("flatten (Multi→Di)", lambda: analytics._flatten(G))
    origins = t("true PAN origins (SCC pass)", lambda: analytics._true_pan_sources(H, pan))
    scope = t("scope (memoized reachability)", lambda: analytics.pci_scope(H, pan))
    scores = t("scoring (incl. betweenness, sampled at scale)", lambda: compute_scores(G))
    t("heavy hitters (top 10)", lambda: analytics.heavy_hitters(G, pan, scores, top_k=10))
    t("greedy plan (max_k=5, pool=15)", lambda: analytics.minimal_tokenization_plan(
        G, pan, scores, target_fraction=1.0, max_k=5, candidate_k=15))
    t("hidden-scope + ownership rollup", lambda: (analytics.hidden_scope(G),
                                                  analytics.ownership_rollup(G, pan, scope, scores)))
    total = sum(ms for _, ms in rows)
    return {"n": n, "edges": H.number_of_edges(), "sources": len(pan),
            "origins": len(origins), "scope": len(scope), "rows": rows, "total_ms": total}


def main():
    sizes = [int(a) for a in sys.argv[1:]] or [5000, 20000, 40000]
    results = [bench(n) for n in sizes]
    lines = ["# PCI-SENTINEL — scale benchmark (measured, not claimed)", "",
             "Synthetic estates with the real data's structural character (small true-source",
             "front, hub fan-out, dense convergence, cycles), timed through the **shipped** code",
             "paths. Single process, commodity hardware; absolute numbers vary by machine —",
             "the shape (near-linear in V+E for everything except sampled betweenness) is the claim.", ""]
    for r in results:
        lines += [f"## {r['n']:,} systems · {r['edges']:,} flows · {r['sources']} PAN sources "
                  f"({r['origins']} true origins, {r['scope']:,} in scope)", "",
                  "| Stage | ms |", "|---|---|"]
        lines += [f"| {label} | {ms:,.0f} |" for label, ms in r["rows"]]
        lines += [f"| **end-to-end analytics core** | **{r['total_ms']:,.0f}** |", ""]
    out = "../evidence/scale_benchmark.md"
    with open(out, "w") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {out}")
    for r in results:
        print(f"N={r['n']:>6,}  edges={r['edges']:>7,}  total={r['total_ms']:>9,.0f} ms")


if __name__ == "__main__":
    main()
