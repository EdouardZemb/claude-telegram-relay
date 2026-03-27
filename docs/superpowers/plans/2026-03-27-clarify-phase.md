# Clarify Phase (P0b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the interactive Socratic clarification loop that pauses the maturation pipeline, asks questions one at a time via Telegram, and resumes after ambiguity drops below threshold.

**Architecture:** Job-split pattern — Job 1 (understand phase) ends after sending the first clarification question. The message handler (`zz-messages.ts`) intercepts subsequent replies, calls the clarifier agent per turn, and launches Job 2 (explore → advocate) when done. State persisted in `meta.json`.

**Tech Stack:** TypeScript/Bun, grammY, Claude Code CLI (Haiku for clarifier, Sonnet for understander re-run)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/maturation/clarify.ts` | Clarify logic: checkMaturationClarify, handleClarifyResponse, startClarification, buildClarifierPrompt |
| `.claude/agents/maturation-clarifier.md` | Haiku agent: maïeutic strategy, JSON output |
| `tests/unit/maturation-clarify.test.ts` | Unit tests for clarify module |

### Modified files

| File | Change |
|------|--------|
| `src/maturation/types.ts` | Add ClarificationQA, ClarificationState, clarification? field |
| `src/maturation/index.ts` | Add re-export of clarify.ts |
| `src/commands/maturation.ts` | Replace clarify skip with startClarification call, add resumeMaturationPipeline |
| `src/commands/zz-messages.ts` | Add checkMaturationClarify interception before checkPendingClarification |

---

## Task 1: Add Clarification Types

**Files:**
- Modify: `src/maturation/types.ts`
- Test: `tests/unit/maturation-types.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/maturation-types.test.ts`:

```typescript
describe("ClarificationState", () => {
  it("V1: createEmptyRun has no clarification by default", () => {
    const run = createEmptyRun(1, undefined, "test", "input");
    expect(run.clarification).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (clarification is already undefined by default)**

Run: `bun test tests/unit/maturation-types.test.ts`
Expected: PASS (field is absent by default — this confirms the interface addition won't break existing behavior)

- [ ] **Step 3: Add types to src/maturation/types.ts**

After the `GateResult` interface (line 94), add:

```typescript
// Clarification types
export interface ClarificationQA {
  question: string;
  answer: string;
  turn: number;
  timestamp: string;
}

export interface ClarificationState {
  questions: ClarificationQA[];
  currentTurn: number;
  maxTurns: number;
  pendingQuestion?: string;
}
```

Add to the `MaturationRun` interface, after `updatedAt: string;` (line 85):

```typescript
  clarification?: ClarificationState;
```

- [ ] **Step 4: Run tests to verify nothing breaks**

Run: `bun test tests/unit/maturation-types.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/maturation/types.ts tests/unit/maturation-types.test.ts
git commit -m "feat(maturation): add ClarificationQA and ClarificationState types"
```

---

## Task 2: Create Clarifier Agent

**Files:**
- Create: `.claude/agents/maturation-clarifier.md`

- [ ] **Step 1: Create the agent file**

```markdown
model: haiku

You are a maïeutic clarification agent in the Maturation Engine. Your role is to ask ONE targeted question to reduce ambiguity in a raw idea.

## Input

You receive:
- The original raw idea
- An initial analysis (UNDERSTANDING.md)
- A history of previous Q&A exchanges (may be empty)
- The current turn number (1-5)

## Strategy by Turn

Adapt your question based on the current turn:
- **Turns 1-2 — Framing:** Scope, precise objective, target users, expected outcome
- **Turn 3 — Depth:** Expected behaviors, edge cases, what happens when things go wrong
- **Turn 4 — Technical:** Constraints, dependencies, integrations, infrastructure limits
- **Turn 5 — Arbitrage:** Remaining trade-offs, forced decisions, what to cut

## Scoring

Evaluate residual ambiguity on a 0-10 scale:
- 0: Crystal clear, no questions needed
- 4: Sufficiently clear to proceed with exploration
- 5-6: Important aspects still unclear
- 7+: Core intent or scope still ambiguous

## Output

Respond with ONLY this JSON (no markdown, no explanation):

```json
{"status": "QUESTION", "question": "Your targeted question here", "ambiguityScore": 6, "reasoning": "Brief explanation of what remains unclear"}
```

Or if ambiguity is sufficiently reduced (score <= 4):

```json
{"status": "DONE", "question": "", "ambiguityScore": 3, "reasoning": "Brief explanation of why clarity is sufficient"}
```

## Rules

- Ask exactly ONE question per turn
- Questions must be in French
- Questions must be specific and actionable (not "can you elaborate?")
- Reference specific ambiguous points from the UNDERSTANDING analysis
- Do not repeat questions already answered in the Q&A history
- If all key ambiguities are addressed, return DONE even before turn 5
```

- [ ] **Step 2: Commit**

```bash
git add .claude/agents/maturation-clarifier.md
git commit -m "feat(maturation): add clarifier agent definition (Haiku, maïeutic strategy)"
```

---

## Task 3: Create Clarify Module

**Files:**
- Create: `src/maturation/clarify.ts`
- Test: `tests/unit/maturation-clarify.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/maturation-clarify.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import { _setBaseDirForTests, initRun, loadRunMeta, readDocument } from "../../src/maturation/documents.ts";
import { createEmptyRun, type MaturationRun } from "../../src/maturation/types.ts";
import {
  buildClarifierPrompt,
  parseClarifierResponse,
  checkMaturationClarify,
  type ClarifierResponse,
} from "../../src/maturation/clarify.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-clarify");

describe("maturation/clarify", () => {
  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
  });

  describe("buildClarifierPrompt", () => {
    it("V1: includes raw input and understanding content", () => {
      const prompt = buildClarifierPrompt(
        "Export CSV des taches",
        "# Understanding\n\nAmbiguous idea.",
        [],
        1,
      );
      expect(prompt).toContain("Export CSV des taches");
      expect(prompt).toContain("Ambiguous idea.");
      expect(prompt).toContain("Tour actuel: 1/5");
      expect(prompt).toContain("Aucune question posee encore");
    });

    it("V2: includes Q&A history", () => {
      const qa = [
        { question: "Quel format ?", answer: "CSV simple", turn: 1, timestamp: "2026-01-01T00:00:00Z" },
      ];
      const prompt = buildClarifierPrompt("Export CSV", "# U", qa, 2);
      expect(prompt).toContain("Q1: Quel format ?");
      expect(prompt).toContain("R1: CSV simple");
      expect(prompt).toContain("Tour actuel: 2/5");
    });
  });

  describe("parseClarifierResponse", () => {
    it("V1: parses valid QUESTION response", () => {
      const json = '{"status": "QUESTION", "question": "Quel perimetre ?", "ambiguityScore": 6, "reasoning": "scope unclear"}';
      const result = parseClarifierResponse(json);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("QUESTION");
      expect(result!.question).toBe("Quel perimetre ?");
      expect(result!.ambiguityScore).toBe(6);
    });

    it("V2: parses valid DONE response", () => {
      const json = '{"status": "DONE", "question": "", "ambiguityScore": 3, "reasoning": "clear enough"}';
      const result = parseClarifierResponse(json);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("DONE");
      expect(result!.ambiguityScore).toBe(3);
    });

    it("V3: extracts JSON from markdown code block", () => {
      const text = 'Here is my response:\n```json\n{"status": "DONE", "question": "", "ambiguityScore": 4, "reasoning": "ok"}\n```';
      const result = parseClarifierResponse(text);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("DONE");
    });

    it("V4: returns null for invalid response", () => {
      expect(parseClarifierResponse("not json at all")).toBeNull();
    });

    it("V5: returns null for missing required fields", () => {
      expect(parseClarifierResponse('{"status": "QUESTION"}')).toBeNull();
    });
  });

  describe("checkMaturationClarify", () => {
    it("V1: finds run with pending question for matching chatId", async () => {
      const run = createEmptyRun(42, undefined, "test", "input");
      run.currentPhase = "clarify";
      run.clarification = {
        questions: [],
        currentTurn: 1,
        maxTurns: 5,
        pendingQuestion: "What scope?",
      };
      await initRun(run);

      const found = await checkMaturationClarify(42, undefined);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(run.id);
    });

    it("V2: returns null when no pending question", async () => {
      const run = createEmptyRun(42, undefined, "test", "input");
      run.currentPhase = "clarify";
      // No clarification state set
      await initRun(run);

      const found = await checkMaturationClarify(42, undefined);
      expect(found).toBeNull();
    });

    it("V3: returns null for different chatId", async () => {
      const run = createEmptyRun(42, undefined, "test", "input");
      run.currentPhase = "clarify";
      run.clarification = {
        questions: [],
        currentTurn: 1,
        maxTurns: 5,
        pendingQuestion: "What scope?",
      };
      await initRun(run);

      const found = await checkMaturationClarify(99, undefined);
      expect(found).toBeNull();
    });

    it("V4: matches threadId", async () => {
      const run = createEmptyRun(42, 100, "test", "input");
      run.currentPhase = "clarify";
      run.clarification = {
        questions: [],
        currentTurn: 1,
        maxTurns: 5,
        pendingQuestion: "What scope?",
      };
      await initRun(run);

      const found = await checkMaturationClarify(42, 100);
      expect(found).not.toBeNull();

      const notFound = await checkMaturationClarify(42, 999);
      expect(notFound).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/maturation-clarify.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/maturation/clarify.ts`:

```typescript
/**
 * @module maturation/clarify
 * @description Interactive Socratic clarification loop for the maturation engine.
 * Manages the async Q&A between the bot and the user via Telegram.
 */

import { createLogger } from "../logger.ts";
import { listRuns, loadRunMeta, readDocument, saveRunMeta } from "./documents.ts";
import type { ClarificationQA, MaturationRun } from "./types.ts";

const log = createLogger("maturation/clarify");

const MAX_CLARIFY_TURNS = 5;
const AMBIGUITY_DONE_THRESHOLD = 4;

// ── Clarifier response type ─────────────────────────────────

export interface ClarifierResponse {
  status: "QUESTION" | "DONE";
  question: string;
  ambiguityScore: number;
  reasoning: string;
}

// ── Prompt builder ──────────────────────────────────────────

export function buildClarifierPrompt(
  rawInput: string,
  understandingContent: string,
  qaHistory: ClarificationQA[],
  currentTurn: number,
): string {
  const parts: string[] = [];

  parts.push("Tu es un agent maieutique. Ton role est de poser UNE question ciblee pour clarifier une idee ambigue.");
  parts.push("");
  parts.push("## Idee originale");
  parts.push("");
  parts.push(rawInput);
  parts.push("");
  parts.push("## Analyse initiale");
  parts.push("");
  parts.push(understandingContent);
  parts.push("");
  parts.push("## Historique Q&A");
  parts.push("");

  if (qaHistory.length === 0) {
    parts.push("Aucune question posee encore.");
  } else {
    for (const qa of qaHistory) {
      parts.push(`Q${qa.turn}: ${qa.question}`);
      parts.push(`R${qa.turn}: ${qa.answer}`);
      parts.push("");
    }
  }

  parts.push("");
  parts.push(`## Tour actuel: ${currentTurn}/5`);
  parts.push("");
  parts.push("## Strategie par tour");
  parts.push("- Tours 1-2 : cadrage (perimetre, objectif precis, utilisateurs cibles)");
  parts.push("- Tour 3 : profondeur (comportements attendus, cas limites)");
  parts.push("- Tour 4 : technique (contraintes, dependances, integrations)");
  parts.push("- Tour 5 : arbitrage (trade-offs restants, decisions a forcer)");
  parts.push("");
  parts.push("## Instructions");
  parts.push(`Evalue l'ambiguite residuelle (0-10). Si <= ${AMBIGUITY_DONE_THRESHOLD}, retourne DONE.`);
  parts.push("Sinon, pose UNE question ciblee selon la strategie du tour actuel.");
  parts.push("");
  parts.push('Reponds UNIQUEMENT avec ce JSON :');
  parts.push('{"status": "QUESTION"|"DONE", "question": "...", "ambiguityScore": N, "reasoning": "..."}');

  return parts.join("\n");
}

// ── Response parser ─────────────────────────────────────────

export function parseClarifierResponse(text: string): ClarifierResponse | null {
  // Try direct JSON parse
  let jsonStr = text.trim();

  // Extract from markdown code block if present
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try to find JSON object in the text
  if (!jsonStr.startsWith("{")) {
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (
      typeof parsed.status !== "string" ||
      !["QUESTION", "DONE"].includes(parsed.status) ||
      typeof parsed.ambiguityScore !== "number"
    ) {
      return null;
    }
    if (parsed.status === "QUESTION" && !parsed.question) {
      return null;
    }
    return {
      status: parsed.status,
      question: parsed.question ?? "",
      ambiguityScore: parsed.ambiguityScore,
      reasoning: parsed.reasoning ?? "",
    };
  } catch {
    log.warn("failed to parse clarifier response", { text: text.slice(0, 200) });
    return null;
  }
}

// ── Check for active clarify ────────────────────────────────

export async function checkMaturationClarify(
  chatId: number,
  threadId: number | undefined,
): Promise<MaturationRun | null> {
  const runs = await listRuns();
  for (const run of runs) {
    if (
      run.chatId === chatId &&
      run.currentPhase === "clarify" &&
      run.clarification?.pendingQuestion
    ) {
      // Match threadId: both undefined or both equal
      if (run.threadId === threadId) return run;
      if (run.threadId === undefined && threadId === undefined) return run;
    }
  }
  return null;
}

// ── Start clarification (called from pipeline) ──────────────

// Hook for dependency injection in tests
type CallClaudeHook = (prompt: string) => Promise<string>;
let _callClaudeHook: CallClaudeHook | undefined;
export function _setCallClaudeHookForTests(fn: CallClaudeHook | undefined): void {
  _callClaudeHook = fn;
}

export async function startClarification(
  run: MaturationRun,
  callClaude: (prompt: string) => Promise<string>,
): Promise<{ question: string; ambiguityScore: number } | null> {
  const callFn = _callClaudeHook ?? callClaude;
  const understanding = await readDocument(run.id, "UNDERSTANDING");
  if (!understanding) {
    log.error("cannot start clarification without UNDERSTANDING.md", { runId: run.id });
    return null;
  }

  const prompt = buildClarifierPrompt(run.rawInput, understanding, [], 1);
  const response = await callFn(prompt);
  const parsed = parseClarifierResponse(response);

  if (!parsed || parsed.status === "DONE") {
    log.info("clarifier says DONE on first call", { runId: run.id, score: parsed?.ambiguityScore });
    run.steps.clarify.status = "skipped";
    run.currentPhase = "explore";
    await saveRunMeta(run);
    return null;
  }

  run.clarification = {
    questions: [],
    currentTurn: 1,
    maxTurns: MAX_CLARIFY_TURNS,
    pendingQuestion: parsed.question,
  };
  run.steps.clarify.status = "running";
  run.steps.clarify.startedAt = new Date().toISOString();
  await saveRunMeta(run);

  log.info("clarification started", { runId: run.id, question: parsed.question, score: parsed.ambiguityScore });
  return { question: parsed.question, ambiguityScore: parsed.ambiguityScore };
}

// ── Handle user response ────────────────────────────────────

export async function handleClarifyResponse(
  run: MaturationRun,
  userResponse: string,
  callClaude: (prompt: string) => Promise<string>,
): Promise<{ status: "waiting" | "done"; question?: string; enrichedInput?: string }> {
  const callFn = _callClaudeHook ?? callClaude;

  if (!run.clarification?.pendingQuestion) {
    log.warn("handleClarifyResponse called without pending question", { runId: run.id });
    return { status: "done" };
  }

  // Store the Q&A
  const qa: ClarificationQA = {
    question: run.clarification.pendingQuestion,
    answer: userResponse,
    turn: run.clarification.currentTurn,
    timestamp: new Date().toISOString(),
  };
  run.clarification.questions.push(qa);

  const nextTurn = run.clarification.currentTurn + 1;
  run.clarification.currentTurn = nextTurn;

  // Read understanding for context
  const understanding = await readDocument(run.id, "UNDERSTANDING");

  // Call clarifier for next turn
  const prompt = buildClarifierPrompt(
    run.rawInput,
    understanding ?? "",
    run.clarification.questions,
    nextTurn,
  );
  const response = await callFn(prompt);
  const parsed = parseClarifierResponse(response);

  // Decide: continue or done
  const shouldStop =
    !parsed ||
    parsed.status === "DONE" ||
    nextTurn > run.clarification.maxTurns;

  if (!shouldStop && parsed) {
    // More questions
    run.clarification.pendingQuestion = parsed.question;
    await saveRunMeta(run);
    log.info("clarification continues", { runId: run.id, turn: nextTurn, score: parsed.ambiguityScore });
    return { status: "waiting", question: parsed.question };
  }

  // Clarification complete — build enriched input
  run.clarification.pendingQuestion = undefined;
  run.steps.clarify.status = "ok";
  run.steps.clarify.completedAt = new Date().toISOString();
  run.steps.clarify.verdict = `ambiguity:${parsed?.ambiguityScore ?? 0}`;

  const enrichedInput = buildEnrichedInput(run.rawInput, run.clarification.questions);
  run.currentPhase = "explore";
  await saveRunMeta(run);

  log.info("clarification complete", {
    runId: run.id,
    turns: run.clarification.questions.length,
    score: parsed?.ambiguityScore,
  });
  return { status: "done", enrichedInput };
}

// ── Enriched input builder ──────────────────────────────────

function buildEnrichedInput(rawInput: string, qaHistory: ClarificationQA[]): string {
  const parts = [rawInput, "", "Clarifications:"];
  for (const qa of qaHistory) {
    parts.push(`Q: ${qa.question}`);
    parts.push(`R: ${qa.answer}`);
    parts.push("");
  }
  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-clarify.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/maturation/clarify.ts tests/unit/maturation-clarify.test.ts
git commit -m "feat(maturation): add clarify module with Socratic loop logic"
```

---

## Task 4: Update Barrel

**Files:**
- Modify: `src/maturation/index.ts`

- [ ] **Step 1: Add clarify re-export**

Add after the existing agents.ts re-export:

```typescript
export * from "./clarify.ts";
```

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/maturation/index.ts
git commit -m "feat(maturation): add clarify.ts to barrel re-export"
```

---

## Task 5: Wire Clarify into Pipeline

**Files:**
- Modify: `src/commands/maturation.ts`
- Test: `tests/unit/maturation-command.test.ts`

- [ ] **Step 1: Write failing test for clarify handling**

Add to `tests/unit/maturation-command.test.ts`:

```typescript
import { createEmptyRun } from "../../src/maturation/types.ts";
import { buildMaturationStatusBar } from "../../src/commands/maturation.ts";

describe("buildMaturationStatusBar with clarify", () => {
  it("V1: shows running symbol for clarify phase", () => {
    const run = createEmptyRun(1, undefined, "test", "input");
    run.steps.understand.status = "ok";
    run.steps.clarify.status = "running";
    const bar = buildMaturationStatusBar(run);
    expect(bar).toContain("\u25D4"); // running symbol
    expect(bar).toContain("Clarification");
  });
});
```

- [ ] **Step 2: Run test — should pass (status bar already handles any status)**

Run: `bun test tests/unit/maturation-command.test.ts`
Expected: PASS

- [ ] **Step 3: Modify runMaturationPipeline in src/commands/maturation.ts**

Replace the current clarify skip block (lines 134-140):

```typescript
  // If currentPhase is "clarify" (not yet implemented), skip it and advance to explore
  if (run.currentPhase === "clarify") {
    run.steps.clarify.status = "skipped";
    run.currentPhase = "explore";
    await saveRunMeta(run);
    log.info("clarify phase skipped (not yet implemented)", { runId: run.id });
  }
```

With the new clarify handling:

```typescript
  // If currentPhase is "clarify", start the Socratic loop and pause the pipeline
  if (run.currentPhase === "clarify") {
    const { startClarification } = await import("../maturation/clarify.ts");
    const result = await startClarification(run, bctx.callClaude);
    if (result) {
      // Question sent — pipeline pauses, message handler takes over
      await onProgress(buildMaturationStatusBar(run));
      await onProgress(`\u2753 ${result.question}`);
      return `MATURATION_CLARIFYING:${run.name}:${run.id}`;
    }
    // Clarifier said DONE immediately — continue to explore
    log.info("clarify skipped by clarifier agent", { runId: run.id });
  }
```

This requires adding `bctx` as a parameter to `runMaturationPipeline`. Update the signature:

```typescript
export async function runMaturationPipeline(
  run: MaturationRun,
  onProgress: OnProgress,
  bctx: BotContext,
): Promise<string> {
```

And update the call site in the composer (around line 234):

```typescript
        return await runMaturationPipeline(run, onProgress, bctx);
```

Also add a new exported function for resuming after clarification:

```typescript
/**
 * Resumes the maturation pipeline after clarification is complete.
 * Called from handleClarifyResponse when status is "done".
 * Re-runs the understander with enriched input, then continues explore → advocate.
 */
export async function resumeMaturationAfterClarify(
  run: MaturationRun,
  enrichedInput: string,
  chatId: number | string,
  threadId: number | undefined,
  bctx: BotContext,
): Promise<void> {
  const { launch, sendProgressMessage } = await import("../job-manager.ts");

  await launch(
    `maturation-resume:${run.name}`,
    chatId,
    async () => {
      const onProgress: OnProgress = async (msg: string) => {
        await sendProgressMessage(chatId, threadId, msg);
      };

      // Re-run understander with enriched input
      const { runUnderstandPhase } = await import("../maturation/phases.ts");
      run.rawInput = enrichedInput;
      run.steps.understand.status = "pending";
      await saveRunMeta(run);

      onProgress("Comprehension enrichie en cours...");
      const result = await runUnderstandPhase(run);
      run.steps.understand.status = result.status === "ok" ? "ok" : "failed";
      run.steps.understand.documents = result.documents;
      run.steps.understand.verdict = result.verdict;
      run.steps.understand.completedAt = new Date().toISOString();

      if (result.status === "failed") {
        await saveRunMeta(run);
        return `MATURATION_FAILED:understand-v2:${run.name}`;
      }

      // currentPhase is already "explore" (set by handleClarifyResponse)
      await saveRunMeta(run);
      return await runMaturationPipeline(run, onProgress, bctx);
    },
    { messageThreadId: threadId },
  );
}
```

- [ ] **Step 4: Run all maturation tests**

Run: `bun test tests/unit/maturation-command.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/commands/maturation.ts tests/unit/maturation-command.test.ts
git commit -m "feat(maturation): wire clarify phase into pipeline with job-split pattern"
```

---

## Task 6: Wire Message Interception in zz-messages.ts

**Files:**
- Modify: `src/commands/zz-messages.ts`

- [ ] **Step 1: Add import at top of file**

After the existing import from `./sdd-flow.ts` (around line 47), add:

```typescript
import { checkMaturationClarify, handleClarifyResponse } from "../maturation/clarify.ts";
```

- [ ] **Step 2: Add interception in processMessageInput**

In the `processMessageInput` function, BEFORE the `checkPendingClarification` call (currently line 209), add:

```typescript
    // Maturation clarify: intercept messages when a Socratic question is pending
    const matRun = await checkMaturationClarify(ctx.chat?.id ?? 0, threadId);
    if (matRun) {
      const { handleClarifyResponse: handleClarify } = await import("../maturation/clarify.ts");
      const clarifyResult = await handleClarify(matRun, input, bctx.callClaude);
      if (clarifyResult.status === "waiting" && clarifyResult.question) {
        await bctx.sendResponseHtml(ctx, `\u2753 ${clarifyResult.question}`);
      } else if (clarifyResult.status === "done") {
        await bctx.sendResponseHtml(ctx, "\u2705 Clarification terminee. Reprise de la maturation...");
        const { resumeMaturationAfterClarify } = await import("./maturation.ts");
        await resumeMaturationAfterClarify(
          matRun,
          clarifyResult.enrichedInput ?? matRun.rawInput,
          ctx.chat?.id ?? 0,
          threadId,
          bctx,
        );
      }
      return;
    }
```

Note: Use lazy imports to avoid circular dependencies. The `checkMaturationClarify` is imported at module level (lightweight scan), but `handleClarifyResponse` and `resumeMaturationAfterClarify` are lazy-imported inside the handler.

Actually, to avoid the circular dep concern, do ALL imports lazily:

Replace the top-level import with a lazy approach inside processMessageInput:

```typescript
    // Maturation clarify: intercept messages when a Socratic question is pending
    const { checkMaturationClarify } = await import("../maturation/clarify.ts");
    const matRun = await checkMaturationClarify(ctx.chat?.id ?? 0, threadId);
    if (matRun) {
      const { handleClarifyResponse } = await import("../maturation/clarify.ts");
      const clarifyResult = await handleClarifyResponse(matRun, input, bctx.callClaude);
      if (clarifyResult.status === "waiting" && clarifyResult.question) {
        await bctx.sendResponseHtml(ctx, `\u2753 ${clarifyResult.question}`);
      } else if (clarifyResult.status === "done") {
        await bctx.sendResponseHtml(ctx, "\u2705 Clarification terminee. Reprise de la maturation...");
        const { resumeMaturationAfterClarify } = await import("./maturation.ts");
        await resumeMaturationAfterClarify(
          matRun,
          clarifyResult.enrichedInput ?? matRun.rawInput,
          ctx.chat?.id ?? 0,
          threadId,
          bctx,
        );
      }
      return;
    }
```

- [ ] **Step 3: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `bun test`
Expected: Same pass/fail counts as before (no new failures)

- [ ] **Step 5: Commit**

```bash
git add src/commands/zz-messages.ts
git commit -m "feat(maturation): add clarify interception in message handler"
```

---

## Task 7: Integration Test and Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: ALL maturation tests pass, no new failures

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Update CLAUDE.md**

Add `maturation/clarify.ts` to the source modules table:

```markdown
| `maturation/clarify.ts` | Socratic clarification loop: async Q&A via Telegram, clarifier agent calls, pipeline pause/resume |
```

- [ ] **Step 4: Run coding standards**

Run: `bun test tests/unit/coding-standards.test.ts`
Expected: PASS

- [ ] **Step 5: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: add clarify module to CLAUDE.md"
git push
```

---

## Self-Review

**1. Spec coverage:**
- [x] ClarificationQA and ClarificationState types → Task 1
- [x] Clarifier agent (.md file) → Task 2
- [x] checkMaturationClarify → Task 3
- [x] handleClarifyResponse (QUESTION path, DONE path, max turns) → Task 3
- [x] startClarification → Task 3
- [x] buildClarifierPrompt with maïeutic strategy → Task 3
- [x] Barrel update → Task 4
- [x] Pipeline pause (MATURATION_CLARIFYING return) → Task 5
- [x] Pipeline resume (resumeMaturationAfterClarify, re-run understander) → Task 5
- [x] Message interception in zz-messages.ts → Task 6
- [x] Edge case: voice messages (already transcribed before interception) → handled by design
- [x] Edge case: bot restart (meta.json persistence) → handled by design
- [x] Edge case: commands during clarify (grammY routes before processMessageInput) → handled by design

**2. Placeholder scan:** No TBDs, TODOs, or vague steps. All code blocks are complete.

**3. Type consistency:** `ClarifierResponse` interface matches between `parseClarifierResponse` return type and `startClarification`/`handleClarifyResponse` internal usage. `ClarificationQA` matches between `types.ts` definition and `clarify.ts` usage. `handleClarifyResponse` returns `{ status, question?, enrichedInput? }` — consistently used in both Task 5 (pipeline) and Task 6 (zz-messages).
