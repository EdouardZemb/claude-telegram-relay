# Clarify Phase (P0b) — Socratic Loop Design

**Goal:** Implement an interactive clarification phase in the maturation engine that asks targeted questions one at a time via Telegram, waits for user responses, and re-evaluates ambiguity until the idea is clear enough to proceed.

**Architecture:** Job-split pattern — Job 1 (understand) terminates after sending the first question. The message handler takes over for the interactive loop. When clarification is done, it re-runs the understander and launches Job 2 (explore → advocate).

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Interaction mode | Interactive loop, 1 question at a time, max 5 turns | Original discussion spec: "maïeutique progressive" |
| Response capture | All messages captured while clarify is active | Simplest UX — no buttons/reply needed |
| Post-clarification | Re-run understander with enriched input → UNDERSTANDING.md v2 | Single document for downstream agents |
| Question generation | Dedicated clarifier agent (`maturation-clarifier.md`) | Specialized maïeutic strategy by layer |
| Re-scoring | Clarifier re-evaluates ambiguity each turn (1 call per turn) | Allows early exit when ambiguity drops below threshold |
| Clarifier model | Haiku | Fast interactive response, simple reasoning task |

---

## New Types

Add to `src/maturation/types.ts`:

```typescript
export interface ClarificationQA {
  question: string;
  answer: string;
  turn: number;
  timestamp: string;
}

export interface ClarificationState {
  questions: ClarificationQA[];
  currentTurn: number;
  maxTurns: number;           // default 5
  pendingQuestion?: string;   // question awaiting user response
}
```

Add optional field to `MaturationRun`:

```typescript
export interface MaturationRun {
  // ... existing fields ...
  clarification?: ClarificationState;
}
```

---

## New Agent: `.claude/agents/maturation-clarifier.md`

- **Model:** haiku (fast interactive response)
- **Input:** UNDERSTANDING.md content + Q&A history + current turn number
- **Output:** Strict JSON:

```json
{
  "status": "QUESTION" | "DONE",
  "question": "...",
  "ambiguityScore": 4,
  "reasoning": "..."
}
```

- **Maïeutic strategy by turn:**
  - Turns 1-2: Framing (scope, precise objective, target users)
  - Turn 3: Depth (expected behaviors, edge cases)
  - Turn 4: Technical (constraints, dependencies, integrations)
  - Turn 5: Arbitrage (remaining trade-offs, forced decisions)

- Returns `"status": "DONE"` when `ambiguityScore <= 4` or at turn 5

---

## New Module: `src/maturation/clarify.ts`

### Exports

```typescript
// Check if a maturation run is awaiting clarification for this chat
checkMaturationClarify(
  chatId: number,
  threadId: number | undefined,
): Promise<MaturationRun | null>

// Process user response and call clarifier agent
handleClarifyResponse(
  run: MaturationRun,
  userResponse: string,
  bctx: BotContext,
): Promise<"waiting" | "done">

// Initial clarifier call (from runMaturationPipeline)
startClarification(
  run: MaturationRun,
  bctx: BotContext,
): Promise<{ question: string; ambiguityScore: number }>
```

### Internal logic

**`checkMaturationClarify`:**
- Lists runs from `.maturation/runs/`
- Finds one matching `chatId` + `threadId` where `currentPhase === "clarify"` AND `clarification.pendingQuestion` is set
- Returns the run or null

**`startClarification`:**
1. Read UNDERSTANDING.md from the run
2. Call clarifier agent via `bctx.callClaude()` (synchronous in message handler context) with UNDERSTANDING.md content, turn=1, no Q&A history
3. Parse JSON response
4. Set `run.clarification = { questions: [], currentTurn: 1, maxTurns: 5, pendingQuestion: response.question }`
5. Save meta.json
6. Return the question and score

**`handleClarifyResponse`:**
1. Store Q&A in `run.clarification.questions[]`
2. Increment `currentTurn`
3. Call clarifier agent with UNDERSTANDING.md + full Q&A history + current turn
4. Parse JSON response
5. If `status === "QUESTION"` AND `currentTurn < maxTurns`:
   - Update `pendingQuestion`
   - Send question to Telegram via `bctx.sendResponseHtml()`
   - Save meta.json
   - Return `"waiting"`
6. If `status === "DONE"` OR `currentTurn >= maxTurns`:
   - Clear `pendingQuestion`
   - Build enriched input: original rawInput + formatted Q&A
   - Re-run understander via `spawnClaude()` with enriched input
   - Update run: `currentPhase = "explore"`, `clarification.pendingQuestion = undefined`
   - Save meta.json
   - Launch Job 2 via `launch()` for remaining phases (explore → advocate)
   - Return `"done"`

---

## Modified Files

### `src/maturation/engine.ts`

Remove the clarify skip logic. The state machine already correctly transitions `understand → clarify` when ambiguity > 5. The pipeline orchestrator now handles clarify properly.

