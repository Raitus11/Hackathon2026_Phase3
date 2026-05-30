"""Ingestion & Sanitiser boundary.

Loads uploaded CSVs, identifies each dataset, normalizes headers, masks any PAN
on entry, and emits a typed in-memory dataset plus a data-quality report.
Nothing unmasked is allowed past this boundary (enforced in pipeline via the
Validator's scan_for_leaks call).
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field

from . import schema
from .security import sanitize_text


@dataclass
class Dataset:
    role: str
    filename: str
    rows: list = field(default_factory=list)   # list[dict] normalized + sanitized


@dataclass
class IngestResult:
    datasets: dict = field(default_factory=dict)   # role -> Dataset (edge roles merged under 'edges')
    edge_rows: list = field(default_factory=list)   # merged DS1/DS2/DS3 rows w/ _source role
    bam_rows: list = field(default_factory=list)
    survey_rows: list = field(default_factory=list)
    splunk_rows: list = field(default_factory=list)
    quality: dict = field(default_factory=dict)


def _read_csv(text: str) -> tuple[list, list]:
    reader = csv.DictReader(io.StringIO(text))
    header = reader.fieldnames or []
    rows = [schema.norm_row(r) for r in reader]
    return header, rows


def _sanitize_rows(rows: list) -> int:
    """Mask PAN in-place across every string cell. Returns #cells altered."""
    altered = 0
    for r in rows:
        for k, v in list(r.items()):
            if isinstance(v, str) and v:
                s = sanitize_text(v)
                if s != v:
                    altered += 1
                r[k] = s
    return altered


def ingest_files(files: list) -> IngestResult:
    """files: list[(filename, text)]. Order/which-file-is-which is auto-detected."""
    res = IngestResult()
    masked_cells = 0
    for fname, text in files:
        header, rows = _read_csv(text)
        role = schema.detect_from_filename(fname) or schema.detect_dataset(header)
        masked_cells += _sanitize_rows(rows)
        ds = Dataset(role=role, filename=fname, rows=rows)
        if role in (schema.EDGE_PCI_PCI, schema.EDGE_DOWNSTREAM, schema.EDGE_UPSTREAM):
            for r in rows:
                r["_source_dataset"] = role
            res.edge_rows.extend(rows)
            res.datasets.setdefault("edges", Dataset("edges", "merged", []))
            res.datasets["edges"].rows.extend(rows)
        elif role == schema.BAM_CARDHOLDER:
            res.bam_rows.extend(rows)
            res.datasets[role] = ds
        elif role == schema.SURVEY:
            res.survey_rows.extend(rows)
            res.datasets[role] = ds
        elif role == schema.SPLUNK:
            res.splunk_rows.extend(rows)
            res.datasets[role] = ds
        else:
            res.datasets.setdefault(schema.UNKNOWN, Dataset(schema.UNKNOWN, fname, []))
            res.datasets[schema.UNKNOWN].rows.extend(rows)

    res.quality = {
        "files_ingested": len(files),
        "edge_rows": len(res.edge_rows),
        "bam_rows": len(res.bam_rows),
        "survey_rows": len(res.survey_rows),
        "splunk_rows": len(res.splunk_rows),
        "pan_cells_masked_on_ingest": masked_cells,
        "roles_detected": sorted({d.role for d in res.datasets.values()}),
    }
    return res


def ingest_paths(paths: list) -> IngestResult:
    files = []
    for p in paths:
        with open(p, encoding="utf-8-sig") as fh:
            files.append((p.split("/")[-1], fh.read()))
    return ingest_files(files)
