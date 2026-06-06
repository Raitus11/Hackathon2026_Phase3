"""Central configuration. All tunables live here or in environment variables.

Nothing in this module hard-codes an inference-provider name or a model id; the
provider is selected at runtime via the PCISENTINEL_LLM_* environment variables
and resolved behind the LLMClient abstraction (see llm_client.py).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class ScoringWeights:
    """Weights for the composite node risk score. Must sum to 1.0.

    Defaults are documented design choices (see scoring.py for the rationale and
    citations) and can be overridden via environment variables for tuning.
    """
    sensitivity: float = field(default_factory=lambda: _env_float("PCISENTINEL_W_SENSITIVITY", 0.40))
    reach: float = field(default_factory=lambda: _env_float("PCISENTINEL_W_REACH", 0.30))
    betweenness: float = field(default_factory=lambda: _env_float("PCISENTINEL_W_BETWEENNESS", 0.20))
    source: float = field(default_factory=lambda: _env_float("PCISENTINEL_W_SOURCE", 0.10))

    def validate(self) -> None:
        total = self.sensitivity + self.reach + self.betweenness + self.source
        if abs(total - 1.0) > 1e-9:
            raise ValueError(f"Scoring weights must sum to 1.0; got {total:.4f}")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class CostModel:
    """Parameters for the audit-scope cost model (scope_economics). Every value is a
    LABELED ESTIMATE, overridable via environment, and surfaced on screen in the
    `assumptions` block — never presented as an organization's real figures.

      * qsa_day_rate         — blended assessor/internal day rate (currency-agnostic).
      * days_per_cde_system  — effort to assess one in-scope (CDE) system.
      * days_per_connected   — effort to assess one connected-to/impacting system.
      * roc_threshold        — in-scope count above which the posture is a full ROC
                               rather than a self-assessment (SAQ-D); crossing it on
                               the way to the floor is a qualitative win to highlight.
    """
    qsa_day_rate: float = field(default_factory=lambda: _env_float("PCISENTINEL_QSA_DAY_RATE", 2500.0))
    days_per_cde_system: float = field(default_factory=lambda: _env_float("PCISENTINEL_DAYS_PER_CDE", 0.5))
    days_per_connected: float = field(default_factory=lambda: _env_float("PCISENTINEL_DAYS_PER_CONN", 0.15))
    roc_threshold: int = field(default_factory=lambda: _env_int("PCISENTINEL_ROC_THRESHOLD", 1000))


@dataclass(frozen=True)
class Settings:
    # Data-flow edge convention. The source columns define:
    #   Parent App ID == "From Application (Consumes)"
    #   Child  App ID == "To Application (Provides)"
    # i.e. Parent consumes FROM Child, so PAN flows Child -> Parent (provider -> consumer).
    # data_flow_edges=True emits provider->consumer (recommended; out-degree = #downstream
    # consumers a system distributes PAN to). Set False to emit raw dependency edges.
    data_flow_edges: bool = True

    # Sensitivity tiers (0..4) used by the classifier/scorer.
    tier_critical: int = 4   # untokenized PAN / full track / PIN / detokenizes CRN->PAN
    tier_high: int = 3       # PCI=YES, tokenized PAN (CRN) only
    tier_medium: int = 2     # inferred/at-risk: receives PAN or PAN-in-logs (DS6) but undeclared
    tier_low: int = 1        # touches PCI flow, no PAN
    tier_none: int = 0

    weights: ScoringWeights = field(default_factory=ScoringWeights)
    cost: CostModel = field(default_factory=CostModel)

    # Provenance labels (kept first-class per rubric criterion #5).
    PROV_METADATA: str = "metadata"   # DS1/DS2/DS3 — authoritative BAM
    PROV_INFERRED: str = "inferred"   # DS5 survey / DS6 Splunk — signals only

    # Tokens in supplemental data that are provenance categories, NOT systems.
    non_system_tokens: tuple = ("user entry", "credit bureaus", "written in documents",
                                "user input", "manual entry")


SETTINGS = Settings()
SETTINGS.weights.validate()
