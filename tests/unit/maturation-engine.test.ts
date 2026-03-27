import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { _setBaseDirForTests, initRun } from "../../src/maturation/documents.ts";
import {
  _setSpawnHookForTests,
  getNextPhase,
  handlePhaseResult,
  MAX_LOOP_ITERATIONS,
  shouldSkipClarify,
} from "../../src/maturation/engine.ts";
import { createEmptyRun, type MaturationRun } from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-engine");

describe("maturation/engine", () => {
  let run: MaturationRun;

  beforeEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* */
    }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
    _setSpawnHookForTests(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
    run = createEmptyRun(1, undefined, "test-idea", "Je veux un export CSV");
    await initRun(run);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    _setSpawnHookForTests(undefined);
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* */
    }
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
      expect(getNextPhase("advocate", { showstopper: true, iteration: 0, maxIterations: 2 })).toBe(
        "explore",
      );
    });

    it("V9: advocate → validate (showstopper but max iterations)", () => {
      expect(getNextPhase("advocate", { showstopper: true, iteration: 2, maxIterations: 2 })).toBe(
        "validate",
      );
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
      expect(updated.currentPhase).toBe("explore");
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
