# Implementation Report: Contexte Agent Enrichi S40

## Summary

Created `src/agent-context.ts` module and integrated it into `src/sdd-agents.ts` to inject dynamic Supabase data (memory, sprint, tasks, agent memories) into SDD agent prompts.

## Tests Generated

**File:** `tests/unit/agent-context.test.ts` (25 tests)

| V-Criterion | Tests | Description |
|-------------|-------|-------------|
| V1 | 1 | buildAgentContext returns non-empty string with context data |
| V2 | 4 | Parallel fetching via Promise.all (memory, sprint, tasks, agent memories) |
| V3 | 2 | Timeout enforcement with graceful fallback (partial/empty context) |
| V4 | 1 | Returns "" when supabase is null |
| V5 | 1 | Context capped at ~6000 chars (~1500 tokens) |
| V6 | 1 | Role-specific agent memories included |
| V7 | 4 | Phase-based data selection (different data per phase) |
| V8 | 3 | Injectable hooks for testing |
| V9 | 1 | Feature flag gating (agent_context_injection) |
| Edge cases | 7 | Null sprint, empty backlog, empty memories, fetch errors, unknown phase/role |

## Files Modified

| File | Changes | LOC |
|------|---------|-----|
| `src/agent-context.ts` | **NEW** — Module with buildAgentContext(), injectable hooks, timeout-guarded parallel fetching, compact formatting | 318 |
| `src/sdd-agents.ts` | Added import, setBuildAgentContextHook, getAgentContext wrapper, appendAgentContext helper. Each runSdd* now calls getAgentContext and injects via appendAgentContext | 637 (+57) |
| `src/commands/sdd-flow.ts` | Pass `bctx.supabase` as 4th arg to runSddExplore | +1 |
| `src/commands/exploration.ts` | Pass `bctx.supabase` as 4th arg to runSddExplore (2 call sites) | +2 |
| `config/features.json` | Added `agent_context_injection: false` feature flag | +1 |
| `CLAUDE.md` | Documented agent-context.ts and heartbeat-sdd-watchdog.ts modules | +2 |
| `tests/unit/agent-context.test.ts` | **NEW** — 25 unit tests | 342 |

## Architecture Decisions

1. **Option B (Injection prompt)** — as recommended by exploration. Module fetches data via existing functions and formats a compact text block for system prompt injection.

2. **Feature flag gated** — `agent_context_injection` defaults to `false`. Can be enabled at runtime via Supabase or `/feature enable agent_context_injection`.

3. **Injectable hooks pattern** — consistent with existing sdd-agents.ts patterns (setWriteFileHook, setSpawnSyncHook, etc.) for clean test isolation.

4. **Independent timeouts** — each Supabase fetch has its own timeout (default 3s) via `Promise.race`. Partial results returned on timeout (V3).

5. **Phase-based data selection** — not all phases need all data (V7):
   - `explore`: memory + tasks + agent memories (no sprint)
   - `spec/challenge/review/doc`: all 4 data sources
   - `implement`: sprint + tasks + agent memories (no memory context)

6. **runSddExplore backward-compatible** — 4th `supabase` parameter is optional, defaults to null (returns "" context). Callers with `bctx` access updated.

## Test Results

```
bun test tests/unit/ — 2150 pass, 0 fail (75 files, 14.93s)
bun test tests/unit/agent-context.test.ts — 25 pass, 0 fail
bun test tests/unit/sdd-agents.test.ts — 46 pass, 0 fail
bun test tests/unit/coding-standards.test.ts — 268 pass, 0 fail
bun test tests/unit/doc-freshness.test.ts — 4 pass, 0 fail
```

## Status: DONE
