# Interactive Decision Checkpoints — Design Spec

**Goal:** Add interactive decision points that pause the maturation pipeline when blocking decisions or showstoppers are detected, present options to the user via Telegram, and resume based on the user's choice.

**Architecture:** Generic checkpoint mechanism reusing the clarify job-split pattern. A Haiku "advisor" generates summaries and options. Two injection points: post-synthesize (open questions) and post-advocate (showstoppers). Decisions stored locally per-run and globally for cross-run memory.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Response format | Hybrid: keyboard options + "Autre" button for free text | Fast default path, flexible escape hatch |
| Pause points | Two: post-synthesize (open questions) AND post-advocate (showstopper) | Catch both types of blocking decisions |
| After user responds | Agent-decided: CONTINUE or RE-EXPLORE based on severity | Fundamental issues need re-exploration, trade-offs just need a decision |
| Cross-run memory | `.maturation/decisions.json` global file, tag-filtered | Avoid re-asking the same strategic decisions |

---

## New Types

Add to `src/maturation/types.ts`:

```typescript
export interface CheckpointDecision {
  id: string;                          // "cp-{uuid8}"
  source: "synthesize" | "advocate";
  summary: string;                     // problem summary for user (French)
  options: string[];                   // 2-3 concrete options
  recommendation: "CONTINUE" | "RE-EXPLORE";
  tags: string[];                      // for cross-run filtering
  awaitingFreeText?: boolean;          // true after user clicks "Autre"
  userChoice?: string;                 // user's answer
  resolvedAt?: string;
}
```

Add to `MaturationRun`:

```typescript
export interface MaturationRun {
  // ... existing fields ...
  pendingCheckpoint?: CheckpointDecision;
}
```

Global decisions file (`.maturation/decisions.json`):

```typescript
export interface GlobalDecision {
  id: string;
  runId: string;
  runName: string;
  source: "synthesize" | "advocate";
  summary: string;
  userChoice: string;
  timestamp: string;
  tags: string[];
}
```

---

## New Module: `src/maturation/checkpoint.ts`

### Exports

```typescript
// Extract actionable decision points from agent output
extractDecisionPoints(
  output: string,
  source: "synthesize" | "advocate",
): string[]

// Call Haiku advisor to generate summary, options, recommendation
generateCheckpointAdvice(
  decisions: string[],
  source: "synthesize" | "advocate",
  specSummary: string,
  existingDecisions: GlobalDecision[],
  callClaude: (prompt: string) => Promise<string>,
): Promise<CheckpointAdvice | null>

// Build inline keyboard: [Option 1] [Option 2] [Autre]
buildCheckpointKeyboard(runId: string, options: string[]): InlineKeyboard

// Start a checkpoint: extract decisions, call advisor, set pendingCheckpoint, save
startCheckpoint(
  run: MaturationRun,
  output: string,
  source: "synthesize" | "advocate",
  callClaude: (prompt: string) => Promise<string>,
): Promise<CheckpointDecision | null>

// Handle user response (option click or free text)
handleCheckpointResponse(
  run: MaturationRun,
  userChoice: string,
): Promise<{ action: "CONTINUE" | "RE-EXPLORE" }>

// Check if a run has a pending checkpoint for this chat
checkMaturationCheckpoint(
  chatId: number,
  threadId: number | undefined,
): Promise<MaturationRun | null>

// Load global decisions, optionally filtered by tags
loadGlobalDecisions(tags?: string[]): Promise<GlobalDecision[]>

// Save a decision to the global file
saveGlobalDecision(decision: GlobalDecision): Promise<void>
```

### Extraction logic

**Post-synthesize**: regex on SPEC-UNIFIEE output to find "Questions ouvertes" or "Decisions bloquantes" sections:
```
/##\s*(?:Questions?\s*ouvertes?|D[eé]cisions?\s*bloquantes?)[\s\S]*?(?=\n##|\z)/i
```
Split into numbered items (`/\d+\.\s+(.+)/g`). Checkpoint triggers if >= 1 item found.

**Post-advocate**: reuse existing `extractShowstopper()` from `scoring.ts`. If showstopper found, its reason becomes the decision point.

### Advisor prompt (inline callClaude, Haiku)

```
Tu es un conseiller de pipeline de maturation. Un probleme bloquant a ete
identifie. Ton role :
1. Resumer le probleme en 2-3 phrases pour l'utilisateur
2. Proposer 2-3 options concretes et actionables (en francais)
3. Recommander CONTINUE (probleme tranchable sans re-exploration) ou
   RE-EXPLORE (probleme fondamental qui change l'architecture)

Source: {synthesize|advocate}
Probleme(s):
{extracted decision points, one per line}

Contexte spec:
{first 500 chars of SPEC-UNIFIEE or last agent output}

Decisions deja prises dans cette maturation:
{run.pendingCheckpoint history or "Aucune"}

Decisions historiques pertinentes:
{filtered global decisions or "Aucune"}

Reponds UNIQUEMENT en JSON :
{"summary":"...","options":["Option 1: ...","Option 2: ..."],"recommendation":"CONTINUE|RE-EXPLORE","tags":["tag1","tag2"]}
```

### Global decisions persistence

`.maturation/decisions.json` — JSON array, append-only, atomic write (tmp+rename pattern from documents.ts). Read by `buildPhasePrompt` in `agents.ts` for context injection.

---

## Modified Files

### `src/maturation/types.ts`

Add `CheckpointDecision` and `GlobalDecision` interfaces. Add `pendingCheckpoint?: CheckpointDecision` to `MaturationRun`.

