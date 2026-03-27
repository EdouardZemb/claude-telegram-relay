# Interactive Decision Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interactive checkpoints that pause the maturation pipeline when blocking decisions or showstoppers are detected, present options via Telegram keyboard, and resume after the user decides.

**Architecture:** Generic checkpoint module (`src/maturation/checkpoint.ts`) handles extraction, Haiku advisor, keyboard building, and response handling. Two injection points in `runMaturationPipeline` (post-synthesize, post-advocate). Global decisions stored in `.maturation/decisions.json`. Message interception in `zz-messages.ts` for free-text responses.

**Tech Stack:** TypeScript/Bun, grammY InlineKeyboard, Claude Haiku (advisor via callClaude)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/maturation/checkpoint.ts` | Checkpoint logic: extraction, advisor, keyboard, start/handle/check, global decisions I/O |
| `tests/unit/maturation-checkpoint.test.ts` | Unit tests for checkpoint module |

### Modified files

| File | Change |
|------|--------|
| `src/maturation/types.ts` | Add CheckpointDecision, GlobalDecision, pendingCheckpoint field, resolvedCheckpoints field |
| `src/maturation/agents.ts` | Add decisions context to buildPhasePrompt |
| `src/maturation/index.ts` | Re-export checkpoint.ts |
| `src/commands/maturation.ts` | Checkpoint injection in pipeline + callback handlers + resumeAfterCheckpoint |
| `src/commands/zz-messages.ts` | Add checkpoint free-text interception |

---

## Task 1: Add Checkpoint Types

**Files:**
- Modify: `src/maturation/types.ts`
- Test: `tests/unit/maturation-types.test.ts`

- [ ] **Step 1: Add types to src/maturation/types.ts**

After the `ClarificationState` interface (line 110), add:

```typescript
// Checkpoint types
export interface CheckpointDecision {
  id: string;
  source: "synthesize" | "advocate";
  summary: string;
  options: string[];
  recommendation: "CONTINUE" | "RE-EXPLORE";
  tags: string[];
  awaitingFreeText?: boolean;
  userChoice?: string;
  resolvedAt?: string;
}

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

Add to `MaturationRun` interface, after `clarification?`:

```typescript
  pendingCheckpoint?: CheckpointDecision;
  resolvedCheckpoints?: CheckpointDecision[];
```

- [ ] **Step 2: Add test**

Add to `tests/unit/maturation-types.test.ts`:

```typescript
describe("CheckpointDecision", () => {
  it("V1: createEmptyRun has no pendingCheckpoint by default", () => {
    const run = createEmptyRun(1, undefined, "test", "input");
    expect(run.pendingCheckpoint).toBeUndefined();
    expect(run.resolvedCheckpoints).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/unit/maturation-types.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/maturation/types.ts tests/unit/maturation-types.test.ts
git commit -m "feat(maturation): add CheckpointDecision and GlobalDecision types"
```

---

## Task 2: Create Checkpoint Module

