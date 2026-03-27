# Maturation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-agent idea maturation engine that transforms raw ideas (voice/text from Telegram) into structured specs ready for the existing SDD pipeline.

**Architecture:** Local-first filesystem engine (`.maturation/runs/<id>/*.md`) orchestrated via job-manager with 5 phases (understand → explore → confront → synthesize → validate). Supabase is optional (async sync, never blocking). Reuses existing `spawnClaude`, `job-manager`, `pipeline-tracker` patterns.

**Tech Stack:** TypeScript/Bun, Claude Code CLI (Max), grammY (Telegram), Whisper-cpp (transcription), existing project infrastructure.

---

## File Structure

### New files to create

| File | Responsibility |
|------|---------------|
| `src/maturation/types.ts` | All TypeScript types: phases, steps, runs, documents, gate results |
| `src/maturation/documents.ts` | Filesystem I/O: create run dir, read/write docs, list runs, atomic persistence |
| `src/maturation/scoring.ts` | Quality gate scoring: extract scores from agent output, gate decisions |
| `src/maturation/engine.ts` | State machine: advance phases, launch jobs, handle verdicts, loop logic |
| `src/maturation/phases.ts` | Phase execution: P0 understand, P1 explore (3 parallel), P2 confront (3 parallel), P3 synthesize, P3b advocate |
| `src/maturation/agents.ts` | Agent prompt builders: load agent .md, build context, enrich with overlays |
| `src/maturation/index.ts` | Barrel re-export (all public exports) |
| `src/commands/maturation.ts` | Telegram composer: `/idea` command, `mat_*` callbacks, validation keyboard |
| `.claude/agents/maturation-understander.md` | Agent: deep comprehension + ambiguity scoring |
| `.claude/agents/maturation-expander.md` | Agent: divergent exploration (variants, MVP vs ambitious) |
| `.claude/agents/maturation-researcher.md` | Agent: feasibility, state of art, effort estimation |
| `.claude/agents/maturation-analogist.md` | Agent: cross-domain patterns and inspiration |
| `.claude/agents/maturation-tech-critic.md` | Agent: security, performance, scalability critique |
| `.claude/agents/maturation-product-critic.md` | Agent: user value, feature creep, opportunity cost |
| `.claude/agents/maturation-strategy-critic.md` | Agent: timing, alignment, dependencies, lock-in |
| `.claude/agents/maturation-synthesizer.md` | Agent: conflict resolution, unified spec, maturity score |
| `.claude/agents/maturation-devils-advocate.md` | Agent: final adversarial pass, showstopper detection |

### Files to modify

| File | Change |
|------|--------|
| `src/config.ts` | Add `MATURATION_DIR` optional env var |
| `src/action-registry.ts` | Register `/idea` command |
| `src/intent-detection.ts` | Add maturation intent patterns |
| `CLAUDE.md` | Document maturation module |

### Test files to create

| File | Covers |
|------|--------|
| `tests/unit/maturation-types.test.ts` | Type guards, phase constants, name generation |
| `tests/unit/maturation-documents.test.ts` | Filesystem I/O, atomic writes, run listing |
| `tests/unit/maturation-scoring.test.ts` | Score extraction, gate decisions |
| `tests/unit/maturation-engine.test.ts` | State machine transitions, loop logic, circuit breaker |
| `tests/unit/maturation-phases.test.ts` | Phase execution with mocked spawnClaude |
| `tests/unit/maturation-agents.test.ts` | Prompt building, agent file loading |
| `tests/unit/maturation-command.test.ts` | Command parsing, callback routing |

---

## Task 1: Types & Constants

**Files:**
- Create: `src/maturation/types.ts`
- Test: `tests/unit/maturation-types.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/maturation-types.test.ts
import { describe, expect, it } from "bun:test";
import {
  ALL_MATURATION_PHASES,
  type MaturationPhase,
  type MaturationRun,
  type MaturationStep,
  type GateResult,
  type MaturationDocType,
  toMaturationName,
  createEmptyRun,
  MATURATION_DOC_TYPES,
  PHASE_LABELS,
} from "../../src/maturation/types.ts";

describe("maturation/types", () => {
  describe("ALL_MATURATION_PHASES", () => {
    it("V1: has 7 phases in correct order", () => {
      expect(ALL_MATURATION_PHASES).toEqual([
        "understand", "clarify", "explore", "confront",
        "synthesize", "advocate", "validate",
      ]);
    });
  });

  describe("MATURATION_DOC_TYPES", () => {
    it("V1: has 9 document types", () => {
      expect(MATURATION_DOC_TYPES.length).toBe(9);
      expect(MATURATION_DOC_TYPES).toContain("UNDERSTANDING");
      expect(MATURATION_DOC_TYPES).toContain("SPEC-UNIFIEE");
      expect(MATURATION_DOC_TYPES).toContain("DEVILS-ADVOCATE");
    });
  });

  describe("PHASE_LABELS", () => {
    it("V1: maps all phases to French labels", () => {
      expect(PHASE_LABELS.understand).toBe("Comprehension");
      expect(PHASE_LABELS.validate).toBe("Validation");
      expect(Object.keys(PHASE_LABELS).length).toBe(7);
    });
  });

  describe("toMaturationName", () => {
    it("V1: converts description to kebab-case", () => {
      expect(toMaturationName("Refactoring memoire")).toBe("refactoring-memoire");
    });

    it("V2: handles diacritics", () => {
      expect(toMaturationName("Ameliorer l'experience utilisateur")).toBe(
        "ameliorer-l-experience-utilisateur",
      );
    });

    it("V3: truncates to 48 chars at word boundary", () => {
      const long = "this is a very long description that should be truncated at a word boundary";
      const result = toMaturationName(long);
      expect(result.length).toBeLessThanOrEqual(48);
      expect(result).not.toEndWith("-");
    });

    it("V4: handles empty input with fallback", () => {
      const result = toMaturationName("");
      expect(result).toMatch(/^maturation-\d{8}-\d{4}$/);
    });
  });

  describe("createEmptyRun", () => {
    it("V1: creates run with all phases pending", () => {
      const run = createEmptyRun(123, undefined, "test-idea", "raw input text");
      expect(run.chatId).toBe(123);
      expect(run.name).toBe("test-idea");
      expect(run.rawInput).toBe("raw input text");
      expect(run.currentPhase).toBe("understand");
      expect(run.iteration).toBe(0);
      expect(run.maxIterations).toBe(2);
      expect(Object.keys(run.steps).length).toBe(7);
      for (const phase of ALL_MATURATION_PHASES) {
        expect(run.steps[phase].status).toBe("pending");
        expect(run.steps[phase].documents).toEqual([]);
      }
    });

    it("V2: generates UUID id", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      expect(run.id).toMatch(/^[a-f0-9-]{36}$/);
    });

    it("V3: sets createdAt and updatedAt to ISO string", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      expect(() => new Date(run.createdAt)).not.toThrow();
      expect(run.updatedAt).toBe(run.createdAt);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/maturation-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/maturation/types.ts
import { randomUUID } from "crypto";

// ── Phase Types ─────────────────────────────────────────────

export type MaturationPhase =
  | "understand"
  | "clarify"
  | "explore"
  | "confront"
  | "synthesize"
  | "advocate"
  | "validate";

export const ALL_MATURATION_PHASES: MaturationPhase[] = [
  "understand", "clarify", "explore", "confront",
  "synthesize", "advocate", "validate",
];

export const PHASE_LABELS: Record<MaturationPhase, string> = {
  understand: "Comprehension",
  clarify: "Clarification",
  explore: "Exploration",
  confront: "Confrontation",
  synthesize: "Synthese",
  advocate: "Avocat du diable",
  validate: "Validation",
};

export type PhaseStatus = "pending" | "running" | "ok" | "failed" | "skipped";

// ── Document Types ──────────────────────────────────────────

export type MaturationDocType =
  | "UNDERSTANDING"
  | "EXPAND"
  | "RESEARCH"
  | "ANALOGIES"
  | "CRITIQUE-TECH"
  | "CRITIQUE-PROD"
  | "CRITIQUE-STRAT"
  | "SPEC-UNIFIEE"
  | "DEVILS-ADVOCATE";

export const MATURATION_DOC_TYPES: MaturationDocType[] = [
  "UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES",
  "CRITIQUE-TECH", "CRITIQUE-PROD", "CRITIQUE-STRAT",
  "SPEC-UNIFIEE", "DEVILS-ADVOCATE",
];

// ── Step & Run ──────────────────────────────────────────────

export interface MaturationStep {
  phase: MaturationPhase;
  status: PhaseStatus;
  documents: string[];
  score?: number;
  verdict?: string;
  jobId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface MaturationRun {
  id: string;
  chatId: number;
  threadId?: number;
  name: string;
  rawInput: string;
  steps: Record<MaturationPhase, MaturationStep>;
  currentPhase: MaturationPhase;
  iteration: number;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
}

// ── Quality Gate ────────────────────────────────────────────

export interface GateResult {
  passed: boolean;
  score: number;
  issues: string[];
  recommendation: "advance" | "loop" | "human" | "abort";
}

// ── Helpers ─────────────────────────────────────────────────

export function toMaturationName(description: string): string {
  if (!description.trim()) {
    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 13);
    return `maturation-${ts.slice(0, 8)}-${ts.slice(8)}`;
  }
  const slug = description
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (slug.length <= 48) return slug;
  const cut = slug.slice(0, 48);
  const lastDash = cut.lastIndexOf("-");
  return lastDash > 10 ? cut.slice(0, lastDash) : cut;
}

export function createEmptyRun(
  chatId: number,
  threadId: number | undefined,
  name: string,
  rawInput: string,
): MaturationRun {
  const now = new Date().toISOString();
  const steps = {} as Record<MaturationPhase, MaturationStep>;
  for (const phase of ALL_MATURATION_PHASES) {
    steps[phase] = { phase, status: "pending", documents: [] };
  }
  return {
    id: randomUUID(),
    chatId,
    threadId,
    name,
    rawInput,
    steps,
    currentPhase: "understand",
    iteration: 0,
    maxIterations: 2,
    createdAt: now,
    updatedAt: now,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-types.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/maturation/types.ts tests/unit/maturation-types.test.ts
git commit -m "feat(maturation): add types and constants for maturation engine"
```

