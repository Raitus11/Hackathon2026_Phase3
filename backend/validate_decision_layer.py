"""Validate the PCI-SENTINEL decision-layer additions against a generated snapshot.

Usage (from backend/):
    python validate_decision_layer.py ../frontend-app/src/snapshot.json

Reads the snapshot the UI actually consumes and checks every invariant the new
features must satisfy. Prints PASS/FAIL per check and a non-zero exit on any FAIL,
so it doubles as a pre-submission gate. Works on both the dev and the real 4K snapshot.
"""
import json
import sys

PASS, FAIL = "PASS", "FAIL"
results = []


def check(name, ok, detail=""):
    results.append((PASS if ok else FAIL, name, detail))


def main(path):
    d = json.load(open(path, encoding="utf-8"))
    scope = d.get("scope_size") or d.get("headline", {}).get("systems_exposed_to_clear_pan")
    nodes_total = d.get("graph_stats", {}).get("nodes")

    print(f"\nValidating: {path}")
    print(f"  scope_size={scope}  total_nodes={nodes_total}\n")

    # ---- F2: scope categories ----
    cats = d.get("categories", {})
    counts = cats.get("counts", {})
    check("F2 categories key present", bool(cats))
    check("F2 CDE count == in-scope count",
          counts.get("cde") == scope, f"cde={counts.get('cde')} scope={scope}")
    if nodes_total is not None:
        tot = sum(counts.get(k, 0) for k in ("cde", "connected", "out"))
        check("F2 categories partition all nodes",
              tot == nodes_total, f"cde+connected+out={tot} nodes={nodes_total}")
    check("F2 family_counts populated", bool(cats.get("family_counts")),
          str(cats.get("family_counts")))
    vnodes = d.get("viz", {}).get("nodes", [])
    check("F2 every viz node has a category",
          all(("category" in n) for n in vnodes), f"{len(vnodes)} nodes")
    hidden_nodes = [n for n in vnodes if n.get("hidden_pci")]
    check("F2 hidden-PCI systems are CDE",
          all(n.get("category") == "cde" for n in hidden_nodes),
          f"{len(hidden_nodes)} hidden nodes")

    # ---- F1: economics ----
    e = d.get("economics", {})
    check("F1 economics key present", bool(e))
    if e:
        check("F1 floor <= current scope",
              e["achievable_floor"] <= e["in_scope_now"],
              f"floor={e['achievable_floor']} now={e['in_scope_now']}")
        check("F1 removable == now - floor",
              e["removable"] == e["in_scope_now"] - e["achievable_floor"])
        check("F1 floor effort <= current effort",
              e["effort_floor"]["qsa_days"] <= e["effort_now"]["qsa_days"])
        check("F1 cost_saving >= 0", e["cost_saving"] >= 0)
        thr = e["assumptions"]["roc_threshold"]
        check("F1 posture_now consistent with threshold",
              (e["posture_now"] == "ROC") == (e["in_scope_now"] > thr),
              f"now={e['in_scope_now']} thr={thr} posture={e['posture_now']}")
        check("F1 economics.in_scope_now == categories.cde",
              e["in_scope_now"] == counts.get("cde"))

    # ---- F3: sankey ----
    sk = d.get("sankey", {})
    check("F3 sankey key present", bool(sk))
    if sk:
        ids = {n["id"] for n in sk.get("nodes", [])}
        bands = {n.get("band") for n in sk.get("nodes", [])}
        check("F3 sankey has all 3 bands", {0, 1, 2} <= bands, str(bands))
        check("F3 sankey link endpoints all exist",
              all(l["source"] in ids and l["target"] in ids for l in sk.get("links", [])))
        check("F3 sankey link values positive",
              all(l["value"] > 0 for l in sk.get("links", [])))

    # ---- F4: segmentation ----
    seg = d.get("structure", {}).get("segmentation_candidates", [])
    check("F4 segmentation_candidates present", bool(seg), f"{len(seg)} candidates")
    if seg:
        check("F4 branch_size never exceeds scope",
              all(r["branch_size"] <= scope for r in seg))
        check("F4 ranked by branch_size desc",
              all(seg[i]["branch_size"] >= seg[i + 1]["branch_size"] for i in range(len(seg) - 1)))

    # ---- F5: hidden-scope requirement enrichment ----
    detail = d.get("hidden", {}).get("hidden_detail", [])
    check("F5 hidden_detail present", bool(detail), f"{len(detail)} misses")
    if detail:
        check("F5 every miss lists triggered_requirements",
              all(r.get("triggered_requirements") for r in detail))
        check("F5 every miss flags Req 10 (clear PAN in logs)",
              all("req10" in (r.get("triggered_requirements") or []) for r in detail))

    # ---- honesty: no submodular overclaim leaked into the snapshot's plan method ----
    method = (d.get("plan", {}) or {}).get("method", "")
    check("Honesty: plan method does not claim (1-1/e)",
          "1-1/e" not in method or "no (1-1/e)" in method or "supermodular" in method,
          method[:80])

    # ---- report ----
    print("  " + "-" * 60)
    nfail = 0
    for status, name, detail in results:
        mark = "OK " if status == PASS else ">> "
        line = f"  [{status}] {name}"
        if status == FAIL:
            nfail += 1
            line += f"   ({detail})" if detail else ""
        print(line)
    print("  " + "-" * 60)
    print(f"  {len(results) - nfail}/{len(results)} checks passed"
          + ("" if nfail == 0 else f"  —  {nfail} FAILED"))
    print()
    return 1 if nfail else 0


if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else "../frontend-app/src/snapshot.json"
    sys.exit(main(p))
