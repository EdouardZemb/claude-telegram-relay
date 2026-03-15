# S25 Task Breakdown — Parallel Execution & Multi-Agent

## Task List

### T1: Semaphore module (`src/semaphore.ts`)
- Priority: P1
- Estimate: 0.5h
- Dependencies: none
- FR: FR-002, FR-006
- AC: AC-004 (maxConcurrency), AC-019 (batch concurrency), EC-002 (queuing)

Promise-based counting semaphore. acquire() blocks when at capacity, release() unblocks next waiter. Constructor takes maxConcurrency (default 3). Used by DAG executor, fan-out, and batch pipeline.

Tests (3):
- semaphore respects maxConcurrency limit (EC-002)
- semaphore releases in FIFO order
- semaphore with concurrency 1 behaves as mutex

Files: src/semaphore.ts, tests/unit/semaphore.test.ts


### T2: DAG executor module (`src/dag-executor.ts`)
- Priority: P1
- Estimate: 3h
- Dependencies: T1
- FR: FR-001
- AC: AC-001, AC-002, AC-003, EC-005

Core engine replacing sequential for...of loop. DAGNode with status tracking. 3 pre-defined DAGs (DEFAULT, QUICK, REVIEW). Algorithm: find unblocked nodes -> launch via Promise.all with semaphore -> repeat until all terminal. Agnostic to agents/blackboard (receives graph + callback).

Tests (8):
- DEFAULT_DAG: analyst+PM parallel, architect waits for both (AC-001)
- Agent starts as soon as deps resolved (AC-002)
- Parallel wall-clock < sequential sum (AC-003)
- QUICK_DAG: dev only, no parallelism overhead (EC-005)
- REVIEW_DAG: qa then architect
- Failed node blocks dependents
- All nodes reach terminal state
- Empty DAG completes immediately

Files: src/dag-executor.ts, tests/unit/dag-executor.test.ts


### T3: Worktree manager module (`src/worktree.ts`)
- Priority: P1
- Estimate: 2h
- Dependencies: none (parallelizable with T1, T2, T4, T5)
- FR: FR-003
- AC: AC-007, AC-008, AC-009, AC-010, AC-011, EC-003, EC-008

Git worktree lifecycle: createWorktree (in /tmp/claude-worktrees/), pushWorktree, mergeWorktrees, cleanupWorktree, cleanupAllWorktrees. Branch naming with timestamp for collision avoidance. Disk space fallback (EC-003). Conflict detection on merge.

Tests (7):
- createWorktree produces unique branch name (AC-007, EC-008)
- pushWorktree pushes and cleanup removes worktree (AC-008)
- Failed worktree cleaned up, no stale branches (AC-009)
- mergeWorktrees with different files succeeds (AC-010)
- mergeWorktrees with same file detects conflict (AC-011)
- Disk full falls back gracefully (EC-003)
- cleanupAllWorktrees removes all stale worktrees

Files: src/worktree.ts, tests/unit/worktree.test.ts


### T4: Supervisor module (`src/supervisor.ts`)
- Priority: P1
- Estimate: 2.5h
- Dependencies: none (parallelizable with T1, T2, T3, T5)
- FR: FR-004
- AC: AC-012, AC-013, AC-014, AC-015, EC-004

TypeScript deterministic supervisor (zero LLM cost). Tracks agent statuses (pending, running, succeeded, failed, retrying, skipped, timed_out). Decision logic: retry if attempts < max, skip if non-critical (analyst, sm), escalate otherwise. Timeout 10min per agent. Produces SupervisorReport with speedup ratio.

Tests (7):
- Supervisor tracks all agent statuses (AC-012)
- Retry with failure context in prompt (AC-013)
- Escalate after exhausted retries for critical agent (AC-014)
- Skip non-critical agent (analyst, sm) after exhausted retries (AC-014)
- Produces structured summary report (AC-015)
- Timeout kills hung agent (EC-004)
- Report includes speedup_ratio and per_agent_timing

Files: src/supervisor.ts, tests/unit/supervisor.test.ts


### T5: Concurrent blackboard extension (`src/blackboard.ts`)
- Priority: P1
- Estimate: 1.5h
- Dependencies: none (parallelizable with T1, T2, T3, T4)
- FR: FR-005
- AC: AC-016, AC-017, AC-018, EC-007