**Files:**
- Create: `src/maturation/checkpoint.ts`
- Test: `tests/unit/maturation-checkpoint.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/maturation-checkpoint.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import { _setBaseDirForTests, initRun } from "../../src/maturation/documents.ts";
import { createEmptyRun, type MaturationRun } from "../../src/maturation/types.ts";
import {
  extractDecisionPoints,
  parseAdvisorResponse,
  buildCheckpointKeyboard,
  checkMaturationCheckpoint,
  handleCheckpointResponse,
  loadGlobalDecisions,
  saveGlobalDecision,
  _setCallClaudeHookForTests,
} from "../../src/maturation/checkpoint.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-checkpoint");

describe("maturation/checkpoint", () => {
  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    _setCallClaudeHookForTests(undefined);
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
  });

  describe("extractDecisionPoints", () => {
    it("V1: extracts numbered items from synthesize questions ouvertes", () => {
      const output = "## Questions ouvertes\n\n1. Accepter le pivot CSV\n2. Valider l'envoi anonymise\n\n## Autre section";
      const items = extractDecisionPoints(output, "synthesize");
      expect(items.length).toBe(2);
      expect(items[0]).toContain("pivot CSV");
    });

    it("V2: extracts from decisions bloquantes section", () => {
      const output = "## Decisions bloquantes\n\n1. Choisir entre PSD2 et CSV\n\n## Suite";
      const items = extractDecisionPoints(output, "synthesize");
      expect(items.length).toBe(1);
    });

    it("V3: extracts showstopper from advocate output", () => {
      const output = "## Verdict\n\n**SHOWSTOPPER** : Pipeline cloud contradicts local-first spec.\n\nDetails...";
      const items = extractDecisionPoints(output, "advocate");
      expect(items.length).toBe(1);
      expect(items[0]).toContain("Pipeline cloud");
    });

    it("V4: returns empty array when no decisions found", () => {
      const output = "## Score de maturite : 8/10\n\nAll good.";
      expect(extractDecisionPoints(output, "synthesize")).toEqual([]);
    });

    it("V5: returns empty for advocate PASS verdict", () => {
      const output = "## Verdict\n\n**PASS** : No showstoppers.";
      expect(extractDecisionPoints(output, "advocate")).toEqual([]);
    });
  });

  describe("parseAdvisorResponse", () => {
    it("V1: parses valid JSON", () => {
      const json = '{"summary":"Probleme X","options":["Option A","Option B"],"recommendation":"CONTINUE","tags":["banking"]}';
      const result = parseAdvisorResponse(json);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Probleme X");
      expect(result!.options.length).toBe(2);
      expect(result!.recommendation).toBe("CONTINUE");
      expect(result!.tags).toContain("banking");
    });

    it("V2: extracts from markdown code block", () => {
      const text = '```json\n{"summary":"X","options":["A"],"recommendation":"RE-EXPLORE","tags":[]}\n```';
      const result = parseAdvisorResponse(text);
      expect(result).not.toBeNull();
      expect(result!.recommendation).toBe("RE-EXPLORE");
    });

    it("V3: returns null for invalid JSON", () => {
      expect(parseAdvisorResponse("not json")).toBeNull();
    });

    it("V4: returns null for missing fields", () => {
      expect(parseAdvisorResponse('{"summary":"X"}')).toBeNull();
    });
  });

  describe("buildCheckpointKeyboard", () => {
    it("V1: builds keyboard with options + Autre button", () => {
      const kb = buildCheckpointKeyboard("run-123", ["Option A", "Option B"]);
      const buttons = kb.inline_keyboard.flat();
      expect(buttons.length).toBe(3);
      expect(buttons[0].callback_data).toBe("mat_cp_opt:run-123:0");
      expect(buttons[1].callback_data).toBe("mat_cp_opt:run-123:1");
      expect(buttons[2].callback_data).toBe("mat_cp_other:run-123");
      expect(buttons[2].text).toContain("Autre");
    });

    it("V2: handles 3 options", () => {
      const kb = buildCheckpointKeyboard("id", ["A", "B", "C"]);
      const buttons = kb.inline_keyboard.flat();
      expect(buttons.length).toBe(4);
    });
  });

  describe("checkMaturationCheckpoint", () => {
    it("V1: finds run with pending checkpoint", async () => {
      const run = createEmptyRun(42, undefined, "test", "input");
      run.currentPhase = "synthesize";
      run.pendingCheckpoint = {
        id: "cp-test", source: "synthesize", summary: "Test",
        options: ["A", "B"], recommendation: "CONTINUE", tags: [],
      };
      await initRun(run);

      const found = await checkMaturationCheckpoint(42, undefined);
      expect(found).not.toBeNull();
      expect(found!.pendingCheckpoint!.id).toBe("cp-test");
    });

    it("V2: returns null when no pending checkpoint", async () => {
      const run = createEmptyRun(42, undefined, "test", "input");
      await initRun(run);
      expect(await checkMaturationCheckpoint(42, undefined)).toBeNull();
    });

    it("V3: returns null for different chatId", async () => {
      const run = createEmptyRun(42, undefined, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-test", source: "synthesize", summary: "Test",
        options: ["A"], recommendation: "CONTINUE", tags: [],
      };
      await initRun(run);
      expect(await checkMaturationCheckpoint(99, undefined)).toBeNull();
    });
  });

  describe("handleCheckpointResponse", () => {
    it("V1: resolves checkpoint and returns action", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-1", source: "synthesize", summary: "Choix pivot",
        options: ["CSV", "PSD2"], recommendation: "CONTINUE", tags: ["banking"],
      };
      await initRun(run);

      const result = await handleCheckpointResponse(run, "CSV");
      expect(result.action).toBe("CONTINUE");
      expect(run.pendingCheckpoint).toBeUndefined();
      expect(run.resolvedCheckpoints!.length).toBe(1);
      expect(run.resolvedCheckpoints![0].userChoice).toBe("CSV");
    });
  });

  describe("loadGlobalDecisions / saveGlobalDecision", () => {
    it("V1: saves and loads decisions", async () => {
      await saveGlobalDecision({
        id: "gd-1", runId: "r1", runName: "test",
        source: "synthesize", summary: "Pivot CSV",
        userChoice: "CSV", timestamp: new Date().toISOString(), tags: ["banking"],
      });
      const decisions = await loadGlobalDecisions();
      expect(decisions.length).toBe(1);
      expect(decisions[0].userChoice).toBe("CSV");
    });

    it("V2: filters by tags", async () => {
      await saveGlobalDecision({
        id: "gd-1", runId: "r1", runName: "t1",
        source: "synthesize", summary: "A",
        userChoice: "X", timestamp: new Date().toISOString(), tags: ["banking"],
      });
      await saveGlobalDecision({
        id: "gd-2", runId: "r2", runName: "t2",
        source: "advocate", summary: "B",
        userChoice: "Y", timestamp: new Date().toISOString(), tags: ["security"],
      });
      const filtered = await loadGlobalDecisions(["banking"]);
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe("gd-1");
    });

    it("V3: returns empty array if file doesn't exist", async () => {
      const decisions = await loadGlobalDecisions();
      expect(decisions).toEqual([]);
    });

    it("V4: caps at 50 entries", async () => {
      for (let i = 0; i < 55; i++) {
        await saveGlobalDecision({
          id: `gd-${i}`, runId: "r", runName: "t",
          source: "synthesize", summary: `D${i}`,
          userChoice: "X", timestamp: new Date().toISOString(), tags: [],
        });
      }
      const decisions = await loadGlobalDecisions();
      expect(decisions.length).toBe(50);
      expect(decisions[0].id).toBe("gd-5"); // oldest 5 pruned
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/maturation-checkpoint.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/maturation/checkpoint.ts`:

