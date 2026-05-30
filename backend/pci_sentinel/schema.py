"""Schema normalization and dataset identification.

The source CSVs have inconsistent header casing across exports (e.g. DS1 uses
'Type'/'Connection strength' while DS2/DS3 use 'type'/'connection_strength').
We normalize headers to lowercase keys and identify each dataset by signature
columns so the engine is robust to which file lands where on upload.
"""
from __future__ import annotations

import re

# canonical dataset roles
EDGE_PCI_PCI = "DS1"          # PCI<->PCI relationships (authoritative)
EDGE_DOWNSTREAM = "DS2"       # downstream dependencies of PCI apps (authoritative)
EDGE_UPSTREAM = "DS3"         # upstream dependencies of PCI apps (authoritative)
BAM_CARDHOLDER = "DS4"        # all apps w/ cardholder data (authoritative attributes)
SURVEY = "DS5"               # CDE end-state survey (signal)
SPLUNK = "DS6"               # PCI=No apps w/ PAN in logs (signal)
UNKNOWN = "UNKNOWN"

_EDGE_SIG = {"parent app id", "child app id"}
_BAM_SIG = {"application_mnemonic_distributed_id", "pci"}
_SURVEY_SIG = {"combo_distr_main_id", "upstream - dependency (where your app is receiving pan from)"}
_SPLUNK_SIG = {"appid", "findings in sept - december logs"}


def norm_key(k: str) -> str:
    return (k or "").strip().lower()


def norm_row(row: dict) -> dict:
    return {norm_key(k): (v.strip() if isinstance(v, str) else v) for k, v in row.items()}


def detect_dataset(header_keys) -> str:
    keys = {norm_key(k) for k in header_keys}
    if _BAM_SIG <= keys:
        return BAM_CARDHOLDER
    if _SPLUNK_SIG <= keys:
        return SPLUNK
    if any(k.startswith("upstream - dependency") for k in keys) and "combo_distr_main_id" in keys:
        return SURVEY
    if _EDGE_SIG <= keys:
        # distinguish the three edge sets by filename hint when possible; otherwise
        # they share schema and are merged as authoritative metadata edges anyway.
        return EDGE_PCI_PCI
    return UNKNOWN


def detect_from_filename(name: str) -> str | None:
    n = name.lower()
    for ds, pats in {
        EDGE_PCI_PCI: ("ds1", "pci_to_pci", "pci to pci"),
        EDGE_DOWNSTREAM: ("ds2", "downstream"),
        EDGE_UPSTREAM: ("ds3", "upstream"),
        BAM_CARDHOLDER: ("ds4", "bam_report", "cardholder"),
        SURVEY: ("ds5", "survey", "cde_end_state", "end state"),
        SPLUNK: ("ds6", "splunk", "pan_in"),
    }.items():
        if any(p in n for p in pats):
            return ds
    return None


# App-ID token: 2-6 chars of uppercase letters/digits. Real ids look like
# 8AFN, HIUN1, WWFG, 80HG, KTCZP. Survey/Splunk values may carry a descriptive
# suffix ("UA - Huvymtasq ...") -> take the leading token.
_ID_RE = re.compile(r"^([0-9A-Z]{2,6})\b")


def extract_app_id(token: str) -> str | None:
    if not token:
        return None
    t = token.strip()
    m = _ID_RE.match(t)
    if m:
        return m.group(1)
    return None
