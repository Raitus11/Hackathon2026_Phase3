"""Generic LLM abstraction.

The inference backend, endpoint, credentials and model are resolved at runtime
from environment variables only; no backend name, vendor name or model id is
embedded in source. The deterministic engine never depends on this — the model
is used solely to turn already-computed, grounded results into natural-language
explanation (Hybrid Intelligence: deterministic work is verifiable; the model
only narrates it).

Backends (selected by PCISENTINEL_LLM_BACKEND):
  offline   Templated, fully-grounded explanation built from the engine's own
            numbers. Zero external dependencies. Default, and the safe fallback.
  http      OpenAI-compatible REST endpoint (POST /chat/completions, bearer auth).
  sdk       A pluggable Python client whose module and class are themselves named
            in the environment, constructed with model_name=<MODEL> and invoked as
            client.invoke(messages).content. Used for gated enterprise gateways
            that perform their own token exchange / TLS from the same environment.

Any value other than "offline" / "http" / "openai" selects the sdk backend, so a
deployment may use whatever label it likes in its (un-shipped) .env. If the chosen
backend is unavailable for any reason, the client degrades to offline so a run
never breaks.

The local .env is loaded into the process environment at import time, BEFORE the
backend selector is read, so a freshly-started server picks up the configured
backend without the launching shell having to export anything.

Environment:
  PCISENTINEL_LLM_BACKEND     offline | http | sdk   (default: auto)
  PCISENTINEL_LLM_MODEL       model identifier (kept in config/env, never hard-coded)

  # http backend
  PCISENTINEL_LLM_BASE_URL    OpenAI-compatible endpoint
  PCISENTINEL_LLM_API_KEY     bearer credential

  # sdk backend
  PCISENTINEL_LLM_SDK_MODULE  importable module that provides the client class
  PCISENTINEL_LLM_SDK_CLASS   client class name; constructed with model_name=<MODEL>
                              (the client reads its own endpoint / credentials /
                              trust cert from the environment)
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path


def _load_env() -> None:
    """Load the backend .env into os.environ before any selector is read.

    Best-effort and idempotent: tries the .env next to the backend root (one
    level above this package), then a normal upward search from the cwd. Absence
    of python-dotenv or of any .env is not an error — the client simply runs on
    whatever is already in the environment (and ultimately the offline fallback).
    """
    try:
        from dotenv import load_dotenv
    except Exception:  # noqa: BLE001 - dotenv optional; env may already be set
        return
    # .env lives in the backend run dir, i.e. one level up from this package dir.
    backend_env = Path(__file__).resolve().parent.parent / ".env"
    if backend_env.is_file():
        load_dotenv(backend_env, override=False)
    # Fallback: upward search from the current working directory.
    load_dotenv(override=False)


# Load once at import so module-level construction also sees the configured backend.
_load_env()


class LLMClient:
    def __init__(self):
        # Belt-and-suspenders: ensure .env is loaded even if this class is
        # constructed before the module-level load took effect (e.g. odd import
        # ordering or a different cwd). Idempotent; never overrides real env vars.
        _load_env()
        self.base_url = os.environ.get("PCISENTINEL_LLM_BASE_URL", "").rstrip("/")
        self.api_key = os.environ.get("PCISENTINEL_LLM_API_KEY", "")
        self.model = os.environ.get("PCISENTINEL_LLM_MODEL", "")
        backend = os.environ.get("PCISENTINEL_LLM_BACKEND", "").strip().lower()
        if not backend:
            backend = "http" if (self.base_url and self.api_key and self.model) else "offline"
        self.backend = backend
        self.online = backend != "offline"
        self._sdk = None
        self._rate_limited_until = 0.0

    # ---- public API (signatures unchanged) -------------------------------

    def explain(self, system_prompt: str, grounded_facts: dict) -> str:
        if not self.online:
            return self._offline(grounded_facts)
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "Explain ONLY using these grounded facts; do not invent "
                                        "numbers:\n" + json.dumps(grounded_facts, indent=2)},
        ]
        text = self._complete(messages)
        if not text:
            return self._offline(grounded_facts) + "\n\n[note: live explanation unavailable]"
        return text

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
        messages = [{"role": "system", "content": sys}]
        for h in (history or [])[-6:]:
            if h.get("role") in ("user", "assistant") and h.get("content"):
                messages.append({"role": h["role"], "content": str(h["content"])[:2000]})
        messages.append({"role": "user", "content": "FACTS:\n" + json.dumps(facts, indent=2) +
                         "\n\nQUESTION: " + question})
        text = self._complete(messages)
        if not text:
            return ("Could not reach the inference provider. Try a scope, heavy-hitter, hidden-PCI, "
                    "or per-system question.")
        return text

    # ---- backend dispatch -------------------------------------------------

    def _complete(self, messages: list) -> str | None:
        """Route to the configured backend; return text, or None so the caller falls back."""
        if time.time() < self._rate_limited_until:
            return None
        try:
            if self.backend in ("http", "openai"):
                return self._http_complete(messages)
            return self._sdk_complete(messages)
        except Exception:  # noqa: BLE001 - narration must never break the run
            return None

    # ---- http backend (OpenAI-compatible REST) ---------------------------

    def _http_complete(self, messages: list) -> str | None:
        payload = {"model": self.model, "messages": messages, "temperature": 0.2}
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            return data["choices"][0]["message"]["content"]
        except Exception as e:  # noqa: BLE001
            if self._is_rate_limit(e):
                self._rate_limited_until = time.time() + 60
            return None

    # ---- sdk backend (pluggable enterprise client) -----------------------

    def _sdk_client(self):
        if self._sdk is not None:
            return self._sdk
        try:
            import importlib
            mod_name = os.environ.get("PCISENTINEL_LLM_SDK_MODULE", "")
            cls_name = os.environ.get("PCISENTINEL_LLM_SDK_CLASS", "")
            if not mod_name or not cls_name:
                return None
            client_cls = getattr(importlib.import_module(mod_name), cls_name)
            self._sdk = client_cls(model_name=self.model) if self.model else client_cls()
            return self._sdk
        except Exception:  # noqa: BLE001 - missing SDK / bad config -> offline fallback
            return None

    def _sdk_complete(self, messages: list) -> str | None:
        client = self._sdk_client()
        if client is None:
            return None
        try:
            result = client.invoke(messages)
        except Exception as e:  # noqa: BLE001
            if self._is_rate_limit(e):
                self._rate_limited_until = time.time() + 60
            return None
        content = getattr(result, "content", None)
        if content:
            return content
        return result if isinstance(result, str) else None

    # ---- helpers ----------------------------------------------------------

    @staticmethod
    def _is_rate_limit(e: Exception) -> bool:
        s = str(e).lower()
        return "rate_limit" in s or "429" in s

    @staticmethod
    def _offline(f: dict) -> str:
        dist = f.get("top_distributor") or {}
        lever = f.get("top_lever") or {}
        imp = f.get("impact") or {}
        meta = f.get("scope_metadata_confirmed")
        inf = f.get("scope_inferred_only")
        split = ""
        if meta is not None and inf is not None:
            split = (f" Of these, {meta} are confirmed by authoritative BAM metadata and "
                     f"{inf} are inferred-only candidate scope surfaced from survey/Splunk "
                     f"signals (kept separate, never treated as ground truth).")
        downgraded = imp.get("sources_downgraded_count", len(imp.get("sources_downgraded", [])))
        return (
            f"Current state: {f.get('scope_size', '?')} systems fall within PCI scope across "
            f"{f.get('dag_nodes', '?')} data-flow clusters; {f.get('cycle_clusters', 0)} circular "
            f"dependency cluster(s) were resolved into the DAG.{split} The widest PAN distributor is "
            f"{dist.get('system', 'n/a')}, reaching {dist.get('downstream_reach', 0)} downstream systems; "
            f"the highest-leverage single tokenization target is {lever.get('system', 'n/a')}. Because the "
            f"same downstream systems are fed by several PAN sources, no single source frees many on its own — "
            f"so the optimizer selects the minimal set. Tokenizing the recommended source(s) descopes "
            f"{imp.get('nodes_descoped', 0)} systems ({imp.get('node_surface_reduction_pct', 0)}% of the "
            f"in-scope surface), converts {downgraded} source(s) from live PAN to non-transactable tokens, "
            f"and lowers the aggregate risk score by {imp.get('risk_reduction_pct', 0)}% — the clean-stream effect."
        )
