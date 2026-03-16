# SDD Spec — S34 Fondations Qualite + Routage

## Overview

Sprint S34 pose les fondations pour l'auto-amelioration et l'autonomie progressive. Deux axes : rendre les gates plus intelligentes (verification duale + scoring structure) et reduire les couts d'execution (routage en cascade + routeur LLM dynamique).

## User Stories

US-001: As a developer, I want gate evaluation to run deterministic checks (tsc, bun test) before the LLM judge so that obvious failures are caught cheaply and fast.
US-002: As a developer, I want gate scoring to use a structured rubric (4 dimensions x 25 points) so that I get actionable feedback instead of a binary pass/fail.
US-003: As a developer, I want agent execution to cascade from cheaper to more expensive models so that simple tasks don't waste Opus budget.
US-004: As a developer, I want pipeline selection to use an LLM router instead of keyword matching so that task routing is more accurate.

## Functional Requirements

FR-001: Dual verification in gate evaluator — deterministic checks before LLM judge
  Acceptance Criteria:
  - AC-001: GIVEN a gate evaluation request WHEN the gate is "implementation" THEN tsc type check runs before the LLM evaluation
  - AC-002: GIVEN a gate evaluation request WHEN the gate is "implementation" THEN bun test runs before the LLM evaluation
  - AC-003: GIVEN deterministic checks fail WHEN evaluating a gate THEN the gate fails immediately without calling the LLM (cost saving)
  - AC-004: GIVEN deterministic checks pass WHEN evaluating a gate THEN the LLM judge runs with the check results as additional context
  - AC-005: GIVEN a non-implementation gate (spec, plan, tasks) WHEN evaluating THEN only the LLM judge runs (no deterministic checks applicable)

FR-002: Structured rubric scoring for gates
  Acceptance Criteria:
  - AC-006: GIVEN a gate evaluation WHEN the LLM judge scores THEN it returns 4 dimension scores: error_handling (0-25), test_coverage (0-25), code_style (0-25), spec_conformity (0-25)
  - AC-007: GIVEN dimension scores WHEN computing total THEN total = sum of 4 dimensions (0-100 scale preserved)
  - AC-008: GIVEN a gate evaluation result WHEN reporting THEN each dimension score is visible with specific feedback per dimension
  - AC-009: GIVEN an evaluation WHEN a specific dimension scores below 10 THEN it is flagged as "critical weakness" in the feedback
  - AC-010: GIVEN gate type is "spec" or "plan" WHEN scoring THEN dimensions adapt: completeness, traceability, clarity, feasibility (instead of code-focused dimensions)

FR-003: Model cascade routing — Haiku -> Sonnet -> Opus
  Acceptance Criteria:
  - AC-011: GIVEN a spawnClaude call with cascade enabled WHEN executing THEN the cheapest model (Haiku) is tried first
  - AC-012: GIVEN the current model fails or produces low-quality output WHEN cascade is active THEN the next more expensive model is tried automatically
  - AC-013: GIVEN cascade escalation WHEN moving to a more expensive model THEN the failure reason from the previous attempt is included in the prompt context
  - AC-014: GIVEN cascade completes at any level WHEN logging THEN the final model used and number of escalations are recorded in cost_tracking
  - AC-015: GIVEN cascade is not enabled WHEN spawnClaude is called THEN behavior is unchanged (backward compatible, direct model from bmad-agents.ts)

FR-004: LLM router for dynamic pipeline selection
  Acceptance Criteria:
  - AC-016: GIVEN a task with autoPipeline enabled WHEN selecting pipeline THEN a Haiku call analyzes the task and returns pipeline type + per-role model overrides + budget
  - AC-017: GIVEN the LLM router response WHEN parsing THEN it returns a structured JSON: {pipeline, models: {analyst, pm, architect, dev, qa}, budget, reasoning}
  - AC-018: GIVEN LLM router fails or times out (5s) WHEN selecting pipeline THEN fallback to current keyword-based classifyPipeline()
  - AC-019: GIVEN the router selects models WHEN passing to orchestrator THEN per-role model overrides are respected by spawnClaude
  - AC-020: GIVEN the router response WHEN logging THEN the router's reasoning and cost ($0.01-0.02 per call) are logged