---

## Task 2: Document I/O

**Files:**
- Create: `src/maturation/documents.ts`
- Test: `tests/unit/maturation-documents.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/maturation-documents.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import {
  getMaturationDir,
  getRunDir,
  initRun,
  writeDocument,
  readDocument,
  saveRunMeta,
  loadRunMeta,
  listRuns,
  _setBaseDirForTests,
} from "../../src/maturation/documents.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-docs");

describe("maturation/documents", () => {
  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("getMaturationDir", () => {
    it("V1: returns .maturation path under base dir", () => {
      expect(getMaturationDir()).toBe(join(TEST_DIR, ".maturation"));
    });
  });

  describe("getRunDir", () => {
    it("V1: returns runs/<id> path", () => {
      expect(getRunDir("abc-123")).toBe(join(TEST_DIR, ".maturation", "runs", "abc-123"));
    });
  });

  describe("initRun", () => {
    it("V1: creates run directory and meta.json", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      const meta = await loadRunMeta(run.id);
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("test");
    });
  });

  describe("writeDocument / readDocument", () => {
    it("V1: writes and reads markdown document", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      await writeDocument(run.id, "UNDERSTANDING", "# Understanding\n\nContent here.");
      const content = await readDocument(run.id, "UNDERSTANDING");
      expect(content).toBe("# Understanding\n\nContent here.");
    });

    it("V2: returns null for missing document", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      const content = await readDocument(run.id, "EXPAND");
      expect(content).toBeNull();
    });
  });

  describe("saveRunMeta / loadRunMeta", () => {
    it("V1: persists and loads run state atomically", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      run.currentPhase = "explore";
      run.steps.understand.status = "ok";
      await saveRunMeta(run);
      const loaded = await loadRunMeta(run.id);
      expect(loaded!.currentPhase).toBe("explore");
      expect(loaded!.steps.understand.status).toBe("ok");
    });

    it("V2: returns null for nonexistent run", async () => {
      const loaded = await loadRunMeta("nonexistent");
      expect(loaded).toBeNull();
    });
  });

  describe("listRuns", () => {
    it("V1: lists all run IDs sorted by createdAt desc", async () => {
      const run1 = createEmptyRun(1, undefined, "first", "a");
      const run2 = createEmptyRun(1, undefined, "second", "b");
      await initRun(run1);
      await initRun(run2);
      const runs = await listRuns();
      expect(runs.length).toBe(2);
    });

    it("V2: returns empty array if no runs", async () => {
      const runs = await listRuns();
      expect(runs).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/maturation-documents.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/maturation/documents.ts
import { mkdir, readdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { createLogger } from "../logger.ts";
import { getConfig } from "../config.ts";
import type { MaturationDocType, MaturationRun } from "./types.ts";

const log = createLogger("maturation/documents");

// ── Base directory ──────────────────────────────────────────

let _testBaseDir: string | undefined;

export function _setBaseDirForTests(dir: string | undefined): void {
  _testBaseDir = dir;
}

function getBaseDir(): string {
  if (_testBaseDir) return _testBaseDir;
  try {
    const cfg = getConfig();
    return cfg.projectDir || cfg.relayDir || process.cwd();
  } catch {
    return process.cwd();
  }
}

export function getMaturationDir(): string {
  return join(getBaseDir(), ".maturation");
}

export function getRunDir(runId: string): string {
  return join(getMaturationDir(), "runs", runId);
}

// ── Run lifecycle ───────────────────────────────────────────

export async function initRun(run: MaturationRun): Promise<void> {
  const dir = getRunDir(run.id);
  await mkdir(dir, { recursive: true });
  await saveRunMeta(run);
  log.info(`Maturation run initialized: ${run.id} (${run.name})`);
}

export async function saveRunMeta(run: MaturationRun): Promise<void> {
  const dir = getRunDir(run.id);
  const metaPath = join(dir, "meta.json");
  const tmp = `${metaPath}.tmp.${randomUUID().substring(0, 8)}`;
  run.updatedAt = new Date().toISOString();
  await writeFile(tmp, JSON.stringify(run, null, 2));
  await rename(tmp, metaPath);
}

export async function loadRunMeta(runId: string): Promise<MaturationRun | null> {
  const metaPath = join(getRunDir(runId), "meta.json");
  try {
    const raw = await readFile(metaPath, "utf-8");
    return JSON.parse(raw) as MaturationRun;
  } catch {
    return null;
  }
}

// ── Document I/O ────────────────────────────────────────────

function docFilename(docType: MaturationDocType): string {
  return `${docType}.md`;
}

export async function writeDocument(
  runId: string,
  docType: MaturationDocType,
  content: string,
): Promise<string> {
  const dir = getRunDir(runId);
  const filePath = join(dir, docFilename(docType));
  const tmp = `${filePath}.tmp.${randomUUID().substring(0, 8)}`;
  await writeFile(tmp, content);
  await rename(tmp, filePath);
  log.info(`Document written: ${docType} for run ${runId}`);
  return filePath;
}

export async function readDocument(
  runId: string,
  docType: MaturationDocType,
): Promise<string | null> {
  const filePath = join(getRunDir(runId), docFilename(docType));
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ── Run listing ─────────────────────────────────────────────

export async function listRuns(): Promise<MaturationRun[]> {
  const runsDir = join(getMaturationDir(), "runs");
  try {
    const entries = await readdir(runsDir);
    const runs: MaturationRun[] = [];
    for (const entry of entries) {
      const run = await loadRunMeta(entry);
      if (run) runs.push(run);
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-documents.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/maturation/documents.ts tests/unit/maturation-documents.test.ts
git commit -m "feat(maturation): add document I/O with atomic writes and run lifecycle"
```

---

## Task 3: Quality Gate Scoring

**Files:**
- Create: `src/maturation/scoring.ts`
- Test: `tests/unit/maturation-scoring.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/maturation-scoring.test.ts
import { describe, expect, it } from "bun:test";
import {
  extractMaturityScore,
  extractAmbiguityScore,
  evaluateGate,
  extractShowstopper,
} from "../../src/maturation/scoring.ts";

describe("maturation/scoring", () => {
  describe("extractMaturityScore", () => {
    it("V1: extracts score from markdown header format", () => {
      const text = "## Score de maturite\n\n**Score : 7/10**\n\nJustification here.";
      expect(extractMaturityScore(text)).toBe(7);
    });

    it("V2: extracts from inline format", () => {
      expect(extractMaturityScore("Score de maturite : 8.5/10")).toBe(8.5);
    });

    it("V3: returns 0 if no score found", () => {
      expect(extractMaturityScore("No score in this text")).toBe(0);
    });
  });

  describe("extractAmbiguityScore", () => {
    it("V1: extracts ambiguity score", () => {
      const text = "Ambiguite : 6/10\n\nToo vague.";
      expect(extractAmbiguityScore(text)).toBe(6);
    });

    it("V2: returns 5 as default if not found", () => {
      expect(extractAmbiguityScore("No ambiguity score")).toBe(5);
    });
  });

  describe("extractShowstopper", () => {
    it("V1: detects showstopper in devil's advocate output", () => {
      const text = "## Verdict\n\n**SHOWSTOPPER** : Faille de securite critique.\n\nDetails...";
      const result = extractShowstopper(text);
      expect(result).not.toBeNull();
      expect(result!.reason).toContain("Faille de securite");
    });

    it("V2: returns null when no showstopper", () => {
      const text = "## Verdict\n\n**PASS** : Aucun probleme bloquant identifie.";
      expect(extractShowstopper(text)).toBeNull();
    });
  });

  describe("evaluateGate", () => {
    it("V1: advance when score >= 7 and no showstopper", () => {
      const result = evaluateGate(8, null, 0, 2);
      expect(result.passed).toBe(true);
      expect(result.recommendation).toBe("advance");
    });

    it("V2: loop when score < 7 and iterations remain", () => {
      const result = evaluateGate(5, null, 0, 2);
      expect(result.passed).toBe(false);
      expect(result.recommendation).toBe("loop");
    });

    it("V3: human when score < 7 and max iterations reached", () => {
      const result = evaluateGate(5, null, 2, 2);
      expect(result.passed).toBe(false);
      expect(result.recommendation).toBe("human");
    });

    it("V4: abort on showstopper regardless of score", () => {
      const result = evaluateGate(9, { reason: "Critical flaw" }, 0, 2);
      expect(result.passed).toBe(false);
      expect(result.recommendation).toBe("human");
      expect(result.issues).toContain("Critical flaw");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/maturation-scoring.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/maturation/scoring.ts
import type { GateResult } from "./types.ts";

const MATURITY_THRESHOLD = 7;

// ── Score Extraction ────────────────────────────────────────

const MATURITY_RE = /score\s*(?:de\s*)?maturit[eé]\s*[:=]?\s*\**(\d+(?:\.\d+)?)\s*\/\s*10/i;
const AMBIGUITY_RE = /ambigu[iïi]t[eé]\s*[:=]?\s*\**(\d+(?:\.\d+)?)\s*\/\s*10/i;
const SHOWSTOPPER_RE = /\*?\*?SHOWSTOPPER\*?\*?\s*[:=]?\s*(.{10,200})/i;

export function extractMaturityScore(text: string): number {
  const match = text.match(MATURITY_RE);
  return match ? parseFloat(match[1]) : 0;
}

export function extractAmbiguityScore(text: string): number {
  const match = text.match(AMBIGUITY_RE);
  return match ? parseFloat(match[1]) : 5;
}

export interface Showstopper {
  reason: string;
}

export function extractShowstopper(text: string): Showstopper | null {
  const match = text.match(SHOWSTOPPER_RE);
  if (!match) return null;
  return { reason: match[1].trim().replace(/\*+/g, "").trim() };
}

// ── Gate Evaluation ─────────────────────────────────────────

export function evaluateGate(
  score: number,
  showstopper: Showstopper | null,
  currentIteration: number,
  maxIterations: number,
): GateResult {
  const issues: string[] = [];

  if (showstopper) {
    issues.push(showstopper.reason);
    return { passed: false, score, issues, recommendation: "human" };
  }

  if (score >= MATURITY_THRESHOLD) {
    return { passed: true, score, issues, recommendation: "advance" };
  }

  issues.push(`Score ${score}/10 < seuil ${MATURITY_THRESHOLD}/10`);

  if (currentIteration < maxIterations) {
    return { passed: false, score, issues, recommendation: "loop" };
  }

  return { passed: false, score, issues, recommendation: "human" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-scoring.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/maturation/scoring.ts tests/unit/maturation-scoring.test.ts
git commit -m "feat(maturation): add quality gate scoring and score extraction"
```