Extend blackboard.ts with writeSectionWithRetry (auto-retry on version conflict, max 3). Add mergeImplementationSection (concat arrays for fan-in). Extend ROLE_WRITE_MAP for dev-sub-N roles. Different sections already safe (key-level isolation).

Tests (5):
- Concurrent writes to different sections succeed (AC-016)
- Same-section version conflict auto-retried (AC-017)
- mergeImplementationSection concats arrays (AC-018)
- Version conflict retried during fan-in, max 3 (EC-007)
- dev-sub-N roles authorized for implementation section

Files: src/blackboard.ts (modify), tests/unit/parallel-blackboard.test.ts


### T6: Fan-out / Fan-in module (`src/fan-out.ts`)
- Priority: P1
- Estimate: 2.5h
- Dependencies: T1, T3, T5
- FR: FR-002, FR-003
- AC: AC-004, AC-005, AC-006, AC-010, AC-011, EC-001

Fan-out: parse PM subtasks, create N worktrees, launch N dev agents via semaphore. Fan-in: collect results, merge implementation sections (array concat), merge git branches, detect conflicts, cleanup worktrees. Pre-check for overlapping files (EC-001). Triggered when parallel=true + PM produced 2+ subtasks.

Tests (6):
- Fan-out launches N agents up to maxConcurrency (AC-004)
- Fan-in aggregates into blackboard implementation (AC-005)
- Failed agent retried, others continue (AC-006)
- Different files merge cleanly (AC-010)
- Same-file conflict detected and flagged (AC-011, EC-001)
- No fan-out when PM produces 0-1 subtasks

Files: src/fan-out.ts, tests/unit/fan-out.test.ts


### T7: Integration orchestrator.ts (DAG + parallel)
- Priority: P2
- Estimate: 3.5h
- Dependencies: T2, T4, T6
- FR: FR-001, FR-007
- AC: AC-001, AC-003, AC-022, AC-023

Replace for...of with executeDag() when parallel=true. Wire supervisor for failure handling. Wire fan-out for dev subtasks. Compute ParallelMetrics (wall time, sequential equivalent, speedup ratio, per-agent timing). Cost tracking per parallel agent (existing logCost calls, no change needed). Keep sequential path intact when parallel=false.

Tests (4):
- orchestrate({parallel: true}) uses DAG execution
- orchestrate({parallel: false}) uses sequential (backward compat)
- ParallelMetrics included in result (AC-022)
- Cost tracked per parallel agent individually (AC-023)

Files: src/orchestrator.ts (modify)


### T8: Parallel batch in auto-pipeline.ts
- Priority: P2
- Estimate: 1h
- Dependencies: T1
- FR: FR-006
- AC: AC-019, AC-020, AC-021

Replace sequential loop in runBatchPipeline() with Promise.allSettled + semaphore. Each task in its own worktree (if parallel enabled). No stop-on-first-failure. Summary report with per-task outcomes.

Tests (3):
- Batch runs N tasks up to maxConcurrency (AC-019)
- One task failure doesn't stop others (AC-020)
- Summary report lists each task outcome (AC-021)

Files: src/auto-pipeline.ts (modify), tests/unit/batch-parallel.test.ts


### T9: Relay.ts --parallel flag + display
- Priority: P2
- Estimate: 1h
- Dependencies: T7
- FR: FR-007
- AC: AC-022

Add --parallel flag to /orchestrate command in relay.ts. Display parallel metrics in response (speedup ratio, per-agent timing). Update /help.

Tests (2):
- --parallel flag parsed and passed to orchestrate()
- Parallel metrics displayed in response

Files: src/relay.ts (modify)


### T10: Tests and dogfooding
- Priority: P2
- Estimate: 3h
- Dependencies: T1-T9
- SC: SC-001 to SC-008

Verify all 555+ existing tests pass (SC-001). Integration tests with real timing. Verify 30+ new tests total (SC-002). Dogfood /orchestrate --parallel on a real task. Check test plan items in spec. Update CLAUDE.md.