## Edge Cases

EC-001: Deterministic checks timeout (tsc hangs) — Expected: 30s timeout per check, gate continues to LLM judge with timeout warning
EC-002: LLM router returns invalid JSON — Expected: fallback to keyword-based classifyPipeline(), log warning
EC-003: Cascade exhausts all 3 model tiers — Expected: return failure from Opus attempt, do not retry further
EC-004: Gate evaluation with rubric on a non-code gate (spec) — Expected: use adapted dimensions (completeness, traceability, clarity, feasibility)
EC-005: LLM router suggests a model not in the pricing table — Expected: fallback to Sonnet pricing for cost estimation
EC-006: Cascade enabled but task has explicit model override — Expected: explicit override takes precedence, no cascade
EC-007: Multiple deterministic checks, first passes but second fails — Expected: gate fails, report shows which check failed

## Success Criteria

SC-001: All 854+ existing tests pass (zero regression)
SC-002: 40+ new tests added covering all AC and EC items
SC-003: Gate evaluation costs reduced by skipping LLM on obvious failures (deterministic checks catch errors first)
SC-004: Cost tracking records model used and cascade escalation count
SC-005: LLM router produces valid pipeline selection on test tasks
SC-006: CLAUDE.md updated with new/modified modules
SC-007: Backward compatibility: all existing orchestrate/exec/autopipeline flows work without changes when cascade/router are not explicitly enabled

## Out of Scope

- Trust scores and autonomy progression (S35)
- Double-loop learning from gate feedback (S35)
- Intent detection improvements (S37)
- Dashboard/UI changes
- Modifying the gate threshold (stays at 60)
- Changing agent personas or prompts (beyond routing)

## Dependencies

- S33 MCP dynamic config (merged)
- S33 pipeline checkpoint/resume (merged)
- Current gate-evaluator.ts, auto-pipeline.ts, bmad-agents.ts, agent.ts, cost-tracking.ts

## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [ ] AC-001: tsc runs before LLM on implementation gate
- [ ] AC-002: bun test runs before LLM on implementation gate
- [ ] AC-003: deterministic failure skips LLM call
- [ ] AC-004: deterministic pass feeds results to LLM
- [ ] AC-005: non-implementation gates skip deterministic checks
- [ ] AC-006: rubric returns 4 dimension scores
- [ ] AC-007: total score = sum of 4 dimensions
- [ ] AC-008: feedback includes per-dimension detail
- [ ] AC-009: dimension below 10 flagged as critical
- [ ] AC-010: adapted dimensions for spec/plan gates
- [ ] AC-011: cascade starts with cheapest model
- [ ] AC-012: cascade escalates on failure
- [ ] AC-013: failure reason included in escalated prompt
- [ ] AC-014: cascade logs final model and escalation count
- [ ] AC-015: no cascade when not enabled
- [ ] AC-016: LLM router analyzes task and returns structured result
- [ ] AC-017: router response parsed as structured JSON
- [ ] AC-018: router fallback on failure/timeout
- [ ] AC-019: per-role model overrides respected
- [ ] AC-020: router reasoning and cost logged
- [ ] EC-001: deterministic check timeout (30s)
- [ ] EC-002: router invalid JSON fallback
- [ ] EC-003: cascade exhausts all tiers
- [ ] EC-004: rubric adapted dimensions for spec gate
- [ ] EC-005: unknown model fallback pricing
- [ ] EC-006: explicit model override disables cascade
- [ ] EC-007: partial deterministic check failure

Integration Tests:
- [ ] SC-005: LLM router on real task descriptions
- [ ] SC-007: existing orchestrate flow unchanged

Acceptance Tests:
- [ ] FR-001: All AC-001 to AC-005 satisfied
- [ ] FR-002: All AC-006 to AC-010 satisfied
- [ ] FR-003: All AC-011 to AC-015 satisfied
- [ ] FR-004: All AC-016 to AC-020 satisfied

Adversarial Verification:
- [ ] Spec vs implementation drift check
- [ ] All FR-XXX traceable to code
- [ ] All AC-XXX traceable to tests
