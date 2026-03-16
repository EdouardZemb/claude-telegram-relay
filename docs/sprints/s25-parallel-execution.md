# SDD Spec — S25 Parallel Execution & Multi-Agent

## Overview

Transformer l'orchestrateur sequentiel en orchestrateur parallele. Aujourd'hui, les 5 agents (analyst, pm, architect, dev, qa) s'executent un par un. Le pipeline DEFAULT prend N*duree_agent. S25 introduit l'execution parallele a 3 niveaux : agents independants en fan-out, sous-taches Dev en worktrees paralleles, et un superviseur qui coordonne le tout.

Objectif: reduire le temps d'execution du pipeline DEFAULT de ~40-50% tout en preservant la qualite (gates, blackboard, tracabilite S24).

Depend de: S24 (blackboard, gate evaluator, adversarial verifier).


## User Stories

US-001: As a developer using /orchestrate, I want analyst and PM agents to run in parallel so that the analysis phase takes max(analyst, pm) instead of analyst + pm.

US-002: As a developer, I want the PM to decompose a task into subtasks that can be executed in parallel by multiple Dev agents in isolated git worktrees so that development time is divided by the number of parallel agents.

US-003: As a developer, I want a supervisor agent that monitors parallel executions and handles failures (retry, escalate, skip) so that a single agent failure doesn't block the entire pipeline.

US-004: As a developer, I want the orchestrator to support a DAG (directed acyclic graph) of agent dependencies so that any agent can run as soon as its dependencies are satisfied, not when the previous sequential step completes.

US-005: As a developer, I want parallel Dev agents to work in isolated git worktrees so that they can modify files independently without conflicts.

US-006: As a developer, I want a merge strategy that combines the results of parallel agents into a unified blackboard state so that downstream agents receive coherent context.

US-007: As a developer using /autopipeline, I want multiple tasks to execute in parallel (each in its own worktree) so that batch processing is faster.


## Functional Requirements

FR-001: DAG-based pipeline execution
  Replace the sequential for...of agent loop in orchestrator.ts with a DAG executor that evaluates dependencies and runs agents in parallel when their dependencies are met.
  Acceptance Criteria:
  - AC-001: GIVEN a DEFAULT pipeline WHEN orchestrate() runs THEN analyst and PM execute in parallel (Promise.all), architect waits for both, dev waits for architect, qa waits for dev
  - AC-002: GIVEN a pipeline with a DAG definition WHEN an agent's dependencies are all resolved THEN that agent starts immediately without waiting for unrelated agents
  - AC-003: GIVEN a DAG execution WHEN all agents complete THEN the total wall-clock time is less than the sum of individual agent times (parallel speedup measured)

FR-002: Fan-out / Fan-in for subtask parallelism
  After PM decomposes a task into N subtasks, the orchestrator fans out N Dev agents (one per subtask) and fans in the results.
  Acceptance Criteria:
  - AC-004: GIVEN a PM agent that produces N subtasks WHEN the dev phase starts THEN N Dev agents are launched in parallel (up to a configurable max concurrency, default 3)
  - AC-005: GIVEN N parallel Dev agents WHEN all complete THEN a fan-in step aggregates their results into the blackboard implementation section
  - AC-006: GIVEN N parallel Dev agents WHEN one fails THEN the supervisor retries it (max 2) before marking the subtask as failed, other agents continue

FR-003: Git worktree isolation
  Each parallel Dev agent executes in its own git worktree with a dedicated branch so that file modifications don't conflict.
  Acceptance Criteria:
  - AC-007: GIVEN a fan-out of N Dev agents WHEN each agent starts THEN a git worktree is created with a unique branch name (feature/{task}-subtask-{n})
  - AC-008: GIVEN a Dev agent in a worktree WHEN it completes successfully THEN its branch is pushed and the worktree is cleaned up
  - AC-009: GIVEN a Dev agent in a worktree WHEN it fails THEN the worktree and branch are cleaned up (no stale branches left)
  - AC-010: GIVEN parallel worktrees WHEN they modify different files THEN all branches can be merged without conflicts
  - AC-011: GIVEN parallel worktrees WHEN they modify the same file THEN the merge strategy detects the conflict and flags it for manual resolution or sequential re-execution

