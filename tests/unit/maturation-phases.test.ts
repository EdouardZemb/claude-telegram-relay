import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

// Mock spawnClaude BEFORE importing phases
const spawnCalls: Array<{ prompt: string; systemPrompt?: string }> = [];
let mockStdout = "## Score d'ambiguite : 3/10\n\nClair.";
let mockExitCode = 0;

mock.module("../../src/agent.ts", () => ({
  spawnClaude: async (opts: {
    prompt: string;
    systemPrompt?: string;
    model?: string;
    effort?: string;
  }) => {
    spawnCalls.push({ prompt: opts.prompt, systemPrompt: opts.systemPrompt });
    return { stdout: mockStdout, stderr: "", exitCode: mockExitCode };
  },
}));

// Track buildEnrichedPrompt calls (via hook — avoids mock.module() pollution)
const enrichedPromptCalls: Array<{ role: string; base: string }> = [];
let mockEnrichedSuffix = ""; // empty = no overlay active

const {
  runUnderstandPhase,
  runExplorePhase,
  runConfrontPhase,
  runSynthesizePhase,
  runAdvocatePhase,
  _setFeatureFlagHookForTests,
  _setEnrichPromptHookForTests,
} = await import("../../src/maturation/phases.ts");

import { _setBaseDirForTests, initRun } from "../../src/maturation/documents.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-phases");

describe("maturation/phases", () => {
  beforeEach(async () => {
    spawnCalls.length = 0;
    enrichedPromptCalls.length = 0;
    mockStdout = "## Score d'ambiguite : 3/10\n\nClair.";
    mockExitCode = 0;
    mockEnrichedSuffix = "";
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    _setFeatureFlagHookForTests(undefined);
    _setEnrichPromptHookForTests(undefined);
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe("runUnderstandPhase", () => {
    it("V1: spawns agent and returns ok with ambiguity score", async () => {
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runUnderstandPhase(run);
      expect(result.status).toBe("ok");
      expect(result.documents.length).toBe(1);
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].prompt).toContain("Export CSV");
      expect(result.verdict).toContain("ambiguity:3");
    });

    it("V2: handles agent failure", async () => {
      mockStdout = "";
      mockExitCode = 1;
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runUnderstandPhase(run);
      expect(result.status).toBe("failed");
    });
  });

  describe("runExplorePhase", () => {
    it("V1: spawns 3 agents in parallel", async () => {
      mockStdout = "exploration output";
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runExplorePhase(run);
      expect(result.status).toBe("ok");
      expect(spawnCalls.length).toBe(3);
      expect(result.documents.length).toBe(3);
    });
  });

  describe("runConfrontPhase", () => {
    it("V1: spawns 3 critics in parallel", async () => {
      mockStdout = "critique output";
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runConfrontPhase(run);
      expect(result.status).toBe("ok");
      expect(spawnCalls.length).toBe(3);
      expect(result.documents.length).toBe(3);
    });
  });

  describe("runSynthesizePhase", () => {
    it("V1: extracts maturity score", async () => {
      mockStdout = "## Score de maturite : 8/10\n\nSpec.";
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runSynthesizePhase(run);
      expect(result.status).toBe("ok");
      expect(result.score).toBe(8);
    });
  });

  describe("runAdvocatePhase", () => {
    it("V1: detects showstopper", async () => {
      mockStdout = "## Verdict\n\n**SHOWSTOPPER** : Critical security flaw found.";
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runAdvocatePhase(run);
      expect(result.status).toBe("ok");
      expect(result.verdict).toContain("SHOWSTOPPER");
    });

    it("V2: passes when no showstopper", async () => {
      mockStdout = "## Verdict\n\n**PASS** : All good.";
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runAdvocatePhase(run);
      expect(result.verdict).toContain("PASS");
    });
  });

  describe("V2: overlay wiring", () => {
    it("V2-1: overlaysUsed=false when flag is off", async () => {
      _setFeatureFlagHookForTests(() => false);
      _setEnrichPromptHookForTests((_role, base) => base); // returns unchanged
      mockStdout = "## Score d'ambiguite : 3/10\n\nClair.";
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runUnderstandPhase(run);
      expect(result.status).toBe("ok");
      expect(result.overlaysUsed).toBe(false);
    });

    it("V2-2: overlaysUsed=false when flag is on but no active overlays", async () => {
      _setFeatureFlagHookForTests((flag) => flag === "prompt_feedback_loop");
      // buildEnrichedPrompt returns base unchanged => no overlay
      _setEnrichPromptHookForTests((_role, base) => {
        enrichedPromptCalls.push({ role: _role, base });
        return base; // no change = no overlay
      });
      mockStdout = "## Score d'ambiguite : 3/10\n\nClair.";
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runUnderstandPhase(run);
      expect(result.status).toBe("ok");
      expect(result.overlaysUsed).toBe(false);
    });

    it("V2-3: overlaysUsed=true when flag on and overlay injected", async () => {
      _setFeatureFlagHookForTests((flag) => flag === "prompt_feedback_loop");
      // buildEnrichedPrompt appends overlay => prompt differs from base
      _setEnrichPromptHookForTests((_role, base) => {
        enrichedPromptCalls.push({ role: _role, base });
        return `${base}\n\nATTENTION : correctif actif`;
      });
      mockStdout = "## Score d'ambiguite : 3/10\n\nClair.";
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      await initRun(run);
      const result = await runUnderstandPhase(run);
      expect(result.status).toBe("ok");
      expect(result.overlaysUsed).toBe(true);
      expect(enrichedPromptCalls.length).toBeGreaterThan(0);
    });
  });
});
