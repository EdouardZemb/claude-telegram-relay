# S25 Architecture Plan — Parallel Execution & Multi-Agent

## Overview

Transform the sequential `for...of` loop in `orchestrator.ts` into a DAG-based parallel executor. Three levels of parallelism: (1) independent agents in the same pipeline, (2) fan-out of multiple Dev agents on subtasks, (3) batch tasks in autopipeline. A TypeScript supervisor coordinates failures, retries, and escalation. Git worktrees isolate parallel Dev agents.

Depends on: S24 blackboard, S23 cost tracking, S22 structured messages.


## Component Architecture

### C1: DAG Executor (`src/dag-executor.ts`, ~350 lines)

Core engine that replaces the sequential loop. Evaluates a DAG of agent dependencies and runs agents as soon as their deps are satisfied.

**Data structures:**

```
DAGNode {
  agent: AgentRole
  deps: AgentRole[]      // must complete before this node runs
  status: pending | running | succeeded | failed | skipped
  result: AgentStepResult | null
}

DAGDefinition = Map<AgentRole, AgentRole[]>  // adjacency list: agent -> dependencies
```

**Pre-defined DAGs:**

```
DEFAULT_DAG:
  analyst -> []           // no deps, starts immediately
  pm -> []                // no deps, starts immediately (parallel with analyst)
  architect -> [analyst, pm]   // waits for both
  dev -> [architect]
  qa -> [dev]

QUICK_DAG:
  dev -> []
  qa -> [dev]

REVIEW_DAG:
  qa -> []
  architect -> [qa]
```

**Execution algorithm:**
1. Initialize all nodes as `pending`
2. Find all nodes whose deps are all `succeeded` → launch them in parallel via `Promise.all` (respecting semaphore)
3. When a node completes, update its status, check if new nodes are unblocked
4. Repeat until all nodes are terminal (succeeded | failed | skipped)
5. If a node fails and has dependents, supervisor decides (retry/skip/escalate)

**Integration point:** `orchestrate()` calls `executeDag(dag, runAgentFn, options)` instead of `for...of`. The `runAgentFn` is a callback wrapping the existing `runAgentStep()` + blackboard write + gate eval logic.

**Key design:** The DAG executor is agnostic to agents/blackboard. It receives a graph and a run function. This keeps it testable and reusable.


### C2: Semaphore (`src/semaphore.ts`, ~50 lines)

Promise-based counting semaphore for concurrency control.

```
class Semaphore {
  constructor(maxConcurrency: number)
  async acquire(): Promise<void>   // blocks if at capacity
  release(): void
}
```

Default `maxConcurrency = 3`. Used by DAG executor and fan-out. Configurable per `orchestrate()` call via `options.maxConcurrency`.

Simple implementation: internal queue of Promise resolvers. `acquire()` pushes a resolver, `release()` shifts and resolves.


### C3: Worktree Manager (`src/worktree.ts`, ~200 lines)

Manages git worktree lifecycle for parallel Dev agents.

**API:**

```
createWorktree(taskId: string, subtaskIndex: number): Promise<WorktreeInfo>
  → git worktree add /tmp/claude-worktrees/{taskId}-sub-{n}-{timestamp} -b feature/{taskId}-sub-{n}-{timestamp}
  → returns { path, branch, cleanup() }

cleanupWorktree(info: WorktreeInfo): Promise<void>
  → git worktree remove {path}
  → git branch -D {branch} (only if not pushed)

pushWorktree(info: WorktreeInfo): Promise<boolean>
  → git push -u origin {branch} from worktree path

mergeWorktrees(worktrees: WorktreeInfo[], targetBranch: string): Promise<MergeResult>
  → for each worktree: git merge --no-ff {branch}
  → detect conflicts, return { merged, conflicts }

cleanupAllWorktrees(): Promise<void>
  → git worktree list --porcelain, remove stale ones in /tmp/claude-worktrees/
```

**Branch naming:** `feature/{task-id}-sub-{n}-{timestamp}` to avoid collisions (EC-008).

