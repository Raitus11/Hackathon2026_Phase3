"""PCI DSS v4.0.1 requirement-family mapping — deterministic, cited, no LLM.

PCI DSS v4.0.1 is the only active version of the standard (mandatory since
2025-03-31; v4.0 retired 2024-12-31; v3.2.1 retired 2024). The PCI SSC defines
three scope categories used throughout this engine:

  * CDE          — stores, processes, or transmits cardholder data (CHD: PAN plus
                   name/expiry/service code) or sensitive authentication data (SAD).
  * connected-to — connects to, or could affect the security of, a CDE system,
                   even without holding CHD itself. ALSO in scope.
  * out-of-scope — cannot impact cardholder data.

`families_for` maps a node's already-computed PCI attributes (from graph_build's
`_node_pci_profile`, all deterministic DS4/DS6 facts) to the v4.0.1 requirement
families it triggers. This is a transparent lookup, not a judgment — every system
is mapped by the data it is recorded as handling, so a reviewer can re-derive it.
"""
from __future__ import annotations

# family key -> human label (what it is + why a CDE/connected system triggers it)
FAMILIES = {
    "req3":     "Req 3 — Protect stored account data (encryption/truncation of PAN at rest)",
    "req4":     "Req 4 — Protect CHD with strong cryptography during transmission",
    "req3_sad": "Req 3.2 — SAD (full track / PIN) must NOT be retained after authorization",
    "req7_8":   "Req 7/8 — Restrict access + MFA for ALL access into the CDE (v4.0.1 8.3.1)",
    "req10":    "Req 10 — Log and monitor all access to system components and CHD",
    "req11":    "Req 11 — Regularly test security of systems and networks",
}

# ordering for stable display
_ORDER = ["req3", "req4", "req3_sad", "req7_8", "req10", "req11"]


def families_for(node_attrs: dict, category: str) -> list:
    """Triggered v4.0.1 requirement families for one node, given its scope category.

    out-of-scope systems trigger none. Every CDE and connected-to system carries the
    access-control (Req 7/8) and security-testing (Req 11) families. Storage,
    transmission, prohibited-SAD-retention, and logging families are added per the
    specific data the node is recorded as handling.
    """
    if category == "out":
        return []
    a = node_attrs or {}
    fams = set()
    # access control + testing apply to everything in scope (CDE or connected-to)
    fams.update(("req7_8", "req11"))
    if a.get("pan_store"):
        fams.add("req3")                                   # PAN at rest
    if a.get("pan_process") or a.get("detokenizes"):
        fams.add("req4")                                   # PAN in transit / regenerated
    if a.get("full_track") or a.get("pin"):
        fams.add("req3_sad")                               # prohibited SAD storage risk
    if a.get("pan_in_logs") or a.get("inferred_pan"):
        fams.add("req10")                                  # clear PAN observed in logs = Req 10 gap
    if a.get("carries_pan"):
        fams.add("req10")                                  # any PAN handler must log access to it
    return [f for f in _ORDER if f in fams]