```typescript
/**
 * @module maturation/checkpoint
 * @description Interactive decision checkpoints for the maturation pipeline.
 * Pauses the pipeline when blocking decisions are detected, presents options
 * to the user via Telegram, and resumes based on user choice.
 */

import { randomUUID } from "crypto";
import { readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { InlineKeyboard } from "grammy";
import { createLogger } from "../logger.ts";
import { extractShowstopper } from "./scoring.ts";
import { getMaturationDir, listRuns, saveRunMeta } from "./documents.ts";
import type { CheckpointDecision, GlobalDecision, MaturationRun } from "./types.ts";

const log = createLogger("maturation/checkpoint");

const MAX_GLOBAL_DECISIONS = 50;

// ── Test hook ───────────────────────────────────────────────

let _callClaudeHook: ((prompt: string) => Promise<string>) | undefined;
export function _setCallClaudeHookForTests(
  fn: ((prompt: string) => Promise<string>) | undefined,
): void {
  _callClaudeHook = fn;
}

// ── Advisor response type ───────────────────────────────────

export interface CheckpointAdvice {
  summary: string;
  options: string[];
  recommendation: "CONTINUE" | "RE-EXPLORE";
  tags: string[];
}

// ── Extraction ──────────────────────────────────────────────

const OPEN_QUESTIONS_RE =
  /##\s*(?:Questions?\s*ouvertes?|D[eé]cisions?\s*bloquantes?)([\s\S]*?)(?=\n##|\z)/i;
const NUMBERED_ITEM_RE = /\d+\.\s+(.+)/g;

export function extractDecisionPoints(
  output: string,
  source: "synthesize" | "advocate",
): string[] {
  if (source === "advocate") {
    const showstopper = extractShowstopper(output);
    return showstopper ? [showstopper.reason] : [];
  }

  const sectionMatch = output.match(OPEN_QUESTIONS_RE);
  if (!sectionMatch) return [];

  const section = sectionMatch[1];
  const items: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(NUMBERED_ITEM_RE.source, "g");
  while ((match = re.exec(section)) !== null) {
    const item = match[1].trim();
    if (item.length > 5) items.push(item);
  }
  return items;
}

// ── Advisor response parser ─────────────────────────────────

export function parseAdvisorResponse(text: string): CheckpointAdvice | null {
  let jsonStr = text.trim();

  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

  if (!jsonStr.startsWith("{")) {
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.options) ||
      parsed.options.length === 0 ||
      !["CONTINUE", "RE-EXPLORE"].includes(parsed.recommendation)
    ) {
      return null;
    }
    return {
      summary: parsed.summary,
      options: parsed.options,
      recommendation: parsed.recommendation,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch {
    log.warn("failed to parse advisor response", { text: text.slice(0, 200) });
    return null;
  }
}

// ── Keyboard builder ────────────────────────────────────────

export function buildCheckpointKeyboard(
  runId: string,
  options: string[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < options.length; i++) {
    const label = options[i].length > 40 ? options[i].slice(0, 37) + "..." : options[i];
    kb.text(label, `mat_cp_opt:${runId}:${i}`);
    if (i < options.length - 1) kb.row();
  }
  kb.row();
  kb.text("Autre (texte libre)", `mat_cp_other:${runId}`);
  return kb;
}

// ── Advisor prompt builder ──────────────────────────────────

export function buildAdvisorPrompt(
  decisions: string[],
  source: "synthesize" | "advocate",
  specSummary: string,
  existingDecisions: GlobalDecision[],
): string {
  const parts: string[] = [];
  parts.push("Tu es un conseiller de pipeline de maturation. Un probleme bloquant a ete identifie.");
  parts.push("Ton role :");
  parts.push("1. Resumer le probleme en 2-3 phrases pour l'utilisateur");
  parts.push("2. Proposer 2-3 options concretes et actionables (en francais)");
  parts.push("3. Recommander CONTINUE (probleme tranchable sans re-exploration) ou RE-EXPLORE (probleme fondamental)");
  parts.push("");
  parts.push(`Source: ${source}`);
  parts.push("Probleme(s):");
  for (const d of decisions) {
    parts.push(`- ${d}`);
  }
  parts.push("");
  parts.push("Contexte spec:");
  parts.push(specSummary.slice(0, 500));
  parts.push("");
  parts.push("Decisions historiques pertinentes:");
  if (existingDecisions.length === 0) {
    parts.push("Aucune");
  } else {
    for (const gd of existingDecisions.slice(0, 5)) {
      parts.push(`- [${gd.source}] "${gd.summary}" -> "${gd.userChoice}"`);
    }
  }
  parts.push("");
  parts.push('Reponds UNIQUEMENT en JSON :');
  parts.push('{"summary":"...","options":["Option 1: ...","Option 2: ..."],"recommendation":"CONTINUE|RE-EXPLORE","tags":["tag1","tag2"]}');
  return parts.join("\n");
}

// ── Start checkpoint ────────────────────────────────────────

export async function startCheckpoint(
  run: MaturationRun,
  output: string,
  source: "synthesize" | "advocate",
  callClaude: (prompt: string) => Promise<string>,
): Promise<CheckpointDecision | null> {
  const callFn = _callClaudeHook ?? callClaude;
  const decisions = extractDecisionPoints(output, source);
  if (decisions.length === 0) return null;

  const globalDecisions = await loadGlobalDecisions();
  const prompt = buildAdvisorPrompt(decisions, source, output, globalDecisions);
  const response = await callFn(prompt);
  const advice = parseAdvisorResponse(response);

  if (!advice) {
    // Fallback: use raw decision text as summary, no options (free text only)
    const cp: CheckpointDecision = {
      id: `cp-${randomUUID().substring(0, 8)}`,
      source,
      summary: decisions.join("; "),
      options: [],
      recommendation: "CONTINUE",
      tags: [],
      awaitingFreeText: true,
    };
    run.pendingCheckpoint = cp;
    await saveRunMeta(run);
    log.info("checkpoint started (fallback mode)", { runId: run.id, source });
    return cp;
  }

  const cp: CheckpointDecision = {
    id: `cp-${randomUUID().substring(0, 8)}`,
    source,
    summary: advice.summary,
    options: advice.options,
    recommendation: advice.recommendation,
    tags: advice.tags,
  };
  run.pendingCheckpoint = cp;
  await saveRunMeta(run);
  log.info("checkpoint started", { runId: run.id, source, recommendation: advice.recommendation });
  return cp;
}

// ── Handle response ─────────────────────────────────────────

export async function handleCheckpointResponse(
  run: MaturationRun,
  userChoice: string,
): Promise<{ action: "CONTINUE" | "RE-EXPLORE" }> {
  if (!run.pendingCheckpoint) {
    log.warn("handleCheckpointResponse called without pending checkpoint", { runId: run.id });
    return { action: "CONTINUE" };
  }

  const cp = run.pendingCheckpoint;
  cp.userChoice = userChoice;
  cp.resolvedAt = new Date().toISOString();

  // Move to resolved list
  if (!run.resolvedCheckpoints) run.resolvedCheckpoints = [];
  run.resolvedCheckpoints.push({ ...cp });
  const action = cp.recommendation;
  run.pendingCheckpoint = undefined;
  await saveRunMeta(run);

  // Save to global decisions
  await saveGlobalDecision({
    id: cp.id,
    runId: run.id,
    runName: run.name,
    source: cp.source,
    summary: cp.summary,
    userChoice,
    timestamp: cp.resolvedAt!,
    tags: cp.tags,
  });

  log.info("checkpoint resolved", { runId: run.id, action, choice: userChoice });
  return { action };
}

// ── Check for pending checkpoint ────────────────────────────

export async function checkMaturationCheckpoint(
  chatId: number,
  threadId: number | undefined,
): Promise<MaturationRun | null> {
  const runs = await listRuns();
  for (const run of runs) {
    if (run.chatId === chatId && run.pendingCheckpoint) {
      if (run.threadId === threadId) return run;
      if (run.threadId === undefined && threadId === undefined) return run;
    }
  }
  return null;
}

// ── Global decisions I/O ────────────────────────────────────

function getDecisionsPath(): string {
  return join(getMaturationDir(), "decisions.json");
}

export async function loadGlobalDecisions(
  tags?: string[],
): Promise<GlobalDecision[]> {
  try {
    const raw = await readFile(getDecisionsPath(), "utf-8");
    let decisions: GlobalDecision[] = JSON.parse(raw);
    if (tags && tags.length > 0) {
      decisions = decisions.filter((d) =>
        d.tags.some((t) => tags.includes(t)),
      );
    }
    return decisions;
  } catch {
    return [];
  }
}

export async function saveGlobalDecision(
  decision: GlobalDecision,
): Promise<void> {
  const path = getDecisionsPath();
  let decisions: GlobalDecision[] = [];
  try {
    const raw = await readFile(path, "utf-8");
    decisions = JSON.parse(raw);
  } catch {
    // File doesn't exist yet
  }
  decisions.push(decision);
  // Cap at MAX_GLOBAL_DECISIONS
  if (decisions.length > MAX_GLOBAL_DECISIONS) {
    decisions = decisions.slice(decisions.length - MAX_GLOBAL_DECISIONS);
  }
  const { mkdir: mkdirFs } = await import("fs/promises");
  const { dirname } = await import("path");
  await mkdirFs(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${randomUUID().substring(0, 8)}`;
  await writeFile(tmp, JSON.stringify(decisions, null, 2));
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-checkpoint.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/maturation/checkpoint.ts tests/unit/maturation-checkpoint.test.ts
git commit -m "feat(maturation): add checkpoint module with extraction, advisor, keyboard, global decisions"
```

---

## Task 3: Update Barrel

**Files:**
- Modify: `src/maturation/index.ts`

- [ ] **Step 1: Add re-export**

Add after the clarify.ts line:

```typescript
export * from "./checkpoint.ts";
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add src/maturation/index.ts
git commit -m "feat(maturation): add checkpoint.ts to barrel re-export"
```

---

## Task 4: Wire Checkpoints into Pipeline

**Files:**
- Modify: `src/commands/maturation.ts`

- [ ] **Step 1: Read the file first, then make these changes**

**A. Add checkpoint injection after synthesize** (after line 182 `await onProgress(buildMaturationStatusBar(run));`):

After the existing clarify check for understand, and before the advocate loop-back check, add:

```typescript
    // Post-synthesize checkpoint: pause if open questions found
    if (phaseName === "synthesize" && result.status === "ok") {
      const { startCheckpoint, buildCheckpointKeyboard } = await import("../maturation/checkpoint.ts");
      const specOutput = result.documents[0] ?? "";
      // Read the actual document content for extraction
      const { readDocument } = await import("../maturation/documents.ts");
      const specContent = await readDocument(run.id, "SPEC-UNIFIEE") ?? "";
      const cp = await startCheckpoint(run, specContent, "synthesize", bctx.callClaude);
      if (cp) {
        const recLabel = cp.recommendation === "RE-EXPLORE" ? "Re-explorer" : "Continuer";
        const msg = `\u26A0\uFE0F <b>Decision requise</b> (${cp.source})\n\n${cp.summary}\n\n<i>Recommandation : ${recLabel}</i>`;
        await onProgress(buildMaturationStatusBar(run));
        await onProgress(msg);
        return `MATURATION_CHECKPOINT:${run.name}:${run.id}`;
      }
    }
