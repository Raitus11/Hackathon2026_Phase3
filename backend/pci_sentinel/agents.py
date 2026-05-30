"""Agent roster for the LangGraph pipeline.

Each entry maps a graph node (which is also the audit `stage` key) to a named
agent, its single responsibility, and the concrete method it uses. `kind`
drives UI colour: deterministic work vs the human gate vs the one LLM step.
This is the source of truth the UI renders so the agentic structure is visible,
and it keeps the "Hybrid Intelligence" claim honest: every agent except the
reporter does verifiable, deterministic work; the LLM only narrates.
"""

ROSTER = [
    {"key": "supervisor", "name": "Supervisor / Orchestrator", "kind": "control",
     "role": "Owns graph state, routing, retries, and the human approval gate.",
     "method": "LangGraph StateGraph — explicit nodes, checkpointed, resumable."},
    {"key": "ingest", "name": "Ingestion & Sanitiser", "kind": "deterministic",
     "role": "Loads the CSV exports, validates schema, and masks PAN on entry.",
     "method": "PAN masked to first-6/last-4 at the boundary; nothing unmasked passes."},
    {"key": "validate_masking_leak", "name": "Masking-Leak Validator", "kind": "deterministic",
     "role": "Fails the entire run if any unmasked PAN escapes ingestion.",
     "method": "Luhn + pattern scan across every ingested cell; raises on any leak."},
    {"key": "build_graph", "name": "Graph Builder", "kind": "deterministic",
     "role": "Builds the system interdependency graph of cardholder-data flow.",
     "method": "Typed MultiDiGraph; metadata (BAM) vs inferred (survey/Splunk) edges kept distinct."},
    {"key": "condense_to_dag", "name": "Cycle Resolver", "kind": "deterministic",
     "role": "Surfaces circular dependencies, then condenses them into a DAG.",
     "method": "Tarjan strongly-connected components -> condensation; acyclicity asserted."},
    {"key": "score", "name": "Quant / Scoring", "kind": "deterministic",
     "role": "Assigns each system a defensible composite risk score.",
     "method": "sensitivity x reachability x betweenness (Brandes) x true-source; bounded 0-100."},
    {"key": "analytics", "name": "Core Analyst", "kind": "deterministic",
     "role": "Computes PCI scope, heavy hitters, clean-stream impact, and hidden scope.",
     "method": "Graph reachability + exclusive-reach set logic; no black boxes."},
    {"key": "human_gate", "name": "Human-in-the-Loop Gate", "kind": "human",
     "role": "Lets a reviewer approve, revise, or abort before anything is reported.",
     "method": "LangGraph interrupt — the run genuinely pauses for a human decision."},
    {"key": "report", "name": "Reporter", "kind": "llm",
     "role": "Narrates the already-computed, grounded numbers in plain language.",
     "method": "LLM constrained to the computed facts only — it explains, it never decides."},
]

ORDER = [a["key"] for a in ROSTER]