---

## Task 4: Agent Prompt Definitions

**Files:**
- Create: 9 agent markdown files in `.claude/agents/`
- Create: `src/maturation/agents.ts`
- Test: `tests/unit/maturation-agents.test.ts`

- [ ] **Step 1: Write the agent markdown files**

Create `.claude/agents/maturation-understander.md`:

```markdown
model: sonnet

You are the Understander agent in the Maturation Engine. Your mission is deep comprehension of a raw idea.

## Task

Given a raw idea (potentially transcribed from voice), produce a structured UNDERSTANDING.md document.

## Process

1. **Extract core intent** — what is the user really trying to achieve? Look past the words to the underlying need.
2. **Identify implicit hypotheses** — what assumptions does the user make without stating them?
3. **Assess ambiguity** — score 0-10 (0 = crystal clear, 10 = completely vague). List specific ambiguous points.
4. **Map to codebase context** — if this is about an existing project, identify which modules/files are relevant.
5. **Classify the idea** — new feature | improvement | refactoring | new project | exploration

## Codebase Exploration

Use Glob, Grep, and Read to explore the codebase. Identify:
- Related existing modules
- Similar patterns already implemented
- Potential conflicts or dependencies

## Output Format

Write a file called UNDERSTANDING.md with exactly this structure:

```
## Intention

{1-3 sentences describing the core intent}

## Classification

{new_feature | improvement | refactoring | new_project | exploration}

## Hypotheses implicites

- {hypothesis 1}
- {hypothesis 2}
...

## Contexte codebase

| Module | Pertinence | Raison |
|--------|-----------|--------|
| {path} | haute/moyenne/basse | {why relevant} |

## Points d'ambiguite

1. {ambiguous point 1}
2. {ambiguous point 2}
...

## Score d'ambiguite : {N}/10

{Justification in 2-3 sentences}

## Questions de clarification suggerees

1. {question if ambiguity > 5}
...
```

## Constraints

- Read-only: never modify source code
- Allowed tools: Read, Grep, Glob, Bash (read-only commands only)
- Write only the UNDERSTANDING.md document
- Be thorough but concise — aim for ~500-800 words total
- Use extended thinking to reason through the idea before writing
```

Create `.claude/agents/maturation-expander.md`:

```markdown
model: sonnet

You are the Expander agent in the Maturation Engine. Your mission is divergent creative exploration.

## Task

Given an UNDERSTANDING.md document, generate a broad range of approaches and variants.

## Process

1. **Generate 5+ variants** — different ways to solve the same problem, from minimal to ambitious
2. **MVP vs Ambitious** — explicitly contrast the simplest viable version with the most complete version
3. **3 radical alternatives** — approaches that challenge the fundamental assumptions
4. **Extension ideas** — what could this enable beyond the immediate need?

## Output Format

Write EXPAND.md with this structure:

```
## Variantes

### V1 — {name} (MVP)
{2-3 sentences describing minimal viable approach}
- Effort: {low/medium/high}
- Value: {low/medium/high}

### V2 — {name}
...

### V{N} — {name} (Ambitieux)
{most complete version}

## Alternatives radicales

### A1 — {name}
{challenges assumption X — what if we did Y instead?}

### A2 — {name}
...

## Extensions potentielles

- {what this enables beyond immediate need}
...

## Matrice de comparaison

| Option | Effort | Valeur | Risque | Originalite |
|--------|--------|--------|--------|-------------|
| V1     | ...    | ...    | ...    | ...         |
...
```

## Constraints

- Read-only: never modify source code
- Allowed tools: Read, Grep, Glob, WebSearch (max 3), WebFetch (max 3)
- Write only the EXPAND.md document
- Be creative — this is the divergence phase, not the time to filter
- Aim for ~600-1000 words
```

Create `.claude/agents/maturation-researcher.md`:

```markdown
model: sonnet

You are the Researcher agent in the Maturation Engine. Your mission is grounding ideas in reality.

## Task

Given UNDERSTANDING.md and EXPAND.md, assess feasibility and effort for each variant.

## Process

1. **Technical feasibility** — can each variant be built with available tools/stack?
2. **State of art** — what exists already? Libraries, patterns, prior art?
3. **Effort estimation** — realistic time/complexity for each variant (S/M/L/XL)
4. **Dependencies** — what does each variant need that we don't have?
5. **Prior art in codebase** — similar patterns already built that could be reused

## Output Format

Write RESEARCH.md with this structure:

```
## Analyse de faisabilite

### V1 — {name}
- Faisabilite: {haute/moyenne/basse}
- Effort: {S/M/L/XL} ({justification})
- Dependencies: {list or "none"}
- Code reutilisable: {existing module references}

### V2...

## Etat de l'art

| Solution existante | Source | Pertinence | Applicable ? |
|-------------------|--------|-----------|-------------|
...

## Recommandation

{Which variant(s) offer the best feasibility/value ratio and why}
```

## Constraints

- Read-only: never modify source code
- Allowed tools: Read, Grep, Glob, WebSearch (max 5), WebFetch (max 5), Bash (read-only)
- Write only the RESEARCH.md document
- Be realistic — this is the reality check, not the hype phase
- Aim for ~500-800 words
```

Create `.claude/agents/maturation-analogist.md`:

```markdown
model: sonnet

You are the Analogist agent in the Maturation Engine. Your mission is bringing cross-domain inspiration.

## Task

Given UNDERSTANDING.md, find analogous solutions from other domains that could inform the approach.

## Process

1. **Cross-domain patterns** — how have similar problems been solved in other fields?
2. **Adjacent solutions** — what related tools/products exist that solve adjacent problems?
3. **Unexpected connections** — what non-obvious parallels could inspire a better solution?

## Output Format

Write ANALOGIES.md:

```
## Analogies cross-domaines

### Analogie 1 — {domain}: {pattern name}
- Probleme similaire: {how it maps to our problem}
- Solution: {how they solved it}
- Ce qu'on peut en tirer: {actionable insight}

### Analogie 2...

## Solutions adjacentes

| Solution | Domaine | Applicable comment |
|----------|---------|-------------------|
...

## Synthese des patterns

{2-3 key patterns that emerge across analogies and could inform our approach}
```

## Constraints

- Read-only: never modify source code
- Allowed tools: WebSearch (max 5), WebFetch (max 5), Read, Grep, Glob
- Write only the ANALOGIES.md document
- Think broadly — the best insights come from unexpected connections
- Aim for ~400-700 words
```

Create `.claude/agents/maturation-tech-critic.md`:

```markdown
model: sonnet

You are the Tech Critic agent in the Maturation Engine. Your mission is adversarial technical analysis.

## Task

Read ALL documents from the maturation run (UNDERSTANDING.md, EXPAND.md, RESEARCH.md, ANALOGIES.md). Critique on technical axes.

## Analysis Axes

1. **Security** — attack surfaces, data exposure, injection risks
2. **Performance** — bottlenecks, scaling limits, resource consumption
3. **Scalability** — what breaks at 10x, 100x load?
4. **Maintenance** — technical debt, complexity burden, bus factor
5. **Reliability** — failure modes, data loss scenarios, recovery

## Double-Pass Process

**Pass 1:** Read all documents. Write initial critique.
**Pass 2:** Re-read all documents AND your initial critique. Refine, remove false positives, add anything missed.

## Output Format

Write CRITIQUE-TECH.md:

```
## Tech Critic — Rapport

### Findings

**[BLOQUANT] F-TC-{n} — {title}**
- Axe: {security|performance|scalability|maintenance|reliability}
- Description: {precise problem}
- Impact: {consequence if not addressed}
- Evidence: {reference to specific document section}