### `src/maturation/agents.ts` — `buildPhasePrompt`

Add two new context sections to the prompt:

1. **Intra-run decisions** — from `run.pendingCheckpoint` history (resolved checkpoints stored as array in meta.json):
```
## Decisions humaines
- [CP-1 synthesize] "Accepter le pivot CSV/OFX" → Choix: "Option 1: CSV"
```

2. **Inter-run decisions** — from `.maturation/decisions.json` filtered by tag relevance:
```
## Decisions historiques
- [2026-03-27 banking] "Pivot CSV/OFX vs PSD2" → "CSV accepte"
```

### `src/commands/maturation.ts` — `runMaturationPipeline`

Two checkpoint injection points after `handlePhaseResult`:

**Post-synthesize** (after the existing `await onProgress` call):
```typescript
if (phaseName === "synthesize" && result.status === "ok") {
  const { startCheckpoint } = await import("../maturation/checkpoint.ts");
  const cp = await startCheckpoint(run, result.documents[0] ?? "", "synthesize", bctx.callClaude);
  if (cp) {
    await onProgress(buildMaturationStatusBar(run));
    // Send checkpoint message with keyboard — handled by job completion notification
    return `MATURATION_CHECKPOINT:${run.name}:${run.id}`;
  }
}
```

**Post-advocate** (replaces the current automatic loop-back):
```typescript
if (phaseName === "advocate") {
  const { startCheckpoint } = await import("../maturation/checkpoint.ts");
  const cp = await startCheckpoint(run, advocateOutput, "advocate", bctx.callClaude);
  if (cp) {
    await onProgress(buildMaturationStatusBar(run));
    return `MATURATION_CHECKPOINT:${run.name}:${run.id}`;
  }
  // No checkpoint needed (PASS verdict) — check for loop or advance as before
}
```

The automatic loop-back on showstopper is **removed**. Showstoppers now always go through the checkpoint. The checkpoint's `recommendation` (CONTINUE or RE-EXPLORE) determines whether to loop, but only after the user responds.

Add `mat_cp_opt` and `mat_cp_other` callback handlers in the composer for keyboard interactions.

Add `resumeMaturationAfterCheckpoint` exported function (same pattern as `resumeMaturationAfterClarify`).

### `src/commands/zz-messages.ts` — unified pending check

Replace the separate `checkMaturationClarify` call with a unified check:

```typescript
// Check maturation pending state (clarify OR checkpoint)
const { checkMaturationClarify } = await import("../maturation/clarify.ts");
const { checkMaturationCheckpoint } = await import("../maturation/checkpoint.ts");

const matClarify = await checkMaturationClarify(chatId, threadId);
if (matClarify) {
  // ... existing clarify handling ...
  return;
}

const matCheckpoint = await checkMaturationCheckpoint(chatId, threadId);
if (matCheckpoint && matCheckpoint.pendingCheckpoint?.awaitingFreeText) {
  // User clicked "Autre" and is now sending free text
  const { handleCheckpointResponse } = await import("../maturation/checkpoint.ts");
  const cpResult = await handleCheckpointResponse(matCheckpoint, input);
  // ... save decision, resume pipeline based on cpResult.action ...
  return;
}
```

Only free-text responses go through `zz-messages.ts`. Keyboard clicks go through callback handlers in `maturation.ts`.

### `src/maturation/index.ts`

Add `export * from "./checkpoint.ts"`.

---

## Keyboard Layout

```
┌─────────────────────────────────┐
│ ⚠️ Decision requise             │
│                                 │
│ {summary from advisor}          │
│                                 │
│ Recommandation: {RE-EXPLORE}    │
│                                 │
│ [Option 1: CSV] [Option 2: OFX]│
│ [Autre (texte libre)]          │
└─────────────────────────────────┘
```

Callback data format:
- `mat_cp_opt:{runId}:{index}` — option selected (index 0-based)
- `mat_cp_other:{runId}` — free text mode activated

---

## Edge Cases

- **No decision points found**: `startCheckpoint` returns null, pipeline continues normally. This is the common case — most synthesize phases won't have blocking questions.
- **Advisor returns invalid JSON**: fallback to a generic message with the raw decision text and no keyboard (text-only response mode).
- **User responds hours later**: `meta.json` persists `pendingCheckpoint`. No TTL — the run already has a 7-day TTL.
- **Multiple checkpoints in one run**: each is handled sequentially. The resolved checkpoint's `userChoice` is stored, and the next one can reference it.
- **Post-synthesize checkpoint + advocate also finds issues**: both fire. User addresses synthesize questions first, pipeline resumes to advocate, advocate may trigger its own checkpoint.
- **Global decisions.json grows large**: capped at last 50 entries. Older entries pruned on write. Tags ensure relevance filtering is fast.

---

## Test Plan

- Unit tests for `extractDecisionPoints` (synthesize format, advocate format, no decisions)
- Unit tests for advisor JSON parsing (valid, invalid, code block wrapper)
- Unit tests for `buildCheckpointKeyboard` (2 options, 3 options, always includes "Autre")
- Unit tests for `startCheckpoint` (triggers on decisions, returns null on clean output)
- Unit tests for `handleCheckpointResponse` (option click, free text, saves to global)
- Unit tests for `checkMaturationCheckpoint` (find/not-find, match chatId/threadId)
- Unit tests for `loadGlobalDecisions` / `saveGlobalDecision` (append, filter by tags, cap at 50)
- Integration: mock callClaude, verify full checkpoint → response → resume flow