**Worktree location:** `/tmp/claude-worktrees/` — avoids polluting project dir.

**Conflict handling (EC-001):**
- Pre-check: if PM's subtask decomposition shows overlapping files, flag for sequential execution
- Post-check: if `git merge` reports conflict, mark as `conflict` in supervisor report, try sequential re-execution for conflicting subtasks

**Disk space (EC-003):** Wrap `git worktree add` in try/catch. On ENOSPC, fall back to sequential execution in main directory.


### C4: Supervisor (`src/supervisor.ts`, ~250 lines)

TypeScript module (not LLM) that monitors parallel executions and makes deterministic decisions.

**State tracking:**

```
SupervisorState {
  agents: Map<string, AgentStatus>
  startTime: number
  timeouts: Map<string, NodeJS.Timeout>
}

AgentStatus {
  id: string
  role: AgentRole
  status: pending | running | succeeded | failed | retrying | skipped | timed_out
  attempts: number
  maxAttempts: number     // default 3 (1 initial + 2 retries)
  startedAt: number
  completedAt?: number
  result?: AgentStepResult
  error?: string
}
```

**Decision logic:**

```
onAgentFailed(agent):
  if agent.attempts < agent.maxAttempts:
    → RETRY (re-launch with failure context in prompt)
  else if agent.role is non-critical (analyst, sm):
    → SKIP (continue pipeline, mark as skipped)
  else:
    → ESCALATE (notify user via onProgress, pause pipeline)
```

**Timeout (EC-004):** 10 minutes per agent. Supervisor sets a timer on launch. If timer fires, kill the process and trigger RETRY or SKIP.

**Structured report (AC-015):**

```
SupervisorReport {
  succeeded: AgentStatus[]
  failed: AgentStatus[]
  skipped: AgentStatus[]
  retried: AgentStatus[]
  timed_out: AgentStatus[]
  total_wall_time_ms: number
  sequential_equivalent_ms: number   // sum of all agent durations
  speedup_ratio: number              // sequential / wall
  per_agent_timing: { agent, start, end, duration }[]
}
```


### C5: Fan-Out / Fan-In (`src/fan-out.ts`, ~200 lines)

Handles subtask parallelism. After PM produces subtasks, fan-out creates N Dev agents, each in its own worktree.

**Fan-out flow:**
1. Parse PM's structured output for subtasks (from `AgentMessage.structured.subtasks[]`)
2. Create N worktrees (up to `maxConcurrency`)
3. Launch N `runAgentStep("dev", subtask, ...)` in parallel via semaphore
4. Each agent writes to blackboard implementation section (array append via fan-in merge)

**Fan-in flow:**
1. Collect all N Dev agent results
2. Merge implementation sections: `files_modified = concat(all)`, `tests_added = concat(all)`, `summary = join(all)`
3. Handle conflicts:
   - Different files → safe, merge all branches sequentially into target
   - Same file → flag conflict, try sequential re-execution (EC-001)
4. Merge all worktree branches into feature branch
5. Cleanup worktrees

**Blackboard merge (AC-018):**
- Read current implementation section
- Append new arrays (files, tests)
- Auto-retry on version conflict (EC-007), max 3 retries
- Each write uses a unique role key: `dev-sub-0`, `dev-sub-1`, etc. (added to ROLE_WRITE_MAP)

**Integration:** Called from DAG executor when the `dev` node has fan-out enabled. Fan-out is triggered when:
- `options.parallel === true`
- PM produced 2+ subtasks in structured output
- Each subtask modifies different files (heuristic from PM output)


### C6: Concurrent Blackboard Extension

Extend `writeSection()` in `blackboard.ts` to handle concurrent writes safely.

**Different sections (AC-016):** Already safe — each agent writes to its own section. No change needed. The optimistic locking is per-row, but section-level writes read-modify-write on different keys, so version increments serialize naturally.

**Same section (AC-017):** Add auto-retry logic:

