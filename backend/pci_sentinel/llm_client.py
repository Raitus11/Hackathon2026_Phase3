"""Generic LLM abstraction.

The inference provider and model are resolved at runtime from environment
variables only; no provider name or model id is embedded in source. The
deterministic engine never depends on this — the LLM is used solely to turn
already-computed, grounded results into natural-language explanation (Hybrid
Intelligence: deterministic work is verifiable; the model only narrates it).

Environment:
  PCISENTINEL_LLM_BASE_URL   OpenAI-compatible endpoint of the chosen provider
  PCISENTINEL_LLM_API_KEY    credential
  PCISENTINEL_LLM_MODEL      model identifier (kept in config/env, never hard-coded)

If unset, the client runs in deterministic 'offline' mode and returns a
templated, fully-grounded explanation built from the engine's own numbers, so
the system is demonstrable with zero external dependencies.
"""
from __future__ import annotations

import json
import os
import urllib.request


class LLMClient:
    def __init__(self):
        self.base_url = os.environ.get("PCISENTINEL_LLM_BASE_URL", "").rstrip("/")
        self.api_key = os.environ.get("PCISENTINEL_LLM_API_KEY", "")
        self.model = os.environ.get("PCISENTINEL_LLM_MODEL", "")
        self.online = bool(self.base_url and self.api_key and self.model)

    def explain(self, system_prompt: str, grounded_facts: dict) -> str:
        if not self.online:
            return self._offline(grounded_facts)
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Explain ONLY using these grounded facts; "
                                            "do not invent numbers:\n" + json.dumps(grounded_facts, indent=2)},
            ],
            "temperature": 0.2,
        }
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            return data["choices"][0]["message"]["content"]
        except Exception as e:  # noqa: BLE001 - never let narration break the run
            return self._offline(grounded_facts) + f"\n\n[note: live explanation unavailable: {e}]"

    def chat(self, question: str, facts: dict, history=None) -> str:
        """Answer a free-form question grounded ONLY in the computed facts."""
        if not self.online:
            return ("I can answer that precisely once an inference provider is configured. "
                    "From the computed analysis I can already tell you about scope counts, the "
                    "metadata-confirmed vs inferred-only split, the heavy-hitter PAN distributors, "
                    "hidden-PCI systems, and the clean-stream impact of tokenizing a given system — "
                    "try asking about one of those, or name a system ID.")
        sys = ("You are a PCI scope analyst. Answer the question using ONLY the JSON facts provided "
               "from a completed data-flow analysis. Cite system IDs where relevant. If the facts do "
               "not contain the answer, say so plainly — never invent systems, numbers, or edges.")
        msgs = [{"role": "system", "content": sys}]
        for h in (history or [])[-6:]:
            if h.get("role") in ("user", "assistant") and h.get("content"):
                msgs.append({"role": h["role"], "content": str(h["content"])[:2000]})
        msgs.append({"role": "user", "content": "FACTS:\n" + json.dumps(facts, indent=2) +
                     "\n\nQUESTION: " + question})
        payload = {"model": self.model, "messages": msgs, "temperature": 0.2}
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions", data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            return data["choices"][0]["message"]["content"]
        except Exception as e:  # noqa: BLE001
            return f"Could not reach the inference provider ({e}). Try a scope, heavy-hitter, hidden-PCI, or per-system question."

    @staticmethod
    def _offline(f: dict) -> str:
        hh = (f.get("top_heavy_hitter") or {})
        imp = f.get("impact") or {}
        meta = f.get("scope_metadata_confirmed")
        inf = f.get("scope_inferred_only")
        split = ""
        if meta is not None and inf is not None:
            split = (f" Of these, {meta} are confirmed by authoritative BAM metadata and "
                     f"{inf} are inferred-only candidate scope surfaced from survey/Splunk "
                     f"signals (kept separate, never treated as ground truth).")
        return (
            f"Current state: {f.get('scope_size', '?')} systems fall within PCI scope across "
            f"{f.get('dag_nodes', '?')} data-flow clusters; {f.get('cycle_clusters', 0)} circular "
            f"dependency cluster(s) were resolved into the DAG.{split} The highest-leverage true-source is "
            f"{hh.get('system', 'n/a')}, which distributes PAN to {hh.get('exclusive_reach', 0)} systems "
            f"that depend on it exclusively. Tokenizing PAN at the recommended source(s) descopes "
            f"{imp.get('nodes_descoped', 0)} systems "
            f"({imp.get('node_surface_reduction_pct', 0)}% of the in-scope surface) and lowers the "
            f"aggregate risk score by {imp.get('risk_reduction_pct', 0)}% — the clean-stream effect."
        )
