# SDD Spec — S24 Gated Blackboard & SDD

## Overview

Transformer l'orchestration multi-agents en architecture "Gated Blackboard with Adversarial Evaluation". Le blackboard est un espace de travail JSON versionne dans Supabase. Chaque phase du pipeline SDD (spec, plan, tasks, implementation) ecrit dans le blackboard. Un agent evaluateur valide chaque gate avant de passer a la phase suivante. Un adversarial verifier en fin de pipeline detecte les drifts entre spec et implementation.

Objectif: remplacer le text concat entre agents par un espace structure, ajouter des boucles evaluate-rework a chaque gate, et garantir la tracabilite FR->tache->test->code.


## User Stories

US-001: As a developer using /orchestrate, I want agents to read/write structured data from a shared blackboard so that context is preserved between agents without token waste on raw text concat.

US-002: As a developer, I want each gate in the pipeline to be evaluated by an independent evaluator agent so that quality issues are caught before the next phase starts.

US-003: As a developer, I want the evaluator to loop back (max 2 iterations) when it rejects a gate so that agents can self-correct without human intervention.

US-004: As a developer, I want an adversarial verifier at the end of the pipeline that compares the original spec to the final implementation so that spec drift is detected.

US-005: As a developer, I want the SDD spec template to be the first step of every sprint so that requirements are explicit before any code is written.

US-006: As a developer, I want traceability from FR-XXX to tasks to tests to code changes in the blackboard so that nothing falls through the cracks.


## Functional Requirements

FR-001: Blackboard table in Supabase
  A versioned JSONB document per pipeline execution, with sections: spec, plan, tasks, implementation, verification.
  Acceptance Criteria:
  - AC-001: GIVEN a new orchestration run WHEN the pipeline starts THEN a blackboard row is created in Supabase with a unique session_id, task_id, and version=1
  - AC-002: GIVEN a blackboard row exists WHEN an agent writes to a section THEN the version is incremented and the section is updated atomically
  - AC-003: GIVEN two concurrent writes to the same blackboard WHEN a version conflict occurs THEN the second write fails with a clear error (optimistic locking)

FR-002: Blackboard read/write API
  TypeScript module (src/blackboard.ts) with typed read/write functions per section.
  Acceptance Criteria:
  - AC-004: GIVEN a blackboard session WHEN readSection("spec") is called THEN only the spec section is returned (not the entire document)
  - AC-005: GIVEN an agent role WHEN writeSection is called THEN only the sections that role is authorized to write are accepted
  - AC-006: GIVEN a blackboard session WHEN getFullBlackboard is called THEN the entire document with all sections and metadata is returned

FR-003: Gate Evaluator agent
  An agent that receives the output of a phase and evaluates it against defined criteria. Returns pass/fail with structured feedback.
  Acceptance Criteria:
  - AC-007: GIVEN a completed spec phase WHEN the evaluator runs THEN it checks: all FR have AC in GIVEN/WHEN/THEN format, edge cases are defined, success criteria are measurable
  - AC-008: GIVEN a completed plan phase WHEN the evaluator runs THEN it checks: architecture covers all FR, interfaces are defined, migration plan exists if needed
  - AC-009: GIVEN a completed tasks phase WHEN the evaluator runs THEN it checks: every task traces to an FR, test plan covers all AC, dependencies are explicit
  - AC-010: GIVEN the evaluator returns a structured JSON result THEN the result contains: pass (boolean), score (0-100), issues (array of {severity, description, suggestion}), and gate_name

FR-004: Evaluate-rework loop
  When the evaluator rejects a gate, the producing agent is re-run with the evaluator's feedback. Max 2 iterations per gate.
  Acceptance Criteria:
  - AC-011: GIVEN the evaluator rejects a gate WHEN the rework loop runs THEN the producing agent receives the evaluator's feedback as additional context
  - AC-012: GIVEN the rework loop reaches max iterations (2) WHEN the evaluator still rejects THEN the pipeline continues with a warning logged and the issue flagged in the blackboard
  - AC-013: GIVEN a rework iteration WHEN the agent produces new output THEN the blackboard version is incremented and the previous version is preserved in history

