"""Quant / Scoring.

Composite per-node PCI exposure risk score R(v) in [0,100], a weighted sum of
four normalized, individually-defensible factors:

  1. sensitivity_norm  = sensitivity_tier / 4
        What cardholder data the system declares (DS4). Untokenized PAN / track /
        PIN / detokenization => tier 4; CRN-only / PCI => tier 3; inferred PAN
        (DS6) => tier 2. (PCI-DSS data-element risk ordering.)
  2. reach_norm        = |descendants(v)| / (N-1)
        Downstream blast radius: how many systems v can propagate PAN to in the
        data-flow graph (transitive closure). Larger reach => larger exposure.
  3. betweenness_norm  = normalized betweenness centrality (Freeman 1977;
        Brandes 2001 algorithm). Conduit role — systems many PAN paths route through.
  4. source_flag       = 1 if v is a true PAN source (in-degree 0 in data-flow AND
        carries/originates PAN), else 0. True sources are where tokenization yields
        the clean-stream effect, so they carry intervention leverage.

R(v) = 100 * (w_s*sens + w_r*reach + w_b*betw + w_src*source), weights from config
(default 0.40/0.30/0.20/0.10, sum=1.0; override via env for tuning). Every term is
named, bounded, and reproducible — no magic constants, no black box.
"""
from __future__ import annotations

import networkx as nx

from .config import SETTINGS


def _flatten(G):
    """Collapse the MultiDiGraph to a simple DiGraph for reachability/centrality,
    preserving node attributes."""
    H = nx.DiGraph()
    H.add_nodes_from(G.nodes(data=True))
    for u, v in G.edges():
        H.add_edge(u, v)
    return H


def descendants_count(H: nx.DiGraph, n) -> int:
    return len(nx.descendants(H, n))


def _scaled_betweenness(H, N):
    """Exact Brandes betweenness for small graphs; pivot-sampled approximation above
    a threshold so scoring stays sub-second at enterprise scale. Sampled betweenness
    (Brandes & Pich 2007) is an unbiased estimator using k source pivots — the same
    quantity, estimated, not a different metric."""
    if N <= 2:
        return {n: 0.0 for n in H}
    if N <= 600:
        return nx.betweenness_centrality(H, normalized=True)
    k = min(400, N)
    return nx.betweenness_centrality(H, normalized=True, k=k, seed=7)


def compute_scores(G) -> dict:
    H = _flatten(G)
    N = H.number_of_nodes()
    w = SETTINGS.weights

    betw = _scaled_betweenness(H, N)
    reach = {n: descendants_count(H, n) for n in H}
    max_reach = max(N - 1, 1)

    scores = {}
    for n, d in H.nodes(data=True):
        sens = d.get("sensitivity_tier", 0) / 4.0
        rn = reach[n] / max_reach
        bn = betw.get(n, 0.0)
        is_src = 1.0 if (H.in_degree(n) == 0 and (d.get("carries_pan") or d.get("inferred_pan"))) else 0.0
        raw = w.sensitivity * sens + w.reach * rn + w.betweenness * bn + w.source * is_src
        scores[n] = {
            "risk": round(100.0 * raw, 2),
            "sensitivity_tier": d.get("sensitivity_tier", 0),
            "downstream_reach": reach[n],
            "betweenness": round(bn, 4),
            "is_true_source": bool(is_src),
            "carries_pan": bool(d.get("carries_pan") or d.get("inferred_pan")),
            "factors": {"sensitivity_norm": round(sens, 4), "reach_norm": round(rn, 4),
                        "betweenness_norm": round(bn, 4), "source_flag": is_src},
        }
    return scores
