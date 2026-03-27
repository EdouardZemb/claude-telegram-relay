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

const {
  runUnderstandPhase,
  runExplorePhase,
  runConfrontPhase,
  runSynthesizePhase,
  runAdvocatePhase,
} = await import("../../src/maturation/phases.ts");

import { _setBaseDirForTests, initRun } from "../../src/maturation/documents.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-phases");

describe("maturation/phases", () => {
  beforeEach(async () => {
    spawnCalls.length = 0;
    mockStdout = "## Score d'ambiguite : 3/10\n\nClair.";
    mockExitCode = 0;
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
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
});