FR-005: Adversarial Verifier agent
  An independent agent that receives only the original spec and the final implementation (no intermediate context). Detects drift.
  Acceptance Criteria:
  - AC-014: GIVEN the implementation is complete WHEN the verifier runs THEN it receives only blackboard.spec and blackboard.implementation (not plan or tasks)
  - AC-015: GIVEN the verifier compares spec to implementation THEN it produces: coverage_score (0-100), drift_items (array of {fr_id, status: implemented|missing|partial|divergent, details}), and overall_verdict
  - AC-016: GIVEN the verifier finds missing requirements THEN the drift report is stored in blackboard.verification and logged to workflow_logs

FR-006: Orchestrator integration
  The orchestrator uses the blackboard instead of AgentMessage text concat for passing context between agents.
  Acceptance Criteria:
  - AC-017: GIVEN a pipeline with autoPipeline WHEN the orchestrator runs THEN each agent reads from the blackboard instead of receiving raw text from previous agents
  - AC-018: GIVEN an agent produces structured output WHEN it completes THEN the output is written to the appropriate blackboard section
  - AC-019: GIVEN the existing orchestrate() function WHEN called with useBlackboard: true option THEN it uses the blackboard flow; when false or omitted, it uses the legacy flow (backward compatible)

FR-007: Traceability in blackboard
  Each task, test, and code change traces back to an FR-XXX from the spec.
  Acceptance Criteria:
  - AC-020: GIVEN a task in the blackboard.tasks section THEN it has a traces_to field with one or more FR-XXX identifiers
  - AC-021: GIVEN a test in the blackboard.verification section THEN it has a validates field with one or more AC-XXX identifiers
  - AC-022: GIVEN the full blackboard WHEN a traceability report is generated THEN it shows which FR are covered, partially covered, or missing

FR-008: SDD spec template integration
  The existing config/spec-template.md is used as the starting point for the spec phase in blackboard pipelines.
  Acceptance Criteria:
  - AC-023: GIVEN a new blackboard pipeline starts WHEN the spec phase begins THEN the spec template structure is loaded into blackboard.spec as the initial skeleton


## Edge Cases

EC-001: Empty blackboard section — When an agent reads a section that hasn't been written yet, return null (not error). The agent should handle missing upstream data gracefully.

EC-002: Very large agent output — When an agent produces output exceeding 50KB, truncate to the structured fields only and log a warning. Store full output in a separate overflow field.

EC-003: Concurrent pipeline runs — Two pipelines for different tasks can run simultaneously. Each has its own blackboard session_id. No cross-contamination.

