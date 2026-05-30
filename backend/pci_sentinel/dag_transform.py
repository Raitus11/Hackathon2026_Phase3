"""From-graph -> To-graph transform.

The authoritative source graph contains cycles (e.g. self-loops 8AFN/8AQB and
ServiceNow 'Depends on::Used by' back-references), so it is NOT a DAG as ingested.
We make it a DAG by an explicit, explainable rule:

    Tarjan (1972) strongly-connected-component decomposition, then condense each
    SCC into a single super-node ("cycle cluster"). The condensation of any
    directed graph is provably acyclic.

Every super-node records the member systems and the internal edges that were
collapsed, so the cycle is preserved as auditable detail rather than hidden.
Tarjan is implemented iteratively here to stay safe at enterprise scale
(thousands of nodes) without hitting Python recursion limits.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import networkx as nx


def tarjan_scc(G: nx.DiGraph) -> list:
    """Return list of SCCs (each a list of nodes). Iterative Tarjan."""
    index_of, low, on_stack = {}, {}, {}
    index = 0
    stack, sccs = [], []

    for root in G.nodes:
        if root in index_of:
            continue
        work = [(root, iter(G.successors(root)))]
        while work:
            v, succ = work[-1]
            if v not in index_of:
                index_of[v] = low[v] = index
                index += 1
                stack.append(v)
                on_stack[v] = True
            advanced = False
            for w in succ:
                if w not in index_of:
                    work.append((w, iter(G.successors(w))))
                    advanced = True
                    break
                elif on_stack.get(w):
                    low[v] = min(low[v], index_of[w])
            if advanced:
                continue
            if low[v] == index_of[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack[w] = False
                    comp.append(w)
                    if w == v:
                        break
                sccs.append(comp)
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[v])
    return sccs


@dataclass
class DAGResult:
    DAG: nx.DiGraph                      # condensed acyclic graph (the "to-graph")
    node_to_super: dict = field(default_factory=dict)
    cycles: list = field(default_factory=list)   # SCCs with >1 member or a self-loop
    stats: dict = field(default_factory=dict)


def condense_to_dag(G: nx.DiGraph) -> DAGResult:
    sccs = tarjan_scc(G)
    node_to_super = {}
    DAG = nx.DiGraph()
    cycles = []

    for i, comp in enumerate(sccs):
        sid = f"SCC{i}"
        members = sorted(comp)
        for n in comp:
            node_to_super[n] = sid
        is_cycle = len(comp) > 1 or any(G.has_edge(n, n) for n in comp)
        # propagate worst-case node attributes onto the super-node
        carries = any(G.nodes[n].get("carries_pan") for n in comp)
        tier = max((G.nodes[n].get("sensitivity_tier", 0) for n in comp), default=0)
        DAG.add_node(sid, members=members, size=len(comp), is_cycle_cluster=is_cycle,
                     carries_pan=carries, sensitivity_tier=tier)
        if is_cycle:
            internal = [(u, v) for u in comp for v in G.successors(u) if v in set(comp)]
            cycles.append({"super_node": sid, "members": members, "internal_edges": internal})

    for u, v in G.edges():
        su, sv = node_to_super[u], node_to_super[v]
        if su != sv:
            if DAG.has_edge(su, sv):
                DAG[su][sv]["weight"] += 1
            else:
                DAG.add_edge(su, sv, weight=1)

    assert nx.is_directed_acyclic_graph(DAG), "Condensation invariant violated: result is not a DAG"

    stats = dict(
        source_nodes=G.number_of_nodes(), source_edges=G.number_of_edges(),
        dag_nodes=DAG.number_of_nodes(), dag_edges=DAG.number_of_edges(),
        cycle_clusters=len(cycles),
        nodes_in_cycles=sum(len(c["members"]) for c in cycles),
        is_acyclic=True,
    )
    return DAGResult(DAG=DAG, node_to_super=node_to_super, cycles=cycles, stats=stats)