```
async function writeSectionWithRetry(
  supabase, sessionId, section, data, role, expectedVersion, maxRetries = 3
): Promise<WriteResult> {
  for (let i = 0; i <= maxRetries; i++) {
    const result = await writeSection(supabase, sessionId, section, data, role, expectedVersion);
    if (result.success) return result;
    if (result.error?.includes("Version conflict")) {
      // Re-read latest version and retry
      const latest = await getFullBlackboard(supabase, sessionId);
      if (latest) expectedVersion = latest.version;
      continue;
    }
    return result; // non-retryable error
  }
  return { success: false, newVersion: expectedVersion, error: "Max retries exceeded" };
}
```

**Fan-in merge for implementation (AC-018):**

```
async function mergeImplementationSection(
  supabase, sessionId, agentResults: AgentStepResult[], expectedVersion
): Promise<WriteResult> {
  const existing = await readSection(supabase, sessionId, "implementation") || {};
  const merged = {
    files_modified: [...(existing.files_modified || [])],
    tests_added: [...(existing.tests_added || [])],
    summaries: [...(existing.summaries || [])],
  };
  for (const result of agentResults) {
    const data = result.structured || {};
    merged.files_modified.push(...(data.files_modified || data.files || []));
    merged.tests_added.push(...(data.tests_added || data.tests || []));
    merged.summaries.push(data.summary || result.output.substring(0, 1000));
  }
  return writeSectionWithRetry(supabase, sessionId, "implementation", merged, "system", expectedVersion);
}
```


### C7: Parallel Metrics

Extend `OrchestratedResult` with parallel metrics.

```
interface ParallelMetrics {
  total_wall_time_ms: number
  sequential_equivalent_ms: number
  speedup_ratio: number
  per_agent_timing: { agent: AgentRole, startMs: number, endMs: number, durationMs: number }[]
  fan_out_count: number
  concurrent_peak: number
}
```

Each agent records its absolute start/end time (not just duration). The DAG executor computes `sequential_equivalent_ms` as the sum of all `durationMs`, and `speedup_ratio = sequential / wall`.

Cost tracking (AC-023): Each parallel agent calls `logCost()` individually — no change needed. The existing system tracks by `agentRole + taskId`, which already handles multiple dev agents since they get different subtask IDs.


### C8: Batch Parallel Execution

Modify `runBatchPipeline()` in `auto-pipeline.ts`:

```
async function runBatchPipeline(supabase, tasks, options):
  const semaphore = new Semaphore(options.maxConcurrency || 2)
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      await semaphore.acquire()
      try {
        return await runAutoPipeline(supabase, task, options)
      } finally {
        semaphore.release()
      }
    })
  )
  // No stop-on-first-failure for batch (AC-020)
  return results.map(r => r.status === 'fulfilled' ? r.value : errorResult(r.reason))
```

Each task runs in its own worktree (if parallel enabled). Tasks are independent — no cross-task deps (out of scope per spec).


## File Impact Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `src/dag-executor.ts` | **New** | ~350 |
| `src/semaphore.ts` | **New** | ~50 |
| `src/worktree.ts` | **New** | ~200 |
| `src/supervisor.ts` | **New** | ~250 |
| `src/fan-out.ts` | **New** | ~200 |
| `src/orchestrator.ts` | **Modify** | +80 (parallel option, DAG call, metrics) |
| `src/blackboard.ts` | **Modify** | +60 (writeSectionWithRetry, mergeImplementation, extended ROLE_WRITE_MAP) |
| `src/auto-pipeline.ts` | **Modify** | +30 (parallel batch) |
| `src/relay.ts` | **Modify** | +15 (--parallel flag on /orchestrate) |
| `tests/unit/dag-executor.test.ts` | **New** | ~200 |
| `tests/unit/semaphore.test.ts` | **New** | ~60 |
| `tests/unit/worktree.test.ts` | **New** | ~150 |
| `tests/unit/supervisor.test.ts` | **New** | ~180 |
| `tests/unit/fan-out.test.ts` | **New** | ~150 |
| `tests/unit/parallel-blackboard.test.ts` | **New** | ~100 |