```

**B. Replace the automatic loop-back after advocate** (replace lines 197-200):

Replace:
```typescript
    // If advocate looped back to explore, recurse
    if (phaseName === "advocate" && run.currentPhase === "explore") {
      return await runMaturationPipeline(run, onProgress, bctx);
    }
```

With:
```typescript
    // Post-advocate checkpoint: pause if showstopper found
    if (phaseName === "advocate" && result.status === "ok") {
      const { startCheckpoint } = await import("../maturation/checkpoint.ts");
      const { readDocument } = await import("../maturation/documents.ts");
      const advocateContent = await readDocument(run.id, "DEVILS-ADVOCATE") ?? "";
      const cp = await startCheckpoint(run, advocateContent, "advocate", bctx.callClaude);
      if (cp) {
        const recLabel = cp.recommendation === "RE-EXPLORE" ? "Re-explorer" : "Continuer";
        const msg = `\u26A0\uFE0F <b>Decision requise</b> (${cp.source})\n\n${cp.summary}\n\n<i>Recommandation : ${recLabel}</i>`;
        await onProgress(buildMaturationStatusBar(run));
        await onProgress(msg);
        return `MATURATION_CHECKPOINT:${run.name}:${run.id}`;
      }
      // No checkpoint needed — if advocate triggered loop-back, recurse
      if (run.currentPhase === "explore") {
        return await runMaturationPipeline(run, onProgress, bctx);
      }
    }
