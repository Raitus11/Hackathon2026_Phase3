"""V-checks (Marco). Run: PYTHONPATH=. pytest -q"""
import networkx as nx
import pytest

from pci_sentinel.security import (luhn_ok, mask_pan, sanitize_text,
                                    scan_for_leaks, PanLeakError)
from pci_sentinel.dag_transform import tarjan_scc, condense_to_dag
from pci_sentinel.graph_build import build_graph
from pci_sentinel.ingest import ingest_files
from pci_sentinel.scoring import compute_scores
from pci_sentinel import analytics


# ---- V-001 masking / leak safety (inviolable) ----
def test_luhn():
    assert luhn_ok("4111111111111111")        # Visa test PAN
    assert not luhn_ok("4111111111111112")

def test_mask_first6_last4():
    assert mask_pan("4111111111111111") == "411111xxxxxx1111"

def test_already_masked_untouched():
    s = "card 414718xxxxxx3942 ok"
    assert sanitize_text(s) == s               # idempotent on masked values

def test_unmasked_pan_is_masked():
    out = sanitize_text("pan=4111111111111111 end")
    assert "4111111111111111" not in out and "411111xxxxxx1111" in out

def test_leak_scan_flags_unmasked():
    rep = scan_for_leaks([{"g": "leak 4111111111111111"}])
    assert not rep.clean
    with pytest.raises(PanLeakError):
        rep.raise_if_leaked()
    # report context itself must not contain the raw PAN
    assert "4111111111111111" not in rep.findings[0][1]

def test_leak_scan_clean_on_masked():
    assert scan_for_leaks([{"g": "414718xxxxxx3942"}]).clean


# ---- V-002 Tarjan SCC + DAG condensation invariant ----
def test_tarjan_finds_cycle():
    G = nx.DiGraph([("a", "b"), ("b", "c"), ("c", "a"), ("c", "d")])
    comps = [sorted(c) for c in tarjan_scc(G)]
    assert ["a", "b", "c"] in comps and ["d"] in comps

def test_condensation_is_acyclic():
    G = nx.DiGraph([("a", "b"), ("b", "a"), ("b", "c"), ("c", "c")])
    G.add_node("a", carries_pan=True, sensitivity_tier=4)
    r = condense_to_dag(G)
    assert nx.is_directed_acyclic_graph(r.DAG)
    assert r.stats["cycle_clusters"] >= 1     # {a,b} cycle and/or c self-loop

def test_self_loop_detected_as_cycle():
    G = nx.DiGraph(); G.add_edge("x", "x")
    r = condense_to_dag(G)
    assert r.stats["cycle_clusters"] == 1