### `src/commands/maturation.ts`

In `runMaturationPipeline()`:

1. Remove the "skip clarify" block at the top
2. After the phases loop, add handling for when `currentPhase === "clarify"`:
   - Call `startClarification(run, bctx)`
   - Send the first question to Telegram with status bar
   - Return `"MATURATION_CLARIFYING:{name}:{id}"`
3. Job completion handler in job-manager notification: when result starts with `MATURATION_CLARIFYING`, send the question (already sent by startClarification) — no additional action needed

### `src/commands/zz-messages.ts`

In the `processMessageInput` function, BEFORE the existing `checkPendingClarification()` call:

```typescript
const matRun = await checkMaturationClarify(chatId, threadId);
if (matRun) {
  const status = await handleClarifyResponse(matRun, input, bctx);
  // "waiting" = new question sent, "done" = pipeline resumed
  return;
}
```

This intercepts ALL messages (text and voice — voice is already transcribed at this point) when a clarify phase is active.

### `src/maturation/types.ts`

Add `ClarificationQA`, `ClarificationState` interfaces and `clarification?` field to `MaturationRun`.

### `src/maturation/index.ts`

Add `export * from "./clarify.ts"`.

---

## Clarifier Agent Prompt (callClaude format)

The clarifier is called via `bctx.callClaude()` (not `spawnClaude()`) because it runs synchronously in the message handler. The prompt:

```
Tu es un agent maïeutique. Ton rôle est de poser UNE question ciblée pour clarifier une idée ambiguë.

## Idée originale
{rawInput}

## Analyse initiale
{UNDERSTANDING.md content}

## Historique Q&A
{formatted Q&A pairs, or "Aucune question posée encore"}

## Tour actuel: {N}/5

## Stratégie par tour
- Tours 1-2 : cadrage (périmètre, objectif précis, utilisateurs cibles)
- Tour 3 : profondeur (comportements attendus, cas limites)
- Tour 4 : technique (contraintes, dépendances, intégrations)
- Tour 5 : arbitrage (trade-offs restants, décisions à forcer)

## Instructions
Évalue l'ambiguïté résiduelle (0-10). Si <= 4, retourne DONE.
Sinon, pose UNE question ciblée selon la stratégie du tour actuel.

Réponds UNIQUEMENT avec ce JSON :
{"status": "QUESTION"|"DONE", "question": "...", "ambiguityScore": N, "reasoning": "..."}
```

---

## Flow Diagram

```
Job 1 (background):
  understand phase → ambiguity=6
    → handlePhaseResult → currentPhase="clarify"
    → startClarification() → clarifier agent returns Q1
    → pendingQuestion = Q1, send to Telegram
    → return "MATURATION_CLARIFYING:name:id"
    → Job 1 ends

Message handler (synchronous):
  User sends response R1
    → checkMaturationClarify() finds the run
    → handleClarifyResponse(run, R1)
      → store Q1/R1
      → call clarifier(turn=2, history=[Q1/R1])
      → returns QUESTION with Q2
      → pendingQuestion = Q2, send to Telegram
      → return "waiting"

  User sends response R2
    → handleClarifyResponse(run, R2)
      → store Q2/R2
      → call clarifier(turn=3, history=[Q1/R1, Q2/R2])
      → returns DONE, ambiguityScore=3
      → clear pendingQuestion
      → build enriched input = rawInput + Q&A
      → spawnClaude understander with enriched input → UNDERSTANDING.md v2
      → launch() Job 2: explore → confront → synthesize → advocate
      → return "done"
```

---

## Edge Cases

- **User sends a command during clarify** (e.g., `/help`): The check happens in `processMessageInput` which is the text/voice handler. Commands are routed by grammY composers BEFORE `processMessageInput`, so `/help` still works. Only free-text messages are captured.
- **Bot restarts during clarify**: `meta.json` persists the state. On restart, the next user message triggers `checkMaturationClarify` which reads from disk — no state lost.
- **User never responds**: Run stays in clarify with `pendingQuestion` set. TTL of 7 days (from maturation run expiry) eventually cleans it up.
- **Voice message during clarify**: Already transcribed before `processMessageInput` runs, so it works transparently.
- **Multiple concurrent maturations**: `checkMaturationClarify` matches by `chatId + threadId`, so only the active run for that chat/thread is affected.

---

## Test Plan

- Unit tests for `checkMaturationClarify` (find/not-find matching runs)
- Unit tests for `handleClarifyResponse` (QUESTION path, DONE path, max turns)
- Unit tests for `startClarification` (initial call, JSON parsing)
- Unit tests for new types (`ClarificationState`, `ClarificationQA`)
- Integration: mock `callClaude` to return JSON responses, verify full loop
- Edge case: command during clarify is not captured
- Edge case: persistence across simulated restart