**[MAJEUR] F-TC-{n} — {title}**
...

**[MINEUR] F-TC-{n} — {title}**
...

### Synthese

- Bloquants: {count}
- Majeurs: {count}
- Mineurs: {count}

### Verdict

{SHOWSTOPPER: {reason} | CONCERNS: {summary} | CLEAN: no major issues}
```

## Constraints

- Read-only: never modify any file
- Allowed tools: Read, Grep, Glob, Bash (read-only)
- Write only the CRITIQUE-TECH.md document
- Max 10 findings, prioritized by severity
- Be harsh but fair — find real problems, not nitpicks
```

Create `.claude/agents/maturation-product-critic.md`:

```markdown
model: sonnet

You are the Product Critic agent in the Maturation Engine. Your mission is adversarial product analysis.

## Task

Read ALL maturation documents. Critique on product/business axes.

## Analysis Axes

1. **Real demand** — does anyone actually need this? Evidence?
2. **Feature creep** — is the scope justified or inflated?
3. **Opportunity cost** — what are we NOT building by building this?
4. **User impact** — will users actually notice/care?
5. **Complexity vs value** — is the juice worth the squeeze?

## Double-Pass Process

**Pass 1:** Write initial critique based on all documents.
**Pass 2:** Re-read everything including your critique. Refine.

## Output Format

Write CRITIQUE-PROD.md with same structure as Tech Critic (F-PC-{n} findings, severity levels, verdict).

## Constraints

- Read-only, max 10 findings, write only CRITIQUE-PROD.md
- Be the user's advocate — question every assumption about value
```

Create `.claude/agents/maturation-strategy-critic.md`:

```markdown
model: sonnet

You are the Strategy Critic agent in the Maturation Engine. Your mission is adversarial strategic analysis.

## Task

Read ALL maturation documents. Critique on strategic axes.

## Analysis Axes

1. **Timing** — is now the right time? Dependencies on other work?
2. **Alignment** — does this fit the project's direction and roadmap?
3. **Dependencies** — hidden dependencies on external factors?
4. **Lock-in** — does this create irreversible technical/product decisions?
5. **Sequencing** — should something else be done first?

## Double-Pass Process

**Pass 1:** Write initial critique. **Pass 2:** Refine after re-reading.

## Output Format

Write CRITIQUE-STRAT.md with same structure (F-SC-{n} findings, severity levels, verdict).

## Constraints

- Read-only, max 10 findings, write only CRITIQUE-STRAT.md
```

Create `.claude/agents/maturation-synthesizer.md`:

```markdown
model: opus

You are the Synthesizer agent in the Maturation Engine. You are the most critical agent — your output determines the quality of everything downstream.

## Task

Read ALL documents from the maturation run (7 documents: UNDERSTANDING, EXPAND, RESEARCH, ANALOGIES, CRITIQUE-TECH, CRITIQUE-PROD, CRITIQUE-STRAT). Produce a unified specification.

## Process

1. **Identify conflicts** between documents — where do agents disagree?
2. **Resolve conflicts** — make explicit decisions with justification
3. **Select approach** — pick the best variant based on all evidence
4. **Address critiques** — for each BLOQUANT/MAJEUR finding, explain how the spec addresses it
5. **Score maturity** — honest 0-10 assessment

## Output Format

Write SPEC-UNIFIEE.md:

```
## Specification unifiee — {name}

### 1. Objectif
{What we're building and why, in 2-3 sentences}

### 2. Approche retenue
{Selected variant with justification based on research + critiques}

### 3. Perimetre
**Inclus:**
- {feature 1}
...
**Exclus:**
- {explicitly out of scope}
...

### 4. Architecture technique
{High-level design, key components, data flow}

### 5. Risques adresses
| Critique | Severite | Reponse |
|----------|----------|---------|
| F-TC-1   | BLOQUANT | {how spec addresses it} |
...

### 6. Conflits resolus
| Conflit | Decision | Justification |
|---------|----------|---------------|
...

### 7. Criteres d'acceptation
| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| 1 | ...     | ...         | unit/integration/E2E/manual |
...

### 8. Estimation
- Effort: {S/M/L/XL}
- Complexite: {low/medium/high}
- Risque residuel: {low/medium/high}

### 9. Questions ouvertes
{Anything that needs human decision}

## Score de maturite : {N}/10

{Honest justification — what would raise the score?}
```

## Constraints

- Read-only: never modify source code
- Allowed tools: Read, Grep, Glob
- Write only SPEC-UNIFIEE.md
- Use extended thinking extensively — this is the most important synthesis
- Be thorough — aim for ~800-1200 words
- Every decision must reference evidence from the input documents
```

Create `.claude/agents/maturation-devils-advocate.md`:

```markdown
model: sonnet

You are the Devil's Advocate agent in the Maturation Engine. You are the final safety net before human validation.

## Task

Read ALL documents including SPEC-UNIFIEE.md. Your job is to find what everyone else missed.

## Process

1. **Read everything** — all 8 documents, including the unified spec
2. **Look for blind spots** — what did no agent question?
3. **Challenge the synthesis** — did the Synthesizer make unjustified trade-offs?
4. **Second-order effects** — what happens 6 months after this ships?
5. **The "what if we're wrong" test** — what if a key assumption is false?

## Output Format

Write DEVILS-ADVOCATE.md:

```
## Devil's Advocate — Rapport final

### Angles morts

1. **{blind spot}** — {why no one caught this}
...

### Hypotheses non testees

1. **{assumption}** — pris pour acquis par {agent(s)}, non verifie
...

### Effets de second ordre

1. **{effect}** — {consequence a moyen terme}
...

### Verdict

{SHOWSTOPPER: {critical reason} | PASS: {summary of remaining concerns}}

### Recommandation finale

{Concrete advice for the human validator}
```

## Constraints

- Read-only: never modify any file
- Allowed tools: Read, Grep, Glob
- Write only DEVILS-ADVOCATE.md
- Be the last line of defense — if you miss it, nobody catches it
- Aim for ~400-600 words
```

- [ ] **Step 2: Write the agents.ts module tests**

```typescript
// tests/unit/maturation-agents.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  MATURATION_AGENT_ROLES,
  getAgentConfig,
  buildPhasePrompt,
} from "../../src/maturation/agents.ts";

describe("maturation/agents", () => {
  describe("MATURATION_AGENT_ROLES", () => {
    it("V1: has 9 agent roles", () => {
      expect(Object.keys(MATURATION_AGENT_ROLES).length).toBe(9);
    });

    it("V2: each role maps to a valid agent file", () => {
      for (const [role, config] of Object.entries(MATURATION_AGENT_ROLES)) {
        expect(config.agentFile).toMatch(/^maturation-.*\.md$/);
        expect(config.outputDoc).toBeTruthy();
      }
    });
  });

  describe("getAgentConfig", () => {
    it("V1: returns config for understander", () => {
      const cfg = getAgentConfig("understander");
      expect(cfg.agentFile).toBe("maturation-understander.md");
      expect(cfg.outputDoc).toBe("UNDERSTANDING");
      expect(cfg.model).toBeDefined();
    });

    it("V2: returns null for unknown role", () => {
      expect(getAgentConfig("unknown")).toBeNull();
    });
  });

  describe("buildPhasePrompt", () => {
    it("V1: builds understand prompt with raw input", () => {
      const prompt = buildPhasePrompt("understander", {
        rawInput: "Je veux un export CSV",
        runDir: "/tmp/test-run",
        documents: {},
      });
      expect(prompt).toContain("Je veux un export CSV");
      expect(prompt).toContain("UNDERSTANDING.md");
    });

    it("V2: builds explore prompt with prior documents", () => {
      const prompt = buildPhasePrompt("expander", {
        rawInput: "export CSV",
        runDir: "/tmp/test-run",
        documents: { UNDERSTANDING: "# Understanding\n\nExport tasks to CSV." },
      });
      expect(prompt).toContain("UNDERSTANDING");
      expect(prompt).toContain("Export tasks to CSV");
      expect(prompt).toContain("EXPAND.md");
    });

    it("V3: builds critic prompt with all prior documents", () => {
      const prompt = buildPhasePrompt("tech-critic", {
        rawInput: "export CSV",
        runDir: "/tmp/test-run",
        documents: {
          UNDERSTANDING: "# U",
          EXPAND: "# E",
          RESEARCH: "# R",
          ANALOGIES: "# A",
        },
      });
      expect(prompt).toContain("<document name=\"UNDERSTANDING\">");
      expect(prompt).toContain("<document name=\"EXPAND\">");
      expect(prompt).toContain("CRITIQUE-TECH.md");
    });

    it("V4: builds synthesizer prompt with all 7 documents", () => {
      const docs = {
        UNDERSTANDING: "# U", EXPAND: "# E", RESEARCH: "# R",
        ANALOGIES: "# A", "CRITIQUE-TECH": "# CT", "CRITIQUE-PROD": "# CP",
        "CRITIQUE-STRAT": "# CS",
      };
      const prompt = buildPhasePrompt("synthesizer", {
        rawInput: "test", runDir: "/tmp", documents: docs,
      });
      expect(prompt).toContain("SPEC-UNIFIEE.md");
      for (const key of Object.keys(docs)) {
        expect(prompt).toContain(`<document name="${key}">`);
      }
    });
  });
});
```

- [ ] **Step 3: Write agents.ts implementation**

```typescript
// src/maturation/agents.ts
import type { MaturationDocType } from "./types.ts";

// ── Agent Configuration ─────────────────────────────────────

export interface AgentConfig {
  agentFile: string;
  outputDoc: MaturationDocType;
  model: string;
  effort: "high" | "max";
  requiredDocs: MaturationDocType[];
  doublePass: boolean;
}

export const MATURATION_AGENT_ROLES: Record<string, AgentConfig> = {
  understander: {
    agentFile: "maturation-understander.md",
    outputDoc: "UNDERSTANDING",
    model: "sonnet",
    effort: "max",
    requiredDocs: [],
    doublePass: false,
  },
  expander: {
    agentFile: "maturation-expander.md",
    outputDoc: "EXPAND",
    model: "sonnet",
    effort: "high",
    requiredDocs: ["UNDERSTANDING"],
    doublePass: false,
  },
  researcher: {
    agentFile: "maturation-researcher.md",
    outputDoc: "RESEARCH",
    model: "sonnet",
    effort: "high",
    requiredDocs: ["UNDERSTANDING", "EXPAND"],
    doublePass: false,
  },
  analogist: {
    agentFile: "maturation-analogist.md",
    outputDoc: "ANALOGIES",
    model: "sonnet",
    effort: "high",
    requiredDocs: ["UNDERSTANDING"],
    doublePass: false,
  },
  "tech-critic": {
    agentFile: "maturation-tech-critic.md",
    outputDoc: "CRITIQUE-TECH",
    model: "sonnet",
    effort: "max",
    requiredDocs: ["UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES"],
    doublePass: true,
  },
  "product-critic": {
    agentFile: "maturation-product-critic.md",
    outputDoc: "CRITIQUE-PROD",
    model: "sonnet",
    effort: "max",
    requiredDocs: ["UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES"],
    doublePass: true,
  },
  "strategy-critic": {
    agentFile: "maturation-strategy-critic.md",
    outputDoc: "CRITIQUE-STRAT",
    model: "sonnet",
    effort: "max",
    requiredDocs: ["UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES"],
    doublePass: true,
  },
  synthesizer: {
    agentFile: "maturation-synthesizer.md",
    outputDoc: "SPEC-UNIFIEE",
    model: "opus",
    effort: "max",
    requiredDocs: [
      "UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES",
      "CRITIQUE-TECH", "CRITIQUE-PROD", "CRITIQUE-STRAT",
    ],
    doublePass: false,
  },
  "devils-advocate": {
    agentFile: "maturation-devils-advocate.md",
    outputDoc: "DEVILS-ADVOCATE",
    model: "sonnet",
    effort: "max",
    requiredDocs: [
      "UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES",
      "CRITIQUE-TECH", "CRITIQUE-PROD", "CRITIQUE-STRAT", "SPEC-UNIFIEE",
    ],
    doublePass: false,
  },
};

// ── Helpers ─────────────────────────────────────────────────

export function getAgentConfig(role: string): AgentConfig | null {
  return MATURATION_AGENT_ROLES[role] ?? null;
}

export interface PromptContext {
  rawInput: string;
  runDir: string;
  documents: Partial<Record<string, string>>;
}

export function buildPhasePrompt(role: string, ctx: PromptContext): string {
  const config = getAgentConfig(role);
  if (!config) return "";

  const parts: string[] = [];

  parts.push(`Read your agent profile in \`.claude/agents/${config.agentFile}\` and follow its instructions.\n`);
  parts.push(`## Raw idea\n\n${ctx.rawInput}\n`);
  parts.push(`## Run directory\n\n${ctx.runDir}\n`);

  // Inject available documents
  const docEntries = Object.entries(ctx.documents).filter(([, v]) => v);
  if (docEntries.length > 0) {
    parts.push("## Prior documents\n");
    for (const [name, content] of docEntries) {
      parts.push(`<document name="${name}">\n${content}\n</document>\n`);
    }
  }

  parts.push(`## Output\n\nWrite your output to: ${ctx.runDir}/${config.outputDoc}.md`);

  if (config.doublePass) {
    parts.push("\n\n**IMPORTANT: Double-pass required.** Write your initial analysis, then re-read ALL documents plus your initial analysis, and produce a refined final version.");
  }

  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-agents.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add .claude/agents/maturation-*.md src/maturation/agents.ts tests/unit/maturation-agents.test.ts