# ---- V-003 scoring sanity ----
def _toy():
    edges = [{"parent app id": "AAP", "child app id": "BBP", "consuming app environment": "Production",
              "type": "Depends on", "_source_dataset": "DS1"}]
    bam = [{"application_mnemonic_distributed_id": "BBP", "pci": "YES",
            "pci_primaryaccountnumber_processtransmit": "YES", "application_name": "src"}]
    import io, csv
    def to_csv(rows, cols):
        s = io.StringIO(); w = csv.DictWriter(s, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow(r)
        return s.getvalue()
    ecols = ["Parent App ID", "Child App ID", "Consuming App Environment", "type"]
    erows = [{"Parent App ID": "AAP", "Child App ID": "BBP", "Consuming App Environment": "Production", "type": "Depends on"}]
    bcols = ["APPLICATION_MNEMONIC_DISTRIBUTED_ID", "PCI", "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT", "APPLICATION_NAME"]
    brows = [{"APPLICATION_MNEMONIC_DISTRIBUTED_ID": "BBP", "PCI": "YES",
              "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT": "YES", "APPLICATION_NAME": "src"}]
    return ingest_files([("DS1.csv", to_csv(erows, ecols)), ("DS4.csv", to_csv(brows, bcols))])

def test_scores_in_range_and_source_flow():
    art = build_graph(_toy())
    scores = compute_scores(art.G)
    assert set(scores) == {"AAP", "BBP"}
    for s in scores.values():
        assert 0.0 <= s["risk"] <= 100.0
    # B carries PAN and (data-flow) provides to A -> B is a true source with reach>=1
    assert scores["BBP"]["is_true_source"] and scores["BBP"]["downstream_reach"] >= 1

def test_clean_stream_reduces_scope():
    art = build_graph(_toy())
    scores = compute_scores(art.G)
    H = analytics._flatten(art.G)
    before = analytics.pci_scope(H, art.pan_sources)
    imp = analytics.clean_stream_impact(art.G, art.pan_sources, scores, ["BBP"])
    assert imp["scope_after"] <= imp["scope_before"]


# ---- V-004 LangGraph orchestration + human-in-the-loop gate ----
def test_agentic_runs_end_to_end():
    from pci_sentinel.orchestrator import run_agentic
    art = _toy()  # reuse fixture's underlying csvs
    import io, csv
    def to_csv(rows, cols):
        s = io.StringIO(); w = csv.DictWriter(s, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow(r)
        return s.getvalue()
    ecols = ["Parent App ID", "Child App ID", "Consuming App Environment", "type"]
    erows = [{"Parent App ID": "AAP", "Child App ID": "BBP", "Consuming App Environment": "Production", "type": "Depends on"}]
    bcols = ["APPLICATION_MNEMONIC_DISTRIBUTED_ID", "PCI", "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT", "APPLICATION_NAME"]
    brows = [{"APPLICATION_MNEMONIC_DISTRIBUTED_ID": "BBP", "PCI": "YES",
              "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT": "YES", "APPLICATION_NAME": "src"}]
    files = [("DS1.csv", to_csv(erows, ecols)), ("DS4.csv", to_csv(brows, bcols))]
    st = run_agentic(files, auto_approve=True, thread_id="t_e2e")
    stages = [a["stage"] for a in st["audit"]]
    assert st["status"] == "complete"
    assert "human_gate" in stages and "report" in stages
    assert st["result"].headline["systems_exposed_to_clear_pan"] >= 1

def test_hitl_gate_interrupts_and_resumes():
    """auto_approve=False must pause at the gate, then resume on a human decision."""
    from pci_sentinel.orchestrator import build_orchestrator
    from langgraph.types import Command
    import io, csv
    def to_csv(rows, cols):
        s = io.StringIO(); w = csv.DictWriter(s, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow(r)
        return s.getvalue()
    ecols = ["Parent App ID", "Child App ID", "Consuming App Environment", "type"]
    erows = [{"Parent App ID": "AAP", "Child App ID": "BBP", "Consuming App Environment": "Production", "type": "Depends on"}]
    bcols = ["APPLICATION_MNEMONIC_DISTRIBUTED_ID", "PCI", "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT", "APPLICATION_NAME"]
    brows = [{"APPLICATION_MNEMONIC_DISTRIBUTED_ID": "BBP", "PCI": "YES",
              "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT": "YES", "APPLICATION_NAME": "src"}]
    files = [("DS1.csv", to_csv(erows, ecols)), ("DS4.csv", to_csv(brows, bcols))]
    app = build_orchestrator()
    cfg = {"configurable": {"thread_id": "t_hitl"}}
    out = app.invoke({"files": files, "auto_approve": False, "recommend_top": 1, "audit": []}, cfg)
    assert "__interrupt__" in out                      # paused at the gate
    resumed = app.invoke(Command(resume={"decision": "approve"}), cfg)
    assert resumed["status"] == "complete"


# ---- V-014 viz edges are deduplicated (parallel edges collapsed) ----
def test_viz_edges_deduped():
    import glob
    from pci_sentinel import pipeline
    files = [(f, open(f, encoding="utf-8-sig").read()) for f in glob.glob("../sample_data/DS*.csv")]
    r = pipeline.run(files)
    pairs = [(e["source"], e["target"]) for e in r.viz["edges"]]
    assert len(pairs) == len(set(pairs))                 # one visual edge per ordered pair
    multi = [e for e in r.viz["edges"] if e.get("count", 1) > 1]
    assert multi and all(e["count"] >= 2 for e in multi)  # parallels recorded as count


# ---- V-015 scope split + hidden flag are internally consistent ----
def test_scope_split_and_hidden_flag():
    import glob
    from pci_sentinel import pipeline
    files = [(f, open(f, encoding="utf-8-sig").read()) for f in glob.glob("../sample_data/DS*.csv")]
    r = pipeline.run(files)
    h = r.headline
    assert h["scope_metadata_confirmed"] + h["scope_inferred_only"] == h["systems_exposed_to_clear_pan"]
    hidden_nodes = [n for n in r.viz["nodes"] if n["hidden_pci"]]
    assert len(hidden_nodes) == h["hidden_pci_systems_bam_misses"]


# ---- V-016 grounded chat answers deterministically, no model needed ----
def test_chat_deterministic_grounded():
    import glob
    from pci_sentinel import pipeline, chat
    files = [(f, open(f, encoding="utf-8-sig").read()) for f in glob.glob("../sample_data/DS*.csv")]
    r = pipeline.run(files)
    a = chat.answer(r, "How many systems are in scope, confirmed vs inferred?")
    assert str(r.headline["systems_exposed_to_clear_pan"]) in a["answer"]
    top = r.heavy_hitters[0]["system"]
    a2 = chat.answer(r, f"What happens if we tokenize {top}?")
    assert top in a2["answer"] and top in a2["grounded_on"]


# ---- V-017..020 corrected impact model (regression guards) ----
import glob as _glob


def _sample_art():
    files = [(f, open(f, encoding="utf-8-sig").read()) for f in _glob.glob("../sample_data/DS*.csv")]
    art = build_graph(ingest_files(files))
    return art, compute_scores(art.G)


def test_solo_descope_never_exceeds_reach():
    """The headline bug guard: exclusive/solo descope is a SUBSET of downstream
    reach, so it can never exceed it. (Was violated when the source counted itself.)"""
    art, scores = _sample_art()
    hh = analytics.heavy_hitters(art.G, art.pan_sources, scores, top_k=len(art.pan_sources))
    for h in hh:
        assert h["solo_descope"] <= h["downstream_reach"], h
        assert h["solo_descope"] == h["exclusive_reach"]   # alias stays in sync


def test_single_source_descope_equals_solo_descope():
    """Cross-function consistency: tokenizing exactly one source descopes precisely
    that source's solo_descope count (the two computations can never drift)."""
    art, scores = _sample_art()
    hh = analytics.heavy_hitters(art.G, art.pan_sources, scores, top_k=8)
    for h in hh:
        imp = analytics.clean_stream_impact(art.G, art.pan_sources, scores, [h["system"]])
        assert imp["nodes_descoped"] == h["solo_descope"], (h["system"], imp["nodes_descoped"], h["solo_descope"])


def test_tokenized_source_stays_in_scope():
    """A tokenized PAN source remains in the CDE (tokenization point); it must not
    appear in the descoped set, and if it is a pure-PAN source it downgrades 4->3."""
    art = build_graph(_toy())
    scores = compute_scores(art.G)
    imp = analytics.what_if(art.G, art.pan_sources, scores, ["BBP"])
    assert "BBP" not in imp["descoped_systems"]            # source is NOT descoped
    assert "BBP" in imp["sources_downgraded"]              # pure-PAN -> tier 4->3
    assert imp["risk_after"] <= imp["risk_before"]


def _toy_with_track():
    import io, csv
    def to_csv(rows, cols):
        s = io.StringIO(); w = csv.DictWriter(s, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow(r)
        return s.getvalue()
    ecols = ["Parent App ID", "Child App ID", "Consuming App Environment", "type"]
    # SRC provides to TRK (full-track) and to PLAIN (plain consumer)
    erows = [{"Parent App ID": "TRK", "Child App ID": "SRC", "Consuming App Environment": "Production", "type": "x"},
             {"Parent App ID": "PLN", "Child App ID": "SRC", "Consuming App Environment": "Production", "type": "x"}]
    bcols = ["APPLICATION_MNEMONIC_DISTRIBUTED_ID", "PCI", "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT",
             "PCI_FULLTRACKDATA_PROCESSTRANSMIT", "APPLICATION_NAME"]
    brows = [{"APPLICATION_MNEMONIC_DISTRIBUTED_ID": "SRC", "PCI": "YES",
              "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT": "YES", "PCI_FULLTRACKDATA_PROCESSTRANSMIT": "NO",
              "APPLICATION_NAME": "src"},
             {"APPLICATION_MNEMONIC_DISTRIBUTED_ID": "TRK", "PCI": "YES",
              "PCI_PRIMARYACCOUNTNUMBER_PROCESSTRANSMIT": "NO", "PCI_FULLTRACKDATA_PROCESSTRANSMIT": "YES",
              "APPLICATION_NAME": "track"}]
    return ingest_files([("DS1.csv", to_csv(erows, ecols)), ("DS4.csv", to_csv(brows, bcols))])


def test_always_cde_systems_never_descope():
    """Data-dictionary rule: full-track / PIN / detokenizers are always a CDE
    candidate — tokenizing upstream PAN must never descope them."""
    art = build_graph(_toy_with_track())
    scores = compute_scores(art.G)
    imp = analytics.what_if(art.G, art.pan_sources, scores, ["SRC"])
    assert "TRK" not in imp["descoped_systems"]           # full-track stays in CDE
    assert "TRK" not in imp["sources_downgraded"]         # and never tier-downgraded


def test_scope_categories_and_requirement_mapping():
    """Decision layer F2: every in-scope system is CDE; CDE count == scope size;
    a full-track holder triggers the prohibited-SAD-storage family."""
    art = build_graph(_toy_with_track())
    scores = compute_scores(art.G)
    H = analytics._flatten(art.G)
    scope = analytics.pci_scope(H, art.pan_sources)
    cats = analytics.scope_categories(art.G, art.pan_sources, scope, scores)
    assert cats["counts"]["cde"] == len(scope)            # CDE == in scope
    # categories partition the whole node universe
    assert sum(cats["counts"].values()) == art.G.number_of_nodes()
    assert "req3_sad" in cats["per_node"]["TRK"]["families"]  # full-track -> SAD storage risk


def test_scope_economics_floor_bounded():
    """Decision layer F1: the achievable floor never exceeds current scope and the
    floor effort is never greater than current effort (tokenization only removes)."""
    art = build_graph(_toy_with_track())
    scores = compute_scores(art.G)
    H = analytics._flatten(art.G)
    scope = analytics.pci_scope(H, art.pan_sources)
    cats = analytics.scope_categories(art.G, art.pan_sources, scope, scores)
    sat = analytics.saturation_curve(art.G, art.pan_sources, scores, points=6)
    econ = analytics.scope_economics(cats, sat, scores)
    assert econ["achievable_floor"] <= econ["in_scope_now"]
    assert econ["effort_floor"]["qsa_days"] <= econ["effort_now"]["qsa_days"]
    assert econ["cost_saving"] >= 0


# ---- V-021 optimizer greedy baseline == shipped roadmap greedy (anti-contradiction) ----
def _sample_art():
    """Build from the bundled sample CSVs; skip if they are not present (e.g. on the
    air-gapped office box where only the real dataset lives)."""
    import os, glob
    here = os.path.dirname(__file__)
    sample = os.path.abspath(os.path.join(here, "..", "..", "sample_data"))
    paths = sorted(glob.glob(os.path.join(sample, "*.csv")))
    if not paths:
        pytest.skip("sample_data CSVs not available in this environment")
    files = []
    for p in paths:
        with open(p, encoding="utf-8-sig") as fh:
            files.append((os.path.basename(p), fh.read()))
    art = build_graph(ingest_files(files))
    return art, compute_scores(art.G)


def test_greedy_baselines_agree_across_callers():
    """The optimizer's greedy gap-baseline (descope_frontier, k_max=10) MUST equal the
    shipped roadmap greedy (cumulative_descope_curve, max_k=25) at every shared budget.

    Regression: a prior version tied the candidate POOL size to `max_k`, so the frontier
    silently searched only the top-10 origins by reach while the roadmap searched all of
    them. The two greedy curves then disagreed (e.g. 29 vs 30 systems freed at k=6) across
    the XLSX TokenizationPlan and Optimization sheets and the PDF, manufacturing an
    optimal-vs-greedy gap the roadmap itself contradicted. The candidate pool is now
    independent of the step budget; this guards the property."""
    from pci_sentinel import optimize
    art, scores = _sample_art()
    G, pan = art.G, art.pan_sources
    roadmap = {r["k"]: r["cumulative_descoped"]
               for r in analytics.cumulative_descope_curve(G, pan, scores, max_k=25)}
    fr = optimize.descope_frontier(G, pan, scores, k_max=10)
    for row in fr["frontier"]:
        k = row["k"]
        if k in roadmap:
            assert row["greedy_descoped"] == roadmap[k], (
                f"greedy baseline disagrees with the shipped roadmap at k={k}: "
                f"frontier reports {row['greedy_descoped']}, roadmap reports {roadmap[k]}")
        # an exact optimum can never fall below greedy, and every gap is non-negative
        assert row["optimal_descoped"] >= row["greedy_descoped"]
        assert row["gap"] >= 0
