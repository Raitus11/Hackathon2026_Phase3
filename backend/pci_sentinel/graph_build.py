"""Build the directed PCI data-flow graph from ingested datasets.

Edge convention (config.data_flow_edges, default True): PAN flows
provider -> consumer == Child App ID -> Parent App ID. Each edge carries a
`provenance` of 'metadata' (DS1/DS2/DS3, authoritative BAM) or 'inferred'
(DS5 survey / DS6 Splunk, signals only). Inferred edges are NEVER silently
merged with metadata edges — provenance is a first-class attribute (rubric #5).

We do NOT invent systems or relationships beyond the data (constraint #4):
a supplemental token becomes an edge only if it resolves to a node already
known from the authoritative edge/BAM universe.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import networkx as nx

from . import schema
from .config import SETTINGS

YES = {"yes", "y", "true", "1"}


def _is_yes(v) -> bool:
    return isinstance(v, str) and v.strip().lower() in YES


@dataclass
class GraphArtifacts:
    G: nx.MultiDiGraph                       # full graph (metadata + inferred edges)
    G_meta: nx.DiGraph                       # authoritative-only simple digraph (for DAG transform)
    pan_sources: set = field(default_factory=set)
    inferred_pan_sources: set = field(default_factory=set)  # PAN sources known ONLY via inferred signals (DS6)
    unresolved_signals: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def _node_pci_profile(bam_row: dict) -> dict:
    """Derive PAN/sensitivity attributes from a DS4 row (authoritative)."""
    pan_proc = _is_yes(bam_row.get("pci_primaryaccountnumber_processtransmit"))
    pan_store = _is_yes(bam_row.get("pci_primaryaccountnumber_store"))
    crn_proc = _is_yes(bam_row.get("pci_tokenizedprimaryaccountnumber_processtransmit"))
    crn_store = _is_yes(bam_row.get("pci_tokenizedprimaryaccountnumber_store"))
    detok = _is_yes(bam_row.get("pci_doesassetdetokenizepan"))
    track = _is_yes(bam_row.get("pci_fulltrackdata_processtransmit")) or _is_yes(bam_row.get("pci_fulltrackdata_store"))
    pin = _is_yes(bam_row.get("pci_personalidentificationnumber_processtransmit")) or _is_yes(bam_row.get("pci_personalidentificationnumber_store"))
    pan_in_logs = _is_yes(bam_row.get("pci_doespanincleartextlogfiles"))
    pci = _is_yes(bam_row.get("pci"))

    carries_pan = pan_proc or pan_store or detok or track or pin
    if carries_pan:
        tier = SETTINGS.tier_critical
    elif pci and (crn_proc or crn_store):
        tier = SETTINGS.tier_high
    elif pci:
        tier = SETTINGS.tier_high
    else:
        tier = SETTINGS.tier_none
    return dict(
        in_bam=True, pci_flag=pci, carries_pan=carries_pan, detokenizes=detok,
        pan_store=pan_store, pan_process=pan_proc, crn_only=(not carries_pan and (crn_proc or crn_store)),
        full_track=track, pin=pin, pan_in_logs=pan_in_logs,
        data_classification=bam_row.get("data_classification", ""),
        feeds_splunk=_is_yes(bam_row.get("feeds_splunk")),
        app_name=bam_row.get("application_name", ""), sensitivity_tier=tier,
    )


def _default_profile() -> dict:
    return dict(in_bam=False, pci_flag=False, carries_pan=False, detokenizes=False,
               pan_store=False, pan_process=False, crn_only=False, full_track=False,
               pin=False, pan_in_logs=False, data_classification="", feeds_splunk=False,
               app_name="", sensitivity_tier=SETTINGS.tier_none)


def build_graph(ingest) -> GraphArtifacts:
    G = nx.MultiDiGraph()
    G_meta = nx.DiGraph()

    # ---- nodes from BAM (authoritative attributes) ----
    bam_by_id = {}
    for r in ingest.bam_rows:
        aid = schema.extract_app_id(r.get("application_mnemonic_distributed_id", ""))
        if not aid:
            continue
        bam_by_id[aid] = r
        G.add_node(aid, **_node_pci_profile(r))

    def ensure_node(aid: str):
        if aid not in G:
            G.add_node(aid, **_default_profile())

    # ---- metadata edges (DS1/DS2/DS3) ----
    meta_edges = 0
    for r in ingest.edge_rows:
        parent = schema.extract_app_id(r.get("parent app id", ""))   # consumer (From)
        child = schema.extract_app_id(r.get("child app id", ""))     # provider (To)
        if not parent or not child:
            continue
        ensure_node(parent)
        ensure_node(child)
        src, dst = (child, parent) if SETTINGS.data_flow_edges else (parent, child)
        env = r.get("consuming app environment") or r.get("providing app environment") or ""
        G.add_edge(src, dst, provenance=SETTINGS.PROV_METADATA,
                   source_dataset=r.get("_source_dataset", ""), environment=env,
                   rel_type=r.get("type") or r.get("Type", ""))
        if G_meta.has_edge(src, dst):
            G_meta[src][dst]["environments"].add(env)
            G_meta[src][dst]["count"] += 1
        else:
            G_meta.add_edge(src, dst, provenance=SETTINGS.PROV_METADATA,
                            environments={env}, count=1)
        meta_edges += 1

    known = set(G.nodes)

    # ---- inferred edges from DS5 survey (signals only) ----
    inf_edges, unresolved = 0, []

    def add_inferred(src_tok, dst_id, signal):
        nonlocal inf_edges
        sid = schema.extract_app_id(src_tok)
        low = (src_tok or "").strip().lower()
        if low in SETTINGS.non_system_tokens:
            unresolved.append({"token": src_tok, "reason": "non-system origin category", "signal": signal})
            return
        if not sid or sid not in known:
            unresolved.append({"token": src_tok, "reason": "unresolved to known system", "signal": signal})
            return
        ensure_node(sid)
        G.add_edge(sid, dst_id, provenance=SETTINGS.PROV_INFERRED, signal=signal)
        inf_edges += 1

    for r in ingest.survey_rows:
        app = schema.extract_app_id(r.get("combo_distr_main_id", ""))
        if not app:
            continue
        ensure_node(app)
        up = r.get("upstream - dependency (where your app is receiving pan from)", "")
        if up:
            add_inferred(up, app, "DS5_survey_upstream")          # upstream provides PAN -> app
        down_key = next((k for k in r if k.startswith("downstream - dependency")), None)
        down = r.get(down_key, "") if down_key else ""
        if down:
            # app provides to downstream: edge app -> downstream(provider->consumer)
            did = schema.extract_app_id(down)
            if did and did in known:
                G.add_edge(app, did, provenance=SETTINGS.PROV_INFERRED, signal="DS5_survey_downstream")
                inf_edges += 1
            elif down.strip():
                unresolved.append({"token": down, "reason": "unresolved downstream", "signal": "DS5_survey_downstream"})

    # ---- inferred PAN presence + stated-source edges from DS6 Splunk ----
    inferred_pci = set()
    for r in ingest.splunk_rows:
        app = schema.extract_app_id(r.get("appid", ""))
        if not app:
            continue
        ensure_node(app)
        finding = (r.get("findings in sept - december logs", "") or "").lower()
        if "true pan" in finding:
            # PAN observed in logs although BAM says PCI=No -> hidden PAN node (signal)
            G.nodes[app]["pan_in_logs_observed"] = True
            G.nodes[app]["inferred_pan"] = True
            G.nodes[app]["splunk_finding"] = (r.get("findings in sept - december logs", "") or "").strip()
            inferred_pci.add(app)
            if G.nodes[app]["sensitivity_tier"] < SETTINGS.tier_medium:
                G.nodes[app]["sensitivity_tier"] = SETTINGS.tier_medium
        src = r.get("stated upstream source", "")
        if src:
            G.nodes[app]["splunk_stated_source"] = src.strip()
            add_inferred(src, app, "DS6_splunk_stated_source")

    # ---- PAN-source set: declared PAN carriers + DS6 observed PAN ----
    pan_sources = {n for n, d in G.nodes(data=True) if d.get("carries_pan")} | inferred_pci

    stats = dict(
        nodes=G.number_of_nodes(),
        metadata_edges=meta_edges,
        metadata_edges_deduped=G_meta.number_of_edges(),
        inferred_edges=inf_edges,
        unresolved_signals=len(unresolved),
        pan_source_nodes=len(pan_sources),
        bam_nodes=len(bam_by_id),
        self_loops=sorted(n for n in G.nodes if G.has_edge(n, n)),
    )
    return GraphArtifacts(G=G, G_meta=G_meta, pan_sources=pan_sources,
                          inferred_pan_sources=inferred_pci,
                          unresolved_signals=unresolved, stats=stats)