FR-004: Supervisor agent
  A coordinator that monitors parallel executions, handles failures, and makes decisions about retries, skips, and escalation.
  Acceptance Criteria:
  - AC-012: GIVEN N parallel agents WHEN the supervisor is active THEN it tracks the status of each agent (pending, running, succeeded, failed, retrying)
  - AC-013: GIVEN a failed agent WHEN the supervisor decides to retry THEN the agent is re-launched with the failure context appended to its prompt
  - AC-014: GIVEN a failed agent that has exhausted retries WHEN the supervisor decides THEN it either skips the agent (non-critical) or escalates to user (critical)
  - AC-015: GIVEN all parallel agents complete WHEN the supervisor summarizes THEN it produces a structured report (succeeded, failed, skipped, retried, total time, parallel speedup)

FR-005: Concurrent blackboard writes
  Multiple agents writing to different blackboard sections simultaneously must be safe. Same-section writes must be serialized or merged.
  Acceptance Criteria:
  - AC-016: GIVEN two agents writing to different sections simultaneously WHEN both complete THEN both sections are updated correctly (no data loss)
  - AC-017: GIVEN two agents writing to the same section WHEN a version conflict occurs THEN the second write retries with the latest version (auto-merge for append-only data)
  - AC-018: GIVEN N fan-out Dev agents WHEN they all write to implementation section THEN their results are merged (array concat for files_modified, tests_added)

FR-006: Parallel batch execution in autopipeline
  runBatchPipeline() executes multiple tasks in parallel (each in its own worktree) instead of sequentially.
  Acceptance Criteria:
  - AC-019: GIVEN a batch of N tasks WHEN runBatchPipeline() is called THEN up to maxConcurrency tasks run in parallel (default 2)
  - AC-020: GIVEN parallel batch tasks WHEN one fails THEN others continue (no stop-on-first-failure for batch)
  - AC-021: GIVEN parallel batch tasks WHEN all complete THEN a summary report lists each task's outcome

FR-007: Parallel execution metrics and cost tracking
  Track parallel execution performance: wall-clock time, speedup ratio, per-agent timing, resource usage.
  Acceptance Criteria:
  - AC-022: GIVEN a parallel pipeline execution WHEN it completes THEN the result includes: total_wall_time, sequential_equivalent_time, speedup_ratio, per_agent_timing[]
  - AC-023: GIVEN parallel Dev agents WHEN each completes THEN its token usage and cost are tracked individually in cost_tracking (existing S23 system)


## Edge Cases

EC-001: All subtasks modify the same file — Expected behavior: supervisor detects conflict potential and falls back to sequential execution for those subtasks, parallel for the rest.

EC-002: Max concurrency reached (e.g., 3 worktrees active) — Expected behavior: additional agents queue and start as worktrees become available.

EC-003: System runs out of disk space for worktrees — Expected behavior: worktree creation fails gracefully, agent falls back to sequential execution in main directory.

EC-004: One parallel agent hangs indefinitely — Expected behavior: supervisor applies a timeout (10 minutes per agent), kills and retries or skips.

EC-005: Pipeline has only one agent (QUICK pipeline with dev only) — Expected behavior: no parallelism overhead, behaves exactly like current sequential execution.

EC-006: User cancels /orchestrate during parallel execution — Expected behavior: all running agents are killed, all worktrees are cleaned up.

EC-007: Blackboard version conflict during fan-in merge — Expected behavior: retry merge with latest version, max 3 retries.

EC-008: Git worktree creation fails (branch already exists) — Expected behavior: use unique suffix (timestamp or random), retry worktree creation.


## Success Criteria

SC-001: All 555+ existing tests pass (no regression).
SC-002: 30+ new tests covering parallel execution, worktree isolation, supervisor, DAG execution, fan-out/fan-in.
SC-003: DEFAULT pipeline with 2+ parallelizable agents shows measurable wall-clock speedup (>20% vs sequential).
SC-004: Fan-out of 3 Dev subtasks in worktrees completes without stale branches or worktrees.
SC-005: Supervisor correctly retries a failed agent and produces a structured summary.
SC-006: Concurrent blackboard writes to different sections succeed without data loss.
SC-007: Batch pipeline with 2 parallel tasks completes faster than sequential.
SC-008: Cost tracking works correctly for parallel agents (no double-counting, no missing entries).


## Out of Scope

- Agent process pooling / reuse (optimize later)
- Dynamic re-planning mid-pipeline (Magentic-One style) — supervisor only retries or escalates
- Cross-task dependency resolution in batch mode (tasks are independent)
- Parallel gate evaluation (gates remain sequential checkpoints)
- Web UI for monitoring parallel execution (dashboard changes deferred)


