import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  _setCallClaudeHookForTests,
  buildContradictionDetectorPrompt,
  CONTRADICTION_THRESHOLD,
  detectContradiction,
  handleCheckpointResponse,
  loadGlobalDecisions,
  MAX_CONTRADICTION_PAUSES,
  parseContradictionResponse,
  saveGlobalDecision,
  startContradictionCheckpoint,
} from "../../src/maturation/checkpoint.ts";
import { _setBaseDirForTests, initRun } from "../../src/maturation/documents.ts";
import type { GlobalDecision } from "../../src/maturation/types.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-contradiction");

function makeDecision(id: string, tags: string[] = []): GlobalDecision {
  return {
    id,
    runId: "run-1",
    runName: "test-run",
    source: "synthesize",
    summary: `Décision ${id}: utiliser PostgreSQL comme base de données`,
    userChoice: "PostgreSQL",
    timestamp: new Date().toISOString(),
    tags,
  };
}

describe("maturation/contradiction", () => {
  beforeEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
    _setCallClaudeHookForTests(undefined);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    _setCallClaudeHookForTests(undefined);
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── Constants ────────────────────────────────────────────────

  describe("constants", () => {
    it("V1: CONTRADICTION_THRESHOLD is 0.85", () => {
      expect(CONTRADICTION_THRESHOLD).toBe(0.85);
    });

    it("V2: MAX_CONTRADICTION_PAUSES is 2", () => {
      expect(MAX_CONTRADICTION_PAUSES).toBe(2);
    });
  });

  // ── buildContradictionDetectorPrompt ─────────────────────────

  describe("buildContradictionDetectorPrompt", () => {
    it("V1: includes phase name in output", () => {
      const decision = makeDecision("d1");
      const prompt = buildContradictionDetectorPrompt("phase output text", [decision], "explore");
      expect(prompt).toContain("explore");
    });

    it("V2: includes decision summaries and user choices", () => {
      const decision = makeDecision("d1");
      const prompt = buildContradictionDetectorPrompt("output", [decision], "confront");
      expect(prompt).toContain("PostgreSQL");
      expect(prompt).toContain("Décision d1");
    });

    it("V3: truncates phase output to 2000 chars", () => {
      const longOutput = "x".repeat(5000);
      const decision = makeDecision("d1");
      const prompt = buildContradictionDetectorPrompt(longOutput, [decision], "advocate");
      // Total prompt should be reasonable, not 5000+ chars of output
      expect(prompt.length).toBeLessThan(5000);
    });

    it("V4: includes 0.85 threshold reference", () => {
      const decision = makeDecision("d1");
      const prompt = buildContradictionDetectorPrompt("output", [decision], "synthesize");
      expect(prompt).toContain("0.85");
    });

    it("V5: includes score and summary JSON format", () => {
      const decision = makeDecision("d1");
      const prompt = buildContradictionDetectorPrompt("output", [decision], "explore");
      expect(prompt).toContain("score");
      expect(prompt).toContain("summary");
    });
  });

  // ── parseContradictionResponse ───────────────────────────────

  describe("parseContradictionResponse", () => {
    it("V1: parses valid JSON with score and summary", () => {
      const text = JSON.stringify({ score: 0.9, summary: "Contradiction with DB choice" });
      const result = parseContradictionResponse(text);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0.9);
      expect(result!.summary).toBe("Contradiction with DB choice");
    });

    it("V2: parses JSON from markdown code block", () => {
      const text = '```json\n{"score": 0.95, "summary": "Forte contradiction"}\n```';
      const result = parseContradictionResponse(text);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0.95);
      expect(result!.summary).toBe("Forte contradiction");
    });

    it("V3: returns null for plain text (no JSON)", () => {
      expect(parseContradictionResponse("not json at all")).toBeNull();
    });

    it("V4: returns null when score is not a number", () => {
      const text = JSON.stringify({ score: "high", summary: "test" });
      expect(parseContradictionResponse(text)).toBeNull();
    });

    it("V5: returns null when score is out of range (> 1)", () => {
      const text = JSON.stringify({ score: 1.5, summary: "test" });
      expect(parseContradictionResponse(text)).toBeNull();
    });

    it("V6: returns null when score is out of range (< 0)", () => {
      const text = JSON.stringify({ score: -0.1, summary: "test" });
      expect(parseContradictionResponse(text)).toBeNull();
    });

    it("V7: returns null when summary is missing", () => {
      const text = JSON.stringify({ score: 0.9 });
      expect(parseContradictionResponse(text)).toBeNull();
    });

    it("V8: returns null for empty input", () => {
      expect(parseContradictionResponse("")).toBeNull();
    });

    it("V9: accepts score of exactly 0", () => {
      const text = JSON.stringify({ score: 0, summary: "Aucune contradiction" });
      const result = parseContradictionResponse(text);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });

    it("V10: accepts score of exactly 1", () => {
      const text = JSON.stringify({ score: 1, summary: "Contradiction totale" });
      const result = parseContradictionResponse(text);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(1);
    });
  });

  // ── detectContradiction ──────────────────────────────────────

  describe("detectContradiction", () => {
    it("V1: returns null when no existing decisions", async () => {
      _setCallClaudeHookForTests(async () => JSON.stringify({ score: 0.95, summary: "test" }));
      const result = await detectContradiction("phase output", [], async () => "", "explore");
      expect(result).toBeNull();
    });

    it("V2: returns null when score is below threshold (0.7 < 0.85)", async () => {
      const decisions = [makeDecision("d1")];
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({ score: 0.7, summary: "Tension mineure" }),
      );
      const result = await detectContradiction("output", decisions, async () => "", "confront");
      expect(result).toBeNull();
    });

    it("V3: returns result when score meets threshold (0.9 >= 0.85)", async () => {
      const decisions = [makeDecision("d1")];
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({ score: 0.9, summary: "Contradiction forte avec décision précédente" }),
      );
      const result = await detectContradiction("output", decisions, async () => "", "advocate");
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0.9);
      expect(result!.summary).toContain("Contradiction");
    });

    it("V4: returns result at exact threshold (0.85 = 0.85)", async () => {
      const decisions = [makeDecision("d1")];
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({ score: 0.85, summary: "Exactement au seuil" }),
      );
      const result = await detectContradiction("output", decisions, async () => "", "explore");
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0.85);
    });

    it("V5: fail-open on callClaude error (returns null)", async () => {
      const decisions = [makeDecision("d1")];
      _setCallClaudeHookForTests(async () => {
        throw new Error("Claude API unavailable");
      });
      const result = await detectContradiction("output", decisions, async () => "", "confront");
      expect(result).toBeNull();
    });

    it("V6: fail-open on invalid response (returns null)", async () => {
      const decisions = [makeDecision("d1")];
      _setCallClaudeHookForTests(async () => "invalid response — no json here");
      const result = await detectContradiction("output", decisions, async () => "", "synthesize");
      expect(result).toBeNull();
    });

    it("V7: returns null for score just below threshold (0.84 < 0.85)", async () => {
      const decisions = [makeDecision("d1")];
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({ score: 0.84, summary: "Quasi-contradiction" }),
      );
      const result = await detectContradiction("output", decisions, async () => "", "explore");
      expect(result).toBeNull();
    });
  });

  // ── startContradictionCheckpoint ─────────────────────────────

  describe("startContradictionCheckpoint", () => {
    it("V1: returns null when no global decisions exist", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      _setCallClaudeHookForTests(async () => JSON.stringify({ score: 0.95, summary: "test" }));
      // No decisions in global decisions file
      const result = await startContradictionCheckpoint(run, "output", "explore", async () => "");
      expect(result).toBeNull();
      expect(run.pendingCheckpoint).toBeUndefined();
    });

    it("V2: returns null when score is below threshold", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      await saveGlobalDecision(makeDecision("d1"));
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({ score: 0.3, summary: "Pas de contradiction" }),
      );
      const result = await startContradictionCheckpoint(run, "output", "explore", async () => "");
      expect(result).toBeNull();
      expect(run.pendingCheckpoint).toBeUndefined();
    });

    it("V3: creates checkpoint with source=contradiction when detected", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      await saveGlobalDecision(makeDecision("d1"));
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({
          score: 0.92,
          summary: "Contradiction avec la décision sur la base de données",
        }),
      );
      const result = await startContradictionCheckpoint(run, "output", "confront", async () => "");
      expect(result).not.toBeNull();
      expect(result!.source).toBe("contradiction");
      expect(result!.summary).toContain("Contradiction");
      expect(result!.tags).toContain("contradiction");
      expect(result!.options.length).toBeGreaterThan(0);
      expect(run.pendingCheckpoint).not.toBeUndefined();
      expect(run.pendingCheckpoint!.source).toBe("contradiction");
      expect(run.contradictionPauseCount).toBe(1);
    });

    it("V4: circuit breaker blocks when contradictionPauseCount >= MAX_CONTRADICTION_PAUSES", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      run.contradictionPauseCount = MAX_CONTRADICTION_PAUSES; // Already at max
      await saveGlobalDecision(makeDecision("d1"));
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({ score: 0.99, summary: "Very strong contradiction" }),
      );
      const result = await startContradictionCheckpoint(run, "output", "advocate", async () => "");
      expect(result).toBeNull();
      // Count should not have increased
      expect(run.contradictionPauseCount).toBe(MAX_CONTRADICTION_PAUSES);
    });

    it("V5: allows pause when count is one below max (MAX-1 < MAX)", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      run.contradictionPauseCount = MAX_CONTRADICTION_PAUSES - 1;
      await saveGlobalDecision(makeDecision("d1"));
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({ score: 0.9, summary: "Contradiction détectée" }),
      );
      const result = await startContradictionCheckpoint(run, "output", "explore", async () => "");
      expect(result).not.toBeNull();
      expect(run.contradictionPauseCount).toBe(MAX_CONTRADICTION_PAUSES);
    });

    it("V6: count defaults to 0 when contradictionPauseCount is undefined", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      // contradictionPauseCount is undefined by default
      expect(run.contradictionPauseCount).toBeUndefined();
      await saveGlobalDecision(makeDecision("d1"));
      _setCallClaudeHookForTests(async () =>
        JSON.stringify({ score: 0.9, summary: "Première contradiction" }),
      );
      const result = await startContradictionCheckpoint(run, "output", "explore", async () => "");
      expect(result).not.toBeNull();
      expect(run.contradictionPauseCount).toBe(1);
    });
  });

  // ── handleCheckpointResponse (contradiction source) ──────────

  describe("handleCheckpointResponse (contradiction source)", () => {
    it("V1: does NOT save to global decisions for source=contradiction", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-contradiction-1",
        source: "contradiction",
        summary: "Contradiction détectée avec décision PostgreSQL",
        options: ["Ignorer", "Revoir"],
        recommendation: "CONTINUE",
        tags: ["contradiction"],
      };
      await initRun(run);

      await handleCheckpointResponse(run, "Ignorer cette contradiction et continuer");

      // Verify no global decision was saved
      const decisions = await loadGlobalDecisions();
      expect(decisions).toHaveLength(0);
    });

    it("V2: resolves checkpoint (clears pendingCheckpoint, adds to resolvedCheckpoints)", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-contradiction-2",
        source: "contradiction",
        summary: "Test contradiction",
        options: ["Option A"],
        recommendation: "CONTINUE",
        tags: ["contradiction"],
      };
      await initRun(run);

      const result = await handleCheckpointResponse(run, "Option A");

      expect(result.action).toBe("CONTINUE");
      expect(run.pendingCheckpoint).toBeUndefined();
      expect(run.resolvedCheckpoints).toHaveLength(1);
      expect(run.resolvedCheckpoints![0].source).toBe("contradiction");
      expect(run.resolvedCheckpoints![0].userChoice).toBe("Option A");
    });

    it("V3: saves to global decisions for source=synthesize (existing behavior unchanged)", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-synth-1",
        source: "synthesize",
        summary: "Choix de base de données",
        options: ["PostgreSQL", "SQLite"],
        recommendation: "CONTINUE",
        tags: ["architecture"],
      };
      await initRun(run);

      await handleCheckpointResponse(run, "PostgreSQL");

      const decisions = await loadGlobalDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].source).toBe("synthesize");
      expect(decisions[0].userChoice).toBe("PostgreSQL");
    });

    it("V4: saves to global decisions for source=advocate (existing behavior unchanged)", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-adv-1",
        source: "advocate",
        summary: "Showstopper identifié",
        options: ["Revoir", "Continuer"],
        recommendation: "RE-EXPLORE",
        tags: ["blocage"],
      };
      await initRun(run);

      await handleCheckpointResponse(run, "Revoir");

      const decisions = await loadGlobalDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].source).toBe("advocate");
    });
  });
});
