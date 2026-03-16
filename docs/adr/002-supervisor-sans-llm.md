# ADR-002: Deterministic TypeScript Supervisor (Zero LLM Cost)

## Date
2026-03-15

## Status
Accepted

## Context
The parallel execution system (S25) needs a supervisor to handle agent failures during DAG execution. Options: LLM-based supervisor (asks Claude to decide retry/skip/escalate) or deterministic TypeScript logic.

LLM-based supervision adds cost per decision, latency, and unpredictability. The retry/skip/escalate decision tree is simple and well-defined: retry up to N times with backoff, skip non-critical agents, escalate if critical agent fails after retries.

## Decision
Implement supervisor as pure TypeScript with deterministic rules. No LLM calls. Decision logic: retry (if attempts < maxRetries), skip (if agent is non-critical and retries exhausted), escalate (if critical agent fails). Produces a structured report with timing, speedup ratio, and per-agent status.

## Consequences
- Zero additional cost for supervision (was a key goal)
- Predictable behavior, easy to test (100% deterministic)
- Cannot handle novel failure modes that require reasoning
- If we need smarter recovery (e.g., "this error means we should change the prompt"), we'd need to add LLM calls selectively
- The simplicity makes it easy to extend the decision tree later