**Total: 6 new modules (~1050 lines), 4 modified files (~185 lines), 6 new test files (~840 lines)**


## Task Breakdown (Ordered by Dependencies)

```
T1: Semaphore module                              [FR-002, FR-006]     dep: none
T2: DAG executor module                           [FR-001]             dep: T1
T3: Worktree manager module                       [FR-003]             dep: none (parallelizable with T1/T2)
T4: Supervisor module                             [FR-004]             dep: none (parallelizable with T1/T2/T3)
T5: Concurrent blackboard (retry + merge)         [FR-005]             dep: none (parallelizable)
T6: Fan-out / Fan-in module                       [FR-002, FR-003]     dep: T1, T3, T5
T7: Integration orchestrator.ts (DAG + parallel)  [FR-001, FR-007]     dep: T2, T4, T6
T8: Parallel batch in auto-pipeline.ts            [FR-006]             dep: T1
T9: Relay.ts --parallel flag + metriques          [FR-007]             dep: T7
T10: Tests et dogfooding (30+)                    [SC-001..SC-008]     dep: T1-T9
```

**Dependency graph:**

```
T1 (semaphore) ──────┬──→ T2 (DAG) ──────────┬──→ T7 (integration) ──→ T9 (relay)
                     │                        │
T3 (worktree) ──────┼──→ T6 (fan-out) ──────┘
                     │
T4 (supervisor) ────┘

T5 (blackboard) ────→ T6 (fan-out)

T1 ──→ T8 (batch parallel)

T1-T9 ──→ T10 (tests)
```

**Parallelizable:** T1 + T3 + T4 + T5 can all start immediately (no inter-deps).


## Risks and Mitigations

**Risk 1: Worktree complexity in CI**
Git worktrees require a non-bare repo and sufficient disk. CI runners may have limited disk.
Mitigation: EC-003 fallback to sequential. Worktrees in /tmp (not project dir). Cleanup always runs (even on failure).

**Risk 2: Race conditions in blackboard writes**
Multiple agents writing simultaneously may cause version conflicts.
Mitigation: writeSectionWithRetry with max 3 retries. Different sections don't conflict (key-level isolation). Fan-in merge is a single atomic write after all agents complete.

**Risk 3: Agent process leaks**
If supervisor kills a hung agent, the Claude process may leave orphans.
Mitigation: Kill process group (process.kill(-pid)). Worktree cleanup in finally block. cleanupAllWorktrees() on pipeline exit.

**Risk 4: Merge conflicts between parallel dev agents**
Two agents modifying the same file = conflict.
Mitigation: PM subtask decomposition includes file hints. Pre-check overlap before fan-out. If conflict detected post-merge, fall back to sequential for conflicting pair.

**Risk 5: Cost increase from parallel retries**
Parallel execution with retries could spike costs.
Mitigation: Supervisor maxAttempts = 3 (hard limit). Cost tracked per agent individually. Pipeline-level cost cap configurable (future).


## Backward Compatibility

- Default behavior: `parallel: false` (or omitted) → existing sequential `for...of` loop unchanged
- `parallel: true` on `orchestrate()` → DAG execution with parallelism
- `--parallel` flag on `/orchestrate` Telegram command → sets `parallel: true`
- `runBatchPipeline()` with `maxConcurrency > 1` → parallel batch
- All existing tests pass without modification (SC-001)
- Blackboard changes are additive (new function, extended role map)


## Cost Estimate

- Parallel DEFAULT pipeline: same token count as sequential (same agents, same prompts)
- Fan-out with N dev agents: N * dev_agent_cost (linear scaling)
- Supervisor: zero LLM cost (pure TypeScript)
- Overhead: ~5% more tokens from enhanced prompts (subtask context)
- Time savings: 30-50% wall-clock reduction on DEFAULT pipeline