Integration tests (4):
- Real parallel pipeline shows >20% speedup (SC-003)
- Worktree fan-out with 3 subtasks, no stale artifacts (SC-004)
- Live concurrent blackboard writes (SC-006)
- Batch 2 tasks parallel vs sequential timing (SC-007)

Acceptance tests (7):
- FR-001: DAG-based execution
- FR-002: Fan-out/fan-in
- FR-003: Worktree isolation
- FR-004: Supervisor
- FR-005: Concurrent blackboard
- FR-006: Parallel batch
- FR-007: Metrics

Adversarial (3):
- Spec vs implementation drift check
- All FR-XXX traceable to code
- All AC-XXX traceable to tests

Files: all test files, config/specs/s25-parallel-execution.md (check items), CLAUDE.md


## Dependency Graph

```
T1 (semaphore) ──────┬──→ T2 (DAG) ──────────┬──→ T7 (integration) ──→ T9 (relay)
                      │                        │
T3 (worktree) ───────┼──→ T6 (fan-out) ──────┘
                      │
T5 (blackboard) ─────┘

T4 (supervisor) ────────────────────────────────→ T7 (integration)

T1 ──→ T8 (batch parallel)

T1-T9 ──→ T10 (tests)
```

Parallelizable: T1 + T3 + T4 + T5 (start immediately, no inter-deps)


## Traceability Matrix

| FR | AC | Tasks | Tests |
|----|-----|-------|-------|
| FR-001 | AC-001, AC-002, AC-003 | T2, T7 | dag-executor.test (8), orchestrator parallel (4) |
| FR-002 | AC-004, AC-005, AC-006 | T1, T6 | semaphore.test (3), fan-out.test (6) |
| FR-003 | AC-007, AC-008, AC-009, AC-010, AC-011 | T3, T6 | worktree.test (7), fan-out.test (6) |
| FR-004 | AC-012, AC-013, AC-014, AC-015 | T4 | supervisor.test (7) |
| FR-005 | AC-016, AC-017, AC-018 | T5 | parallel-blackboard.test (5) |
| FR-006 | AC-019, AC-020, AC-021 | T1, T8 | batch-parallel.test (3) |
| FR-007 | AC-022, AC-023 | T7, T9 | orchestrator parallel (4), relay (2) |

| EC | Tasks | Tests |
|----|-------|-------|
| EC-001 | T6 | fan-out.test (same-file conflict) |
| EC-002 | T1 | semaphore.test (queuing) |
| EC-003 | T3 | worktree.test (disk full fallback) |
| EC-004 | T4 | supervisor.test (timeout) |
| EC-005 | T2 | dag-executor.test (single agent) |
| EC-006 | T9 | relay test (cancel during parallel) |
| EC-007 | T5 | parallel-blackboard.test (retry) |
| EC-008 | T3 | worktree.test (branch collision) |

| SC | Verification |
|----|-------------|
| SC-001 | T10: 555+ existing tests pass |
| SC-002 | T10: 45+ new tests (target 30+) |
| SC-003 | T10: integration test, >20% speedup |
| SC-004 | T10: integration test, no stale worktrees |
| SC-005 | T4: supervisor.test retry + summary |
| SC-006 | T10: integration test, concurrent writes |
| SC-007 | T10: integration test, batch timing |
| SC-008 | T7: cost tracking per parallel agent |


## Estimates Summary

| Task | Estimate | Cumulative |
|------|----------|------------|
| T1 Semaphore | 0.5h | 0.5h |
| T2 DAG executor | 3h | 3.5h |
| T3 Worktree manager | 2h | 5.5h |
| T4 Supervisor | 2.5h | 8h |
| T5 Blackboard concurrent | 1.5h | 9.5h |
| T6 Fan-out / Fan-in | 2.5h | 12h |
| T7 Integration orchestrator | 3.5h | 15.5h |
| T8 Batch parallel | 1h | 16.5h |
| T9 Relay --parallel | 1h | 17.5h |
| T10 Tests + dogfooding | 3h | 20.5h |
| **Total** | **20.5h** | |

Note: T1+T3+T4+T5 sont parallelisables. Chemin critique: T1 -> T2 -> T7 -> T9 -> T10 = 11h.