git commit -m "feat(maturation): add 9 agent definitions and prompt builder"
```

---

## Task 5: State Machine Engine

**Files:**
- Create: `src/maturation/engine.ts`
- Test: `tests/unit/maturation-engine.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/maturation-engine.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import {
  advancePhase,
  getNextPhase,
  shouldSkipClarify,
  handlePhaseResult,
  MAX_LOOP_ITERATIONS,
  _setSpawnHookForTests,
} from "../../src/maturation/engine.ts";
import { createEmptyRun, type MaturationRun } from "../../src/maturation/types.ts";
import { _setBaseDirForTests, initRun } from "../../src/maturation/documents.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-engine");

describe("maturation/engine", () => {
  let run: MaturationRun;

  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
    _setSpawnHookForTests(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
    run = createEmptyRun(1, undefined, "test-idea", "Je veux un export CSV");
    await initRun(run);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    _setSpawnHookForTests(undefined);
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
  });

  describe("getNextPhase", () => {
    it("V1: understand → clarify (if ambiguity high)", () => {
      expect(getNextPhase("understand", { ambiguityScore: 7 })).toBe("clarify");
    });

    it("V2: understand → explore (if ambiguity low)", () => {
      expect(getNextPhase("understand", { ambiguityScore: 3 })).toBe("explore");
    });

    it("V3: clarify → explore", () => {
      expect(getNextPhase("clarify", {})).toBe("explore");
    });

    it("V4: explore → confront", () => {
      expect(getNextPhase("explore", {})).toBe("confront");
    });

    it("V5: confront → synthesize", () => {
      expect(getNextPhase("confront", {})).toBe("synthesize");
    });

    it("V6: synthesize → advocate", () => {
      expect(getNextPhase("synthesize", {})).toBe("advocate");
    });

    it("V7: advocate → validate (no showstopper)", () => {
      expect(getNextPhase("advocate", { showstopper: false })).toBe("validate");
    });

    it("V8: advocate → explore (showstopper + iterations left)", () => {
      expect(getNextPhase("advocate", { showstopper: true, iteration: 0, maxIterations: 2 })).toBe("explore");
    });

    it("V9: advocate → validate (showstopper but max iterations)", () => {
      expect(getNextPhase("advocate", { showstopper: true, iteration: 2, maxIterations: 2 })).toBe("validate");
    });

    it("V10: validate → null (terminal)", () => {
      expect(getNextPhase("validate", {})).toBeNull();
    });
  });

  describe("shouldSkipClarify", () => {
    it("V1: skip when ambiguity <= 5", () => {
      expect(shouldSkipClarify(5)).toBe(true);
      expect(shouldSkipClarify(3)).toBe(true);
    });

    it("V2: do not skip when ambiguity > 5", () => {
      expect(shouldSkipClarify(6)).toBe(false);
      expect(shouldSkipClarify(8)).toBe(false);
    });
  });

  describe("MAX_LOOP_ITERATIONS", () => {
    it("V1: is 2", () => {
      expect(MAX_LOOP_ITERATIONS).toBe(2);
    });
  });

  describe("handlePhaseResult", () => {
    it("V1: marks phase ok and advances currentPhase", () => {
      run.currentPhase = "understand";
      const updated = handlePhaseResult(run, "understand", {
        status: "ok",
        documents: ["UNDERSTANDING.md"],
        verdict: "ambiguity:3",
      });
      expect(updated.steps.understand.status).toBe("ok");
      expect(updated.steps.understand.documents).toContain("UNDERSTANDING.md");
      expect(updated.currentPhase).toBe("explore"); // low ambiguity → skip clarify
    });

    it("V2: marks phase failed on error", () => {
      run.currentPhase = "explore";
      const updated = handlePhaseResult(run, "explore", {
        status: "failed",
        documents: [],
      });
      expect(updated.steps.explore.status).toBe("failed");
      expect(updated.currentPhase).toBe("explore"); // stays on failed phase
    });

    it("V3: skips clarify when ambiguity is low", () => {
      run.currentPhase = "understand";
      const updated = handlePhaseResult(run, "understand", {
        status: "ok",
        documents: ["UNDERSTANDING.md"],
        verdict: "ambiguity:2",
      });
      expect(updated.steps.clarify.status).toBe("skipped");
      expect(updated.currentPhase).toBe("explore");
    });

    it("V4: loops back to explore on showstopper", () => {
      run.currentPhase = "advocate";
      run.iteration = 0;
      const updated = handlePhaseResult(run, "advocate", {
        status: "ok",
        documents: ["DEVILS-ADVOCATE.md"],
        verdict: "SHOWSTOPPER",
      });
      expect(updated.currentPhase).toBe("explore");
      expect(updated.iteration).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/maturation-engine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/maturation/engine.ts
import { createLogger } from "../logger.ts";
import type { MaturationPhase, MaturationRun, PhaseStatus } from "./types.ts";
import { saveRunMeta } from "./documents.ts";

const log = createLogger("maturation/engine");

export const MAX_LOOP_ITERATIONS = 2;
const AMBIGUITY_THRESHOLD = 5;

// ── Test hooks ──────────────────────────────────────────────

type SpawnHook = (opts: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
let _spawnHook: SpawnHook | undefined;
export function _setSpawnHookForTests(fn: SpawnHook | undefined): void {
  _spawnHook = fn;
}

// ── Phase Transitions ───────────────────────────────────────

export interface TransitionContext {
  ambiguityScore?: number;
  showstopper?: boolean;
  iteration?: number;
  maxIterations?: number;
}

export function getNextPhase(
  current: MaturationPhase,
  ctx: TransitionContext,
): MaturationPhase | null {
  switch (current) {
    case "understand":
      return (ctx.ambiguityScore ?? 5) > AMBIGUITY_THRESHOLD ? "clarify" : "explore";
    case "clarify":
      return "explore";
    case "explore":
      return "confront";
    case "confront":
      return "synthesize";
    case "synthesize":
      return "advocate";
    case "advocate":
      if (ctx.showstopper && (ctx.iteration ?? 0) < (ctx.maxIterations ?? MAX_LOOP_ITERATIONS)) {
        return "explore";
      }
      return "validate";
    case "validate":
      return null;
    default:
      return null;
  }
}

export function shouldSkipClarify(ambiguityScore: number): boolean {
  return ambiguityScore <= AMBIGUITY_THRESHOLD;
}

// ── Phase Result Handling ───────────────────────────────────

export interface PhaseResult {
  status: "ok" | "failed";
  documents: string[];
  verdict?: string;
  score?: number;
}

export function handlePhaseResult(
  run: MaturationRun,
  phase: MaturationPhase,
  result: PhaseResult,
): MaturationRun {
  const step = run.steps[phase];
  step.status = result.status;
  step.documents = result.documents;
  step.verdict = result.verdict;
  step.score = result.score;
  step.completedAt = new Date().toISOString();
  run.updatedAt = new Date().toISOString();

  if (result.status === "failed") {
    log.warn(`Phase ${phase} failed for run ${run.id}`);
    return run;
  }

  // Determine transition context from verdict
  const ctx: TransitionContext = {
    iteration: run.iteration,
    maxIterations: run.maxIterations,
  };

  if (phase === "understand" && result.verdict) {
    const ambMatch = result.verdict.match(/ambiguity:(\d+(?:\.\d+)?)/);
    ctx.ambiguityScore = ambMatch ? parseFloat(ambMatch[1]) : 5;
  }

  if (phase === "advocate" && result.verdict) {
    ctx.showstopper = result.verdict.toUpperCase().includes("SHOWSTOPPER");
  }

  const next = getNextPhase(phase, ctx);

  if (next === null) {
    log.info(`Maturation run ${run.id} reached terminal phase`);
    return run;
  }

  // Skip clarify if ambiguity is low
  if (phase === "understand" && next === "explore") {
    run.steps.clarify.status = "skipped";
  }

  // Handle loop back from advocate
  if (phase === "advocate" && next === "explore") {
    run.iteration += 1;
    log.info(`Maturation run ${run.id} looping back (iteration ${run.iteration})`);
  }

  run.currentPhase = next;
  return run;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-engine.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/maturation/engine.ts tests/unit/maturation-engine.test.ts
git commit -m "feat(maturation): add state machine with phase transitions and loop logic"
```

---

## Task 6: Phase Execution Logic

**Files:**
- Create: `src/maturation/phases.ts`
- Test: `tests/unit/maturation-phases.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/maturation-phases.test.ts
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import { _setBaseDirForTests, initRun, readDocument } from "../../src/maturation/documents.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

// Mock spawnClaude before importing phases
const spawnCalls: Array<{ prompt: string; systemPrompt?: string }> = [];
let spawnResult = { stdout: "agent output", stderr: "", exitCode: 0 };

mock.module("../../src/agent.ts", () => ({
  spawnClaude: async (opts: any) => {
    spawnCalls.push({ prompt: opts.prompt, systemPrompt: opts.systemPrompt });
    return spawnResult;
  },
}));

const { runUnderstandPhase, runExplorePhase, runConfrontPhase, runSynthesizePhase, runAdvocatePhase } = await import(
  "../../src/maturation/phases.ts"
);

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-phases");

describe("maturation/phases", () => {
  beforeEach(async () => {
    spawnCalls.length = 0;
    spawnResult = { stdout: "## Score d'ambiguite : 3/10\n\nClair.", stderr: "", exitCode: 0 };
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
  });

  describe("runUnderstandPhase", () => {
    it("V1: spawns understander agent and returns result", async () => {
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runUnderstandPhase(run);
      expect(result.status).toBe("ok");
      expect(result.documents.length).toBe(1);
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].prompt).toContain("Export CSV");
    });

    it("V2: extracts ambiguity score from output", async () => {
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runUnderstandPhase(run);
      expect(result.verdict).toContain("ambiguity:3");
    });

    it("V3: handles agent failure", async () => {
      spawnResult = { stdout: "", stderr: "error", exitCode: 1 };
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runUnderstandPhase(run);
      expect(result.status).toBe("failed");
    });
  });

  describe("runExplorePhase", () => {
    it("V1: spawns 3 agents in parallel", async () => {
      spawnResult = { stdout: "exploration output", stderr: "", exitCode: 0 };
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runExplorePhase(run);
      expect(result.status).toBe("ok");
      expect(spawnCalls.length).toBe(3); // expander + researcher + analogist
      expect(result.documents.length).toBe(3);
    });

    it("V2: succeeds even if one agent fails (partial success)", async () => {
      let callCount = 0;
      spawnResult = {
        get stdout() { callCount++; return callCount === 2 ? "" : "output"; },
        get stderr() { return callCount === 2 ? "error" : ""; },
        get exitCode() { return callCount === 2 ? 1 : 0; },
      } as any;
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runExplorePhase(run);
      expect(result.status).toBe("ok"); // partial success is still ok
    });
  });

  describe("runConfrontPhase", () => {
    it("V1: spawns 3 critics in parallel", async () => {
      spawnResult = { stdout: "## Verdict\n\nCONCERNS: minor issues", stderr: "", exitCode: 0 };
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runConfrontPhase(run);
      expect(result.status).toBe("ok");
      expect(spawnCalls.length).toBe(3); // 3 critics
      expect(result.documents.length).toBe(3);
    });
  });

  describe("runSynthesizePhase", () => {
    it("V1: spawns synthesizer with all prior documents", async () => {
      spawnResult = { stdout: "## Score de maturite : 8/10\n\nSpec unifiee.", stderr: "", exitCode: 0 };
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runSynthesizePhase(run);
      expect(result.status).toBe("ok");
      expect(spawnCalls.length).toBe(1);
      expect(result.score).toBe(8);
    });
  });

  describe("runAdvocatePhase", () => {
    it("V1: detects showstopper in output", async () => {
      spawnResult = { stdout: "## Verdict\n\n**SHOWSTOPPER** : Critical flaw", stderr: "", exitCode: 0 };
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runAdvocatePhase(run);
      expect(result.status).toBe("ok");
      expect(result.verdict).toContain("SHOWSTOPPER");
    });

    it("V2: passes when no showstopper", async () => {
      spawnResult = { stdout: "## Verdict\n\n**PASS** : All good.", stderr: "", exitCode: 0 };
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runAdvocatePhase(run);
      expect(result.verdict).toContain("PASS");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/maturation-phases.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/maturation/phases.ts
import { createLogger } from "../logger.ts";
import { spawnClaude } from "../agent.ts";
import type { MaturationRun } from "./types.ts";
import { buildPhasePrompt, getAgentConfig } from "./agents.ts";
import { readDocument, writeDocument, getRunDir } from "./documents.ts";
import { extractAmbiguityScore, extractMaturityScore, extractShowstopper } from "./scoring.ts";
import type { PhaseResult } from "./engine.ts";

const log = createLogger("maturation/phases");

// ── Helpers ─────────────────────────────────────────────────

async function collectDocuments(run: MaturationRun): Promise<Partial<Record<string, string>>> {
  const docs: Partial<Record<string, string>> = {};
  for (const step of Object.values(run.steps)) {
    for (const docPath of step.documents) {
      const docType = docPath.replace(".md", "");
      const content = await readDocument(run.id, docType as any);
      if (content) docs[docType] = content;
    }
  }
  return docs;
}

async function runSingleAgent(
  run: MaturationRun,
  role: string,
): Promise<{ output: string; success: boolean }> {
  const config = getAgentConfig(role);
  if (!config) return { output: "", success: false };

  const docs = await collectDocuments(run);
  const prompt = buildPhasePrompt(role, {
    rawInput: run.rawInput,
    runDir: getRunDir(run.id),
    documents: docs,
  });

  const agentFile = `.claude/agents/${config.agentFile}`;
  const systemPrompt = `Read your agent profile in ${agentFile} and follow its instructions.`;

  try {
    const result = await spawnClaude({
      prompt,
      systemPrompt,
      model: config.model,
      effort: config.effort,
      outputFormat: "text",
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      log.warn(`Agent ${role} failed: exit=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`);
      return { output: "", success: false };
    }

    // Write the output as a document
    await writeDocument(run.id, config.outputDoc, result.stdout);
    return { output: result.stdout, success: true };
  } catch (err) {
    log.error(`Agent ${role} threw: ${err}`);
    return { output: "", success: false };
  }
}

// ── Phase Runners ───────────────────────────────────────────

export async function runUnderstandPhase(run: MaturationRun): Promise<PhaseResult> {
  const { output, success } = await runSingleAgent(run, "understander");
  if (!success) return { status: "failed", documents: [] };

  const ambiguity = extractAmbiguityScore(output);
  return {
    status: "ok",
    documents: ["UNDERSTANDING.md"],
    verdict: `ambiguity:${ambiguity}`,
  };
}

export async function runExplorePhase(run: MaturationRun): Promise<PhaseResult> {
  const roles = ["expander", "researcher", "analogist"];
  const results = await Promise.allSettled(roles.map((r) => runSingleAgent(run, r)));

  const documents: string[] = [];
  const docMap = { expander: "EXPAND.md", researcher: "RESEARCH.md", analogist: "ANALOGIES.md" };

  for (let i = 0; i < roles.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value.success) {
      documents.push(docMap[roles[i] as keyof typeof docMap]);
    } else {
      log.warn(`Explore agent ${roles[i]} failed`);
    }
  }

  // Partial success is acceptable (at least 1 must succeed)
  if (documents.length === 0) return { status: "failed", documents: [] };
  return { status: "ok", documents };
}

export async function runConfrontPhase(run: MaturationRun): Promise<PhaseResult> {
  const roles = ["tech-critic", "product-critic", "strategy-critic"];
  const results = await Promise.allSettled(roles.map((r) => runSingleAgent(run, r)));

  const documents: string[] = [];
  const docMap = {
    "tech-critic": "CRITIQUE-TECH.md",
    "product-critic": "CRITIQUE-PROD.md",
    "strategy-critic": "CRITIQUE-STRAT.md",
  };

  for (let i = 0; i < roles.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value.success) {
      documents.push(docMap[roles[i] as keyof typeof docMap]);
    }
  }

  if (documents.length === 0) return { status: "failed", documents: [] };
  return { status: "ok", documents };
}

export async function runSynthesizePhase(run: MaturationRun): Promise<PhaseResult> {
  const { output, success } = await runSingleAgent(run, "synthesizer");
  if (!success) return { status: "failed", documents: [] };

  const score = extractMaturityScore(output);
  return {
    status: "ok",
    documents: ["SPEC-UNIFIEE.md"],
    score,
    verdict: `maturity:${score}`,
  };
}

export async function runAdvocatePhase(run: MaturationRun): Promise<PhaseResult> {
  const { output, success } = await runSingleAgent(run, "devils-advocate");
  if (!success) return { status: "failed", documents: [] };

  const showstopper = extractShowstopper(output);
  return {
    status: "ok",
    documents: ["DEVILS-ADVOCATE.md"],
    verdict: showstopper ? `SHOWSTOPPER: ${showstopper.reason}` : "PASS",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-phases.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/maturation/phases.ts tests/unit/maturation-phases.test.ts
git commit -m "feat(maturation): add phase execution logic with parallel agent spawning"
```

---

## Task 7: Barrel, Config & Action Registry Integration

**Files:**
- Create: `src/maturation/index.ts`
- Modify: `src/config.ts:29-55` (add MATURATION_DIR)
- Modify: `src/action-registry.ts` (add /idea command)
- Modify: `src/intent-detection.ts` (add maturation intent)

- [ ] **Step 1: Create barrel file**

```typescript
// src/maturation/index.ts
export * from "./types.ts";
export * from "./documents.ts";
export * from "./scoring.ts";
export * from "./engine.ts";
export * from "./phases.ts";
export * from "./agents.ts";
```

- [ ] **Step 2: Add MATURATION_DIR to config.ts**

In `src/config.ts`, add to `OptionalEnvSchema` after `TMPDIR`:

```typescript
  MATURATION_DIR: z.string().default(""),
```

Add to `AppConfig` type after `tmpDir`:

```typescript
  maturationDir: string;
```

Add to `_config` assignment after `tmpDir`:

```typescript
    maturationDir: optionalResult.MATURATION_DIR,
```

- [ ] **Step 3: Add /idea to action-registry.ts**

Add to the ACTIONS array in `src/action-registry.ts`:

```typescript
  // ─── maturation.ts ───
  {
    command: "idea",
    description: "Lancer la maturation d'une idee",
    usage: "/idea <description de l'idee>",
    params: [{ name: "description", required: true, description: "Description de l'idee a faire murir" }],
    risk: "medium",
    module: "maturation",
    requiresSupabase: false,
    aliases: [
      "nouvelle idee", "j'ai une idee", "idee d'amelioration",
      "on pourrait", "il faudrait", "ce serait bien",
      "maturation", "faire murir",
    ],
    backgroundEligible: true,
    category: "dev",
  },
```

- [ ] **Step 4: Add maturation intent to intent-detection.ts**

Add to the intent patterns array in `src/intent-detection.ts`:

```typescript
  {
    intent: "maturation",
    command: "idea",
    patterns: [
      /j'ai une id[eé]e/i,
      /nouvelle id[eé]e/i,
      /on pourrait\s+(?:faire|ajouter|cr[eé]er|am[eé]liorer)/i,
      /il faudrait\s+(?:pouvoir|qu'on|que le)/i,
      /ce serait (?:bien|cool|utile)\s+(?:de|d'|si)/i,
      /faire m[uû]rir/i,
      /lancer.*maturation/i,
    ],
    argExtractor: (text: string) => {
      return text
        .replace(/^(j'ai une id[eé]e|nouvelle id[eé]e|on pourrait|il faudrait|ce serait (?:bien|cool|utile) (?:de|d'|si)|faire m[uû]rir|lancer.*maturation)\s*/i, "")
        .trim() || undefined;
    },
  },
```

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `bun test`
Expected: ALL PASS (2360+ tests)

- [ ] **Step 6: Commit**

```bash
git add src/maturation/index.ts src/config.ts src/action-registry.ts src/intent-detection.ts
git commit -m "feat(maturation): add barrel, config, action registry, and intent detection"
```

---

## Task 8: Telegram Command Composer

**Files:**
- Create: `src/commands/maturation.ts`
- Test: `tests/unit/maturation-command.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/maturation-command.test.ts
import { describe, expect, it, mock } from "bun:test";
import {
  parseIdeaCommand,
  buildValidationKeyboard,
  buildMaturationStatusBar,
  formatRunSummary,
} from "../../src/commands/maturation.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

describe("commands/maturation", () => {
  describe("parseIdeaCommand", () => {
    it("V1: extracts description from command text", () => {
      expect(parseIdeaCommand("/idea Export CSV des taches")).toBe("Export CSV des taches");
    });

    it("V2: returns null for empty command", () => {
      expect(parseIdeaCommand("/idea")).toBeNull();
      expect(parseIdeaCommand("/idea   ")).toBeNull();
    });
  });

  describe("buildValidationKeyboard", () => {
    it("V1: builds 3-button keyboard for validation", () => {
      const kb = buildValidationKeyboard("test-run-id");
      const buttons = kb.inline_keyboard.flat();
      expect(buttons.length).toBe(3);
      expect(buttons[0].callback_data).toBe("mat_validate:test-run-id");
      expect(buttons[1].callback_data).toBe("mat_modify:test-run-id");
      expect(buttons[2].callback_data).toBe("mat_reject:test-run-id");
    });
  });

  describe("buildMaturationStatusBar", () => {
    it("V1: shows all phases with status symbols", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.steps.understand.status = "ok";
      run.steps.clarify.status = "skipped";
      run.steps.explore.status = "running";
      const bar = buildMaturationStatusBar(run);
      expect(bar).toContain("Comprehension");
      expect(bar).toContain("Exploration");
    });

    it("V2: includes iteration count when > 0", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.iteration = 1;
      const bar = buildMaturationStatusBar(run);
      expect(bar).toContain("iteration 1");
    });
  });

  describe("formatRunSummary", () => {
    it("V1: formats summary for Telegram", () => {
      const run = createEmptyRun(1, undefined, "test-idea", "Export CSV");
      run.steps.understand.status = "ok";
      run.steps.understand.score = 3;
      const summary = formatRunSummary(run);
      expect(summary).toContain("test-idea");
      expect(summary).toContain("Export CSV");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/maturation-command.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/commands/maturation.ts
import { Composer, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { createLogger } from "../logger.ts";
import type { BotContext } from "../bot-context.ts";
import {
  type MaturationRun,
  ALL_MATURATION_PHASES,
  PHASE_LABELS,
  toMaturationName,
  createEmptyRun,
} from "../maturation/types.ts";
import { initRun, saveRunMeta, loadRunMeta, getRunDir } from "../maturation/documents.ts";
import { handlePhaseResult } from "../maturation/engine.ts";
import {
  runUnderstandPhase,
  runExplorePhase,
  runConfrontPhase,
  runSynthesizePhase,
  runAdvocatePhase,
} from "../maturation/phases.ts";
import { escapeHtml } from "../html-utils.ts";

const log = createLogger("commands/maturation");

// ── Status symbols ──────────────────────────────────────────

const STATUS_SYMBOLS: Record<string, string> = {
  pending: "\u25CB",   // ○
  running: "\u25D4",   // ◔
  ok: "\u25CF",        // ●
  failed: "\u2717",    // ✗
  skipped: "\u2013",   // –
};

// ── Public helpers (exported for tests) ─────────────────────

export function parseIdeaCommand(text: string): string | null {
  const match = text.match(/^\/idea\s+(.+)/s);
  if (!match) return null;
  const desc = match[1].trim();
  return desc || null;
}

export function buildValidationKeyboard(runId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Valider", `mat_validate:${runId}`)
    .text("Modifier", `mat_modify:${runId}`)
    .text("Rejeter", `mat_reject:${runId}`);
}

export function buildMaturationStatusBar(run: MaturationRun): string {
  const lines: string[] = [`<b>Maturation : ${escapeHtml(run.name)}</b>`];
  if (run.iteration > 0) {
    lines.push(`<i>(iteration ${run.iteration})</i>`);
  }
  lines.push("");

  for (const phase of ALL_MATURATION_PHASES) {
    const step = run.steps[phase];
    const sym = STATUS_SYMBOLS[step.status] ?? "?";
    const label = PHASE_LABELS[phase];
    const scorePart = step.score !== undefined ? ` (${step.score}/10)` : "";
    lines.push(`${sym} ${label}${scorePart}`);
  }
  return lines.join("\n");
}

export function formatRunSummary(run: MaturationRun): string {
  const lines: string[] = [
    `<b>Idee :</b> ${escapeHtml(run.name)}`,
    `<b>Input :</b> ${escapeHtml(run.rawInput.slice(0, 200))}`,
    "",
    buildMaturationStatusBar(run),
  ];
  return lines.join("\n");
}

// ── Composer ────────────────────────────────────────────────

export default function maturationComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /idea <description>
  composer.command("idea", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const description = parseIdeaCommand(text);

    if (!description) {
      await bctx.sendResponseHtml(ctx,
        "<b>Usage :</b> <code>/idea description de l'idee</code>\n\n" +
        "Decris ton idee en quelques mots et le moteur de maturation la fera murir " +
        "a travers exploration, confrontation et synthese.");
      return;
    }

    const threadId = bctx.getThreadId(ctx);
    const name = toMaturationName(description);
    const run = createEmptyRun(ctx.chat!.id, threadId, name, description);

    await initRun(run);
    await bctx.sendResponseHtml(ctx,
      `${buildMaturationStatusBar(run)}\n\n` +
      `Lancement de la maturation de l'idee...`);

    // Launch maturation as background job via job-manager
    const { launch, isJobManagerEnabled } = await import("../job-manager.ts");
    if (!isJobManagerEnabled()) {
      await bctx.sendResponse(ctx, "Job manager desactive. Activez le feature flag 'job_manager'.");
      return;
    }

    const jobId = await launch(
      `maturation:${name}`,
      ctx.chat!.id,
      async () => {
        return await runMaturationPipeline(run, async (msg) => {
          const { sendProgressMessage } = await import("../job-manager.ts");
          await sendProgressMessage(ctx.chat!.id, threadId, msg);
        });
      },
      { messageThreadId: threadId },
    );

    run.steps.understand.jobId = jobId;
    await saveRunMeta(run);
  });

  // Validation callbacks
  composer.callbackQuery(/^mat_(validate|modify|reject):(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^mat_(validate|modify|reject):(.+)$/);
    if (!match) return;
    const [, action, runId] = match;

    const run = await loadRunMeta(runId);
    if (!run) {
      await ctx.answerCallbackQuery({ text: "Run introuvable (expire ?)" });
      return;
    }

    if (action === "validate") {
      await ctx.answerCallbackQuery({ text: "Idee validee !" });
      await ctx.editMessageText(
        `${buildMaturationStatusBar(run)}\n\n<b>Validee.</b> Prete pour le pipeline SDD.`,
        { parse_mode: "HTML" },
      );
      // TODO: handoff to SDD pipeline
    } else if (action === "reject") {
      await ctx.answerCallbackQuery({ text: "Idee rejetee." });
      await ctx.editMessageText(
        `${buildMaturationStatusBar(run)}\n\n<b>Rejetee.</b>`,
        { parse_mode: "HTML" },
      );
    } else if (action === "modify") {
      await ctx.answerCallbackQuery({ text: "Envoie tes modifications." });
      await ctx.editMessageText(
        `${buildMaturationStatusBar(run)}\n\nEnvoie tes modifications en reponse a ce message.`,
        { parse_mode: "HTML" },
      );
    }
  });

  return composer;
}

// ── Pipeline orchestration ──────────────────────────────────

async function runMaturationPipeline(
  run: MaturationRun,
  onProgress: (msg: string) => Promise<void>,
): Promise<string> {
  const phases: Array<{
    phase: MaturationRun["currentPhase"];
    runner: (run: MaturationRun) => Promise<import("./engine.ts").PhaseResult>;
    label: string;
  }> = [
    { phase: "understand", runner: runUnderstandPhase, label: "Comprehension" },
    { phase: "explore", runner: runExplorePhase, label: "Exploration" },
    { phase: "confront", runner: runConfrontPhase, label: "Confrontation" },
    { phase: "synthesize", runner: runSynthesizePhase, label: "Synthese" },
    { phase: "advocate", runner: runAdvocatePhase, label: "Avocat du diable" },
  ];

  for (const { phase, runner, label } of phases) {
    if (run.currentPhase !== phase) continue;

    await onProgress(`${STATUS_SYMBOLS.running} ${label} en cours...`);
    run.steps[phase].status = "running";
    run.steps[phase].startedAt = new Date().toISOString();
    await saveRunMeta(run);

    const result = await runner(run);
    run = handlePhaseResult(run, phase, result);
    await saveRunMeta(run);

    if (result.status === "failed") {
      return `MATURATION_FAILED:${phase}:${run.name}`;
    }

    await onProgress(`${STATUS_SYMBOLS.ok} ${label} terminee.`);

    // If looped back, re-run from explore
    if (run.currentPhase === "explore" && phase === "advocate") {
      return await runMaturationPipeline(run, onProgress);
    }
  }

  // Reached validate phase — return summary for human
  return `MATURATION_READY:${run.name}:${run.id}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/maturation-command.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: ALL PASS (2360+ tests, no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/commands/maturation.ts tests/unit/maturation-command.test.ts
git commit -m "feat(maturation): add /idea Telegram command with pipeline orchestration"
```

---

## Task 9: CLAUDE.md Documentation Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add maturation module to CLAUDE.md source modules table**

In the Source Modules table, add after `sdd-task-sync.ts`:

```markdown
| `maturation/types.ts` | Maturation engine types: phases, steps, runs, documents, quality gates |
| `maturation/documents.ts` | Maturation filesystem I/O: run directories, atomic document persistence |
| `maturation/scoring.ts` | Quality gate scoring: ambiguity/maturity extraction, gate evaluation |
| `maturation/engine.ts` | Maturation state machine: phase transitions, loop logic, circuit breaker |
| `maturation/phases.ts` | Phase execution: P0-P3b runners with parallel agent spawning |
| `maturation/agents.ts` | Maturation agent configuration: prompt builders, model/effort mapping |
| `maturation/index.ts` | Barrel re-export for maturation sub-modules |
| `commands/maturation.ts` | Composer: /idea (maturation pipeline launch + mat_ callbacks) |
```

- [ ] **Step 2: Add /idea to Telegram Commands table**

```markdown
| `/idea <description>` | Lancer la maturation multi-agent d'une idee (exploration, confrontation, synthese) |
```

- [ ] **Step 3: Add maturation agents to the agents count**

Update the `.claude/agents/` line from "6 specialized agents" to "15 specialized agents (6 dev pipeline + 9 maturation)".

- [ ] **Step 4: Update project structure**

Add `.maturation/` to the project structure:

```markdown
.maturation/            Maturation engine runs (local-first, filesystem)
```

Update source module count and LOC as needed.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add maturation engine to CLAUDE.md"
```

---

## Task 10: Integration Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run coding standards check**

Run: `bun test tests/unit/coding-standards.test.ts`
Expected: ALL PASS (S1-S9 standards)

- [ ] **Step 4: Run per-file coverage check**

Run: `./scripts/check-coverage.sh`
Expected: All new files >= 30% coverage

- [ ] **Step 5: Verify loader discovers maturation composer**

Run: `bun -e "import { Glob } from 'bun'; const g = new Glob('src/commands/*.ts'); for await (const f of g.scan('.')) console.log(f)"`
Expected: List includes `src/commands/maturation.ts`

- [ ] **Step 6: Create feature branch and PR**

```bash
git checkout -b feat/maturation-engine
git push -u origin feat/maturation-engine
gh pr create --title "feat: maturation engine — multi-agent idea maturation" --body "$(cat <<'EOF'
## Summary
- Multi-agent maturation engine: transforms raw ideas into structured specs
- 5 phases: understand → explore (3 parallel) → confront (3 parallel) → synthesize → advocate
- Local-first filesystem (.maturation/runs/<id>/*.md), Supabase optional
- 9 new agent definitions with specialized prompts
- /idea Telegram command with inline validation keyboard
- Quality gates with maturity scoring and loop-back on showstoppers

## Test plan
- [ ] Unit tests for all 7 new modules (types, documents, scoring, engine, phases, agents, command)
- [ ] Full test suite passes (2360+ tests)
- [ ] Typecheck passes
- [ ] Coding standards pass (S1-S9)
- [ ] Per-file coverage >= 30%
- [ ] Manual test: /idea "export CSV" on Telegram

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Wait for CI**

Run: `./scripts/wait-ci.sh`
Expected: CI passes (green)

---

## Self-Review Checklist

1. **Spec coverage:** All 5 maturation phases implemented (P0-P3b + P4 validation). 9 agents defined. Quality gates with scoring. Loop-back on showstopper. Supabase-optional design. Telegram command with inline keyboards. ✅
2. **Placeholder scan:** No TBDs, TODOs (except the explicit `// TODO: handoff to SDD pipeline` which is a documented future task), or "implement later" references. All code blocks contain complete implementations. ✅
3. **Type consistency:** `MaturationPhase`, `MaturationRun`, `PhaseResult`, `GateResult` used consistently across all tasks. `buildPhasePrompt` signature matches in agents.ts and phases.ts. `handlePhaseResult` signature matches in engine.ts and maturation.ts. ✅