EC-004: Evaluator timeout — If the evaluator agent takes more than 120 seconds, treat as a pass with a warning (don't block the pipeline).

EC-005: Legacy pipeline compatibility — Existing /orchestrate and /autopipeline calls without useBlackboard continue to work exactly as before. No breaking changes.

EC-006: Adversarial verifier on QUICK pipeline — For QUICK pipelines (dev+qa only), the adversarial verifier is skipped (no spec to verify against). Log skip reason.

EC-007: Blackboard version overflow — If version exceeds 100 for a single session (excessive rework), log an anomaly alert and cap further writes.

EC-008: Database unavailable — If Supabase is unreachable during blackboard write, fall back to in-memory blackboard for the current run. Log warning.


## Success Criteria

SC-001: All existing 508+ tests pass (no regressions)
SC-002: 30+ new tests covering blackboard CRUD, evaluator, rework loop, verifier, traceability
SC-003: Migration applies cleanly on Supabase
SC-004: /orchestrate with useBlackboard: true runs a full DEFAULT pipeline with evaluator gates
SC-005: Adversarial verifier produces a drift report with FR coverage
SC-006: Legacy /orchestrate (without useBlackboard) works identically to S23
SC-007: Rework loop correctly re-runs an agent with feedback (manual test on dev environment)
SC-008: Traceability report shows FR->task->test mapping from blackboard


## Out of Scope

- Multi-agent parallel execution (S25)
- Git worktrees for parallel agents (S25)
- Notification batching and quiet hours (S26)
- Real-time blackboard UI in the dashboard (future)
- Cross-project blackboard sharing (future)
- Automatic spec generation from user messages (future — requires NLP pipeline)


## Dependencies

- S22 structured message passing (AgentMessage, agent-schemas.ts) — already merged
- S23 cost tracking and workflow enforcement — already merged
- Supabase MCP for migration application
- Claude CLI for agent execution


## Architecture Decisions

AD-001: Blackboard as single JSONB column (not separate tables per section)
  Rationale: Simpler schema, atomic reads/writes, versioning is trivial (just increment). Sections are accessed via typed TypeScript getters.
  Alternative rejected: Separate tables per section — more complex joins, harder to version atomically.

AD-002: Optimistic locking via version number (not row-level locking)
  Rationale: Supabase doesn't support SELECT ... FOR UPDATE well. Version check in UPDATE WHERE is simple and sufficient for our sequential pipeline.
  Alternative rejected: PostgreSQL advisory locks — overkill for sequential agent execution.

AD-003: Evaluator as a separate Claude CLI call (not an in-process function)
  Rationale: The evaluator needs LLM reasoning to assess quality. An in-process function can only do structural checks. The LLM evaluator catches semantic issues.
  Alternative rejected: Rule-based evaluator — too rigid, can't assess "does this architecture cover the spec".

AD-004: Backward-compatible opt-in via useBlackboard flag
  Rationale: Don't break existing pipelines. Users can try the blackboard flow when ready. Can be made default in a future sprint.
  Alternative rejected: Force all pipelines through blackboard — too risky for a single sprint.

AD-005: Adversarial verifier receives only spec + implementation (not plan/tasks)
  Rationale: This is the "clean room" principle. The verifier shouldn't be biased by intermediate decisions. It answers only: "does the code satisfy the spec?"
  Alternative rejected: Give full context — defeats the purpose of adversarial verification.


## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [x] AC-001: createBlackboard creates a row with version=1 and empty sections
- [x] AC-002: writeSection increments version and updates the correct section
- [x] AC-003: writeSection with stale version returns error (optimistic locking)
- [x] AC-004: readSection returns only the requested section
- [x] AC-005: writeSection rejects writes from unauthorized roles
- [x] AC-006: getFullBlackboard returns all sections and metadata
- [x] AC-010: evaluator output matches expected schema (pass, score, issues, gate_name)
- [x] AC-011: rework loop passes evaluator feedback to producing agent
- [x] AC-012: rework loop stops after max 2 iterations and logs warning
- [x] AC-013: rework increments blackboard version
- [x] AC-015: verifier output matches expected schema (coverage_score, drift_items, verdict)
- [x] AC-019: orchestrate with useBlackboard=false uses legacy flow (backward compatible, EC-005)
- [x] AC-020: tasks in blackboard have traces_to field
- [x] AC-021: tests in blackboard have validates field
- [x] AC-022: traceability report covers all FR
- [x] AC-023: spec phase loads template skeleton (integration in orchestrator.ts)
- [x] EC-001: readSection on empty section returns null
- [x] EC-002: large output is truncated with warning (writeSection overflow handling)
- [x] EC-003: concurrent sessions don't cross-contaminate
- [x] EC-005: legacy orchestrate works without changes
- [x] EC-006: QUICK pipeline skips adversarial verifier
- [x] EC-007: version overflow triggers alert

Integration Tests:
- [x] SC-003: migration applies cleanly on Supabase (blackboard table, indexes, RLS)
- [x] SC-004: full DEFAULT pipeline with evaluator gates runs end-to-end (orchestrator integration)
- [x] SC-005: adversarial verifier produces drift report (parseDriftReport tests)
- [x] SC-007: rework loop re-runs agent with feedback (evaluateAndRework with customEvaluator)

Acceptance Tests:
- [x] FR-001: blackboard CRUD in Supabase works correctly
- [x] FR-002: typed read/write API works for all sections
- [x] FR-003: evaluator produces pass/fail with structured feedback
- [x] FR-004: rework loop self-corrects within 2 iterations
- [x] FR-005: verifier detects missing/divergent requirements
- [x] FR-006: orchestrator uses blackboard when option is set
- [x] FR-007: traceability report is complete
- [x] FR-008: spec template is loaded at pipeline start

Adversarial Verification:
- [x] Spec vs implementation drift check
- [x] All FR-XXX traceable to code
- [x] All AC-XXX traceable to tests
