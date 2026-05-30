"""PCI data-handling boundary.

Inviolable rules enforced here (Requirements Master Section 9):
  * Never store/log/echo/display raw PAN. Mask to first-6/last-4 on ingest.
  * Detect any unmasked PAN that escapes ingestion -> the run FAILS.

A PAN here means a 13-19 digit string that satisfies the Luhn checksum
(ISO/IEC 7812). Masked values (first6 + filler + last4) and known
non-card identifiers (timestamps, document ids) do not satisfy this and are
left untouched.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Candidate PAN: 13-19 digits, optionally separated by spaces/dashes in groups.
_DIGIT_RUN = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")
# An already-masked PAN: 6 leading digits, masking chars, 4 trailing digits.
_MASKED = re.compile(r"(?<!\d)\d{6}[xX*]{2,}\d{4}(?!\d)")


def luhn_ok(digits: str) -> bool:
    """ISO/IEC 7812 Luhn checksum. Defensible, deterministic card-number test."""
    d = [int(c) for c in digits if c.isdigit()]
    if not 13 <= len(d) <= 19:
        return False
    checksum, parity = 0, len(d) % 2
    for i, n in enumerate(d):
        if i % 2 == parity:
            n *= 2
            if n > 9:
                n -= 9
        checksum += n
    return checksum % 10 == 0


def mask_pan(pan: str) -> str:
    """first-6 / last-4 mask preserving length (PCI-DSS 3.4 compliant display)."""
    digits = re.sub(r"\D", "", pan)
    if len(digits) < 10:
        return "x" * len(digits)
    return f"{digits[:6]}{'x' * (len(digits) - 10)}{digits[-4:]}"


def _is_unmasked_pan(token: str) -> bool:
    digits = re.sub(r"[ -]", "", token)
    return digits.isdigit() and luhn_ok(digits)


def sanitize_text(value: str) -> str:
    """Mask any unmasked, Luhn-valid PAN found in free text. Idempotent on
    already-masked values."""
    if not value:
        return value

    def repl(m: re.Match) -> str:
        tok = m.group(0)
        return mask_pan(tok) if _is_unmasked_pan(tok) else tok

    return _DIGIT_RUN.sub(repl, value)


@dataclass
class LeakReport:
    clean: bool
    findings: list  # list[(location, redacted_context)]

    def raise_if_leaked(self) -> None:
        if not self.clean:
            raise PanLeakError(
                f"Masking-leak check FAILED: {len(self.findings)} unmasked PAN(s) "
                f"escaped the ingestion boundary. First: {self.findings[0][0]}"
            )


class PanLeakError(RuntimeError):
    """Raised when an unmasked PAN is detected past the ingestion boundary."""


def scan_for_leaks(records, location_prefix: str = "") -> LeakReport:
    """Scan an iterable of dict rows for any unmasked Luhn-valid PAN.

    Returns a LeakReport; context is itself masked so the report never carries a
    raw PAN. This is the function the Validator node calls (V-check: masking-leak).
    """
    findings = []
    for i, row in enumerate(records):
        for k, v in row.items():
            if not isinstance(v, str):
                continue
            for m in _DIGIT_RUN.finditer(v):
                if _is_unmasked_pan(m.group(0)):
                    loc = f"{location_prefix}row{i}.{k}"
                    findings.append((loc, sanitize_text(v)[:60]))
    return LeakReport(clean=not findings, findings=findings)