```

**C. Add callback handlers in the composer** (after existing `mat_validate/modify/reject` handler):

```typescript
  // Checkpoint option callbacks
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    if (!data.startsWith("mat_cp_opt:") && !data.startsWith("mat_cp_other:")) {
      await next();
      return;
    }

    await ctx.answerCallbackQuery();
    const threadId = getThreadId(ctx);

    if (data.startsWith("mat_cp_other:")) {
      // Activate free text mode
      const runId = data.split(":")[1];
      const run = await loadRunMeta(runId);
      if (!run?.pendingCheckpoint) {
        await ctx.reply("Checkpoint expire.", bctx.threadOpts(ctx));
        return;
      }
      run.pendingCheckpoint.awaitingFreeText = true;
      await saveRunMeta(run);
      await ctx.editMessageText(
        `${run.pendingCheckpoint.summary}\n\nEnvoyez votre reponse en texte libre.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // mat_cp_opt:{runId}:{index}
    const parts = data.split(":");
    const runId = parts[1];
    const optIndex = parseInt(parts[2], 10);

    const run = await loadRunMeta(runId);
    if (!run?.pendingCheckpoint) {
      await ctx.reply("Checkpoint expire.", bctx.threadOpts(ctx));
      return;
    }

    const choice = run.pendingCheckpoint.options[optIndex] ?? `Option ${optIndex + 1}`;
    const { handleCheckpointResponse } = await import("../maturation/checkpoint.ts");
    const cpResult = await handleCheckpointResponse(run, choice);

    await sendResponseHtml(
      ctx,
      `\u2705 Decision enregistree : <b>${choice}</b>`,
    );

    // Resume pipeline
    await resumeMaturationAfterCheckpoint(run, cpResult.action, ctx.chat!.id, threadId, bctx);
  });
```

**D. Add resumeMaturationAfterCheckpoint** (after `resumeMaturationAfterClarify`):

```typescript
export async function resumeMaturationAfterCheckpoint(
  run: MaturationRun,
  action: "CONTINUE" | "RE-EXPLORE",
  chatId: number | string,
  threadId: number | undefined,
  bctx: BotContext,
): Promise<void> {
  const { launch, sendProgressMessage } = await import("../job-manager.ts");

  if (action === "RE-EXPLORE") {
    // Reset explore→advocate phases and re-run
    const { type MaturationPhase } = await import("../maturation/types.ts");
    const resetPhases: MaturationPhase[] = ["explore", "confront", "synthesize", "advocate"];
    for (const p of resetPhases) {
      run.steps[p].status = "pending";
      run.steps[p].documents = [];
      run.steps[p].verdict = undefined;
      run.steps[p].score = undefined;
      run.steps[p].startedAt = undefined;
      run.steps[p].completedAt = undefined;
    }
    run.currentPhase = "explore";
    run.iteration += 1;
    await saveRunMeta(run);
  } else {
    // CONTINUE: advance to next phase
    if (run.pendingCheckpoint?.source === "synthesize") {
      // Was paused after synthesize → advance to advocate
      run.currentPhase = "advocate";
    } else {
      // Was paused after advocate → advance to validate
      run.currentPhase = "validate";
    }
    await saveRunMeta(run);
  }

  await launch(
    `maturation-checkpoint:${run.name}`,
    chatId,
    async () => {
      const onProgress: OnProgress = async (msg: string) => {
        await sendProgressMessage(chatId, threadId, msg);
      };
      return await runMaturationPipeline(run, onProgress, bctx);
    },
    { messageThreadId: threadId },
  );
}
```

Note: the `type MaturationPhase` import inside the function should be a regular import. Since it's a type, it can be imported at the top of the file alongside the existing type imports. Add to the existing imports at the top of the file:

```typescript
import type { MaturationPhase } from "../maturation/types.ts";
```

And remove the inline import from `resumeMaturationAfterCheckpoint`.

- [ ] **Step 2: Run tests**

Run: `bun test tests/unit/maturation-command.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add src/commands/maturation.ts
git commit -m "feat(maturation): wire checkpoint injection and callbacks into pipeline"
```

---

## Task 5: Wire Free-Text Interception in zz-messages.ts

**Files:**
- Modify: `src/commands/zz-messages.ts`

- [ ] **Step 1: Add checkpoint interception after the existing clarify check**

Read the file first. Find the existing maturation clarify interception block. After it (after its `return;`), add:

```typescript
    // Maturation checkpoint: intercept free-text response when "Autre" was clicked
    const { checkMaturationCheckpoint } = await import("../maturation/checkpoint.ts");
    const matCheckpoint = await checkMaturationCheckpoint(ctx.chat?.id ?? 0, threadId);
    if (matCheckpoint?.pendingCheckpoint?.awaitingFreeText) {
      const { handleCheckpointResponse } = await import("../maturation/checkpoint.ts");
      const cpResult = await handleCheckpointResponse(matCheckpoint, input);
      await bctx.sendResponseHtml(
        ctx,
        `\u2705 Decision enregistree. ${cpResult.action === "RE-EXPLORE" ? "Re-exploration en cours..." : "Pipeline continue..."}`,
      );
      const { resumeMaturationAfterCheckpoint } = await import("./maturation.ts");
      await resumeMaturationAfterCheckpoint(
        matCheckpoint,
        cpResult.action,
        ctx.chat?.id ?? 0,
        threadId,
        bctx,
      );
      return;
    }
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add src/commands/zz-messages.ts
git commit -m "feat(maturation): add checkpoint free-text interception in message handler"
```

---

## Task 6: Inject Decisions into Agent Prompts

**Files:**
- Modify: `src/maturation/agents.ts`

- [ ] **Step 1: Read agents.ts, then update buildPhasePrompt**

Add a new parameter to `PromptContext`:

```typescript
export interface PromptContext {
  rawInput: string;
  runDir: string;
  documents: Partial<Record<string, string>>;
  resolvedCheckpoints?: Array<{ source: string; summary: string; userChoice: string }>;
  globalDecisions?: Array<{ source: string; summary: string; userChoice: string }>;
}
```

In `buildPhasePrompt`, before the `## Output` section, add:

```typescript
  // Inject human decisions context
  if (ctx.resolvedCheckpoints && ctx.resolvedCheckpoints.length > 0) {
    parts.push("## Decisions humaines (ce run)\n");
    for (const cp of ctx.resolvedCheckpoints) {
      parts.push(`- [${cp.source}] "${cp.summary}" -> Choix: "${cp.userChoice}"`);
    }
    parts.push("");
  }

  if (ctx.globalDecisions && ctx.globalDecisions.length > 0) {
    parts.push("## Decisions historiques\n");
    for (const gd of ctx.globalDecisions) {
      parts.push(`- [${gd.source}] "${gd.summary}" -> "${gd.userChoice}"`);
    }
    parts.push("");
  }
```

- [ ] **Step 2: Update phases.ts to pass decisions to buildPhasePrompt**

Read `src/maturation/phases.ts`. In the `spawnAgent` helper (or equivalent function that calls `buildPhasePrompt`), add:

```typescript
  // Load decisions for context injection
  const { loadGlobalDecisions } = await import("./checkpoint.ts");
  const globalDecisions = await loadGlobalDecisions();

  const prompt = buildPhasePrompt(role, {
    rawInput: run.rawInput,
    runDir: getRunDir(run.id),
    documents: docs,
    resolvedCheckpoints: run.resolvedCheckpoints?.map((cp) => ({
      source: cp.source,
      summary: cp.summary,
      userChoice: cp.userChoice ?? "",
    })),
    globalDecisions: globalDecisions.slice(0, 5).map((gd) => ({
      source: gd.source,
      summary: gd.summary,
      userChoice: gd.userChoice,
    })),
  });
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/unit/maturation-agents.test.ts tests/unit/maturation-phases.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/maturation/agents.ts src/maturation/phases.ts
git commit -m "feat(maturation): inject human decisions into agent prompts"
```

---

## Task 7: Integration Test + Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: No new failures

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Run coding standards**

Run: `bun test tests/unit/coding-standards.test.ts`
Expected: PASS (may need to add checkpoint.ts to known modules, add createLogger)

- [ ] **Step 4: Update CLAUDE.md**

Add to source modules table:

```markdown
| `maturation/checkpoint.ts` | Interactive decision checkpoints: pipeline pause, advisor, keyboard, global decisions |
```

- [ ] **Step 5: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: add checkpoint module to CLAUDE.md"
git push
```

---

## Self-Review

**1. Spec coverage:**
- [x] CheckpointDecision + GlobalDecision types → Task 1
- [x] extractDecisionPoints (synthesize + advocate formats) → Task 2
- [x] parseAdvisorResponse with JSON parsing → Task 2
- [x] buildCheckpointKeyboard with options + Autre → Task 2
- [x] startCheckpoint with advisor call → Task 2
- [x] handleCheckpointResponse with global save → Task 2
- [x] checkMaturationCheckpoint by chatId/threadId → Task 2
- [x] loadGlobalDecisions with tag filter + cap 50 → Task 2
- [x] saveGlobalDecision with atomic write → Task 2
- [x] Barrel update → Task 3
- [x] Post-synthesize injection point → Task 4
- [x] Post-advocate injection (replaces auto loop-back) → Task 4
- [x] Callback handlers mat_cp_opt + mat_cp_other → Task 4
- [x] resumeMaturationAfterCheckpoint (CONTINUE + RE-EXPLORE) → Task 4
- [x] Free-text interception in zz-messages.ts → Task 5
- [x] Decision injection in buildPhasePrompt → Task 6
- [x] Edge case: advisor invalid JSON → fallback in startCheckpoint → Task 2
- [x] Edge case: no decisions found → returns null → Task 2
- [x] Edge case: cap at 50 global decisions → Task 2

**2. Placeholder scan:** No TBDs, TODOs, or vague steps. All code blocks complete.

**3. Type consistency:** `CheckpointDecision` used consistently across types.ts, checkpoint.ts, maturation.ts. `handleCheckpointResponse` returns `{ action: "CONTINUE" | "RE-EXPLORE" }` — used identically in Task 4 callbacks and Task 5 free-text handler. `PromptContext` extended with optional fields — backward compatible with existing callers.
