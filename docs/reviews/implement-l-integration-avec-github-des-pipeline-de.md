# Implementation Report: Pipeline V3 GitHub Integration — Phase 1: Push enrichi

## Summary

Feature implementation for enriched GitHub integration for maturation and V3 pipelines:
- Phase label swap (old label removal + new label addition)
- Milestones per sprint (create/find milestone, assign to issues)
- Draft PR lifecycle (create as draft, convert to ready on approval)
- Bug fix: `syncRunComplete` never called at end of maturation pipeline

## Tests Generated

**File:** `tests/unit/github-sync.test.ts` — 12 new V-criteria tests added (V25–V36)

| Test ID | Feature | Coverage |
|---------|---------|----------|
| V25 | `swapPhaseLabel` removes old + adds new label | Label swap happy path |
| V26 | `swapPhaseLabel` returns false on gh failure | Error path |
| V27 | `swapPhaseLabel` with null old label only adds | No old label edge case |
| V28 | `ensureMilestone` creates milestone and returns number | Milestone creation |
| V29 | `ensureMilestone` returns null on failure | Error path |
| V30 | `setIssueMilestone` calls gh api to set milestone | Issue milestone assignment |
| V31 | `setIssueMilestone` returns false on failure | Error path |
| V32 | `createDraftPR` creates draft PR with --draft flag | Draft PR creation |
| V33 | `createDraftPR` returns null on failure | Error path |
| V34 | `convertPRToReady` marks draft PR ready for review | PR ready conversion |
| V35 | `convertPRToReady` returns false on failure | Error path |
| V36 | `syncRunComplete` posts final comment and closes issue | Run complete |

**File:** `tests/unit/maturation-command.test.ts` — 1 new test added

| Test ID | Feature | Coverage |
|---------|---------|----------|
| V-bugfix-1 | `syncRunComplete` is called when maturation pipeline completes | Bug fix verification |

## Files Modified

### `src/github-sync.ts`

Changes: +148 lines

New exported functions:
- `swapPhaseLabel(issueNumber, oldLabel | null, newLabel)` — removes old phase label (best-effort), ensures and adds new label. Returns boolean.
- `ensureMilestone(sprintName)` — creates milestone via `gh api POST /repos/{owner}/{repo}/milestones`, falls back to listing existing milestones on failure (handles 422 already-exists). Returns milestone number or null.
- `setIssueMilestone(issueNumber, milestoneNumber)` — patches issue via `gh api PATCH /repos/{owner}/{repo}/issues/{number}`. Returns boolean.
- `createDraftPR(branch, title, body)` — calls `gh pr create --draft`. Parses PR number from URL. Returns `{number, url}` or null.
- `convertPRToReady(prNumber)` — calls `gh pr ready {number}`. Returns boolean.

All functions use `getConfig()` for `githubRepo`, `createLogger` for logging, and return safe defaults on failure (no throws).

### `src/commands/maturation.ts`

Bug fix: Added fire-and-forget call to `syncRunComplete` at the end of `runMaturationPipeline`, just before returning `MATURATION_READY`. Previously `syncRunComplete` was only called in `pipeline-v3/orchestrator.ts`, not in maturation.

Change: +9 lines

```typescript
// Fire-and-forget GitHub sync: close the run issue on maturation completion
if (bctx.supabase) {
  const sb = bctx.supabase;
  import("../github-sync.ts").then(({ syncRunComplete }) => {
    syncRunComplete(sb, run.id, "maturation_ready").catch((err: unknown) =>
      log.warn("GitHub sync failed for run complete", { error: String(err) }),
    );
  });
}
```

## Tests Completed

### Final test results

```
bun test tests/unit/github-sync.test.ts tests/unit/maturation-command.test.ts
 52 pass
 0 fail
 343 expect() calls
Ran 52 tests across 2 files. [213.00ms]
```

Full suite:
```
bun test
 2755 pass
 1 fail   ← pre-existing TSC bun-types error (not our change)
Ran 2756 tests across 101 files.
```

Tests added: 13 (was 2743, now 2756)

## Architecture Notes

- Zero infrastructure changes (no DB migrations, no new tables, no env vars)
- All new functions follow existing patterns: `getConfig()`, `createLogger`, `ghExec` hook for tests
- `swapPhaseLabel` is non-atomic by design (remove then add) — remove failure is non-blocking (warn only)
- `ensureMilestone` handles the 422 "already exists" case by falling back to list+find, making it idempotent
- `createDraftPR` parses PR URL from `gh pr create` stdout (same pattern as `createIssue`)
- Bug fix uses fire-and-forget pattern consistent with all other GitHub sync calls in the codebase

## Status: DONE

Next steps: `/dev-review` then `/dev-doc`