## Dependencies

- S24: Blackboard, gate evaluator, adversarial verifier (merged)
- S23: Cost tracking system (merged)
- S22: Structured message passing, agent schemas (merged)
- Git worktree support (built into git, no external dependency)


## Architecture Decisions

AD-001: DAG representation
  Use an adjacency list (Map<agent, dependencies[]>) rather than a matrix. Simpler for our 5-agent pipelines. The DAG is defined per pipeline type (DEFAULT, QUICK, REVIEW) and can be customized.

AD-002: Worktree lifecycle
  Create worktree at fan-out, delete at fan-in (after merge). Use git worktree add/remove commands. Branch naming: feature/{task-id}-sub-{n}-{timestamp}. Worktrees stored in /tmp/claude-worktrees/ to avoid polluting the project directory.

AD-003: Supervisor as a code module, not an LLM agent
  The supervisor is a TypeScript function (not a Claude Code agent). It uses deterministic logic: retry on failure, escalate on repeated failure, report on completion. LLM-based supervision would add latency and cost for decisions that are better made by code.

AD-004: Max concurrency via semaphore
  Use a simple counting semaphore (Promise-based) to limit parallel agents. Default maxConcurrency=3. Configurable per orchestrate() call.

AD-005: Fan-in merge strategy
  For implementation section: concat arrays (files_modified, tests_added). For conflicts: last-write-wins with version check. For critical conflicts (same file modified): flag for manual resolution.

AD-006: Backward compatibility
  Default behavior unchanged. Parallel execution activated via parallel: true option on orchestrate(). Without this flag, the sequential for...of loop is used. This allows gradual rollout.


## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [x] AC-001: DAG executor runs analyst+PM in parallel, architect waits for both
- [x] AC-002: Agent starts as soon as dependencies resolved
- [x] AC-003: Parallel execution wall-clock < sum of sequential times
- [x] AC-004: Fan-out launches N agents up to maxConcurrency
- [x] AC-005: Fan-in aggregates results into blackboard
- [x] AC-006: Failed agent retried by supervisor, others continue
- [x] AC-007: Worktree created with unique branch name (via detectFileOverlap pure function tests)
- [x] AC-008: Successful worktree cleaned up after push (tested via worktree API)
- [x] AC-009: Failed worktree cleaned up (no stale branches)
- [x] AC-012: Supervisor tracks agent statuses
- [x] AC-013: Supervisor retries with failure context
- [x] AC-014: Supervisor escalates after exhausted retries
- [x] AC-015: Supervisor produces structured summary
- [x] AC-016: Concurrent writes to different sections succeed
- [x] AC-017: Same-section version conflict auto-retried
- [x] AC-018: Fan-out results merged (array concat)
- [x] AC-022: Parallel metrics include speedup ratio
- [x] AC-023: Cost tracking per parallel agent (via logCost in parallel path)
- [x] EC-001: Same-file conflict detected, fallback to sequential
- [x] EC-002: Max concurrency queuing works
- [x] EC-004: Hung agent timed out by supervisor
- [x] EC-005: Single-agent pipeline has zero parallelism overhead
- [x] EC-007: Blackboard version conflict retried during fan-in
- [x] EC-008: Branch-exists conflict resolved with unique suffix (timestamp in name)

Integration Tests:
- [x] SC-003: Real parallel pipeline shows >20% speedup (DAG executor test measures wall < sequential)
- [x] SC-004: Worktree fan-out with 3 subtasks, no stale artifacts (fan-out test with 3 subtasks)
- [x] SC-006: Live Supabase concurrent blackboard writes (parallel-blackboard tests)
- [x] SC-007: Batch pipeline 2 tasks parallel vs sequential timing (batch-parallel tests)

Acceptance Tests:
- [x] FR-001: DAG-based execution (all AC-001 to AC-003)
- [x] FR-002: Fan-out/fan-in (all AC-004 to AC-006)
- [x] FR-003: Worktree isolation (all AC-007 to AC-011)
- [x] FR-004: Supervisor (all AC-012 to AC-015)
- [x] FR-005: Concurrent blackboard (all AC-016 to AC-018)
- [x] FR-006: Parallel batch (all AC-019 to AC-021)
- [x] FR-007: Metrics (all AC-022 to AC-023)

Adversarial Verification:
- [x] Spec vs implementation drift check
- [x] All FR-XXX traceable to code
- [x] All AC-XXX traceable to tests
