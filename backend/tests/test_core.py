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
