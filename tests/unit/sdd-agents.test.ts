/**
 * Unit Tests — src/sdd-agents.ts
 *
 * Tests for the 5 SDD agent functions: runSddExplore, runSddSpec,
 * runSddChallenge, runSddImplement, runSddReview.
 *
 * V-criteria covered: V5, V6, V7, V8, V9, V10, V11, V18, V19, V20
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ── Mock spawnClaude before importing sdd-agents ─────────────

const spawnClaudeCalls: Array<{ prompt: string; systemPrompt?: string; options: any }> = [];
let spawnClaudeResults: Array<{ stdout: string; stderr: string; exitCode: number }> = [];
let spawnCallIndex = 0;

// Mock the agent module
mock.module("../../src/agent.ts", () => ({
  spawnClaude: async (opts: any) => {
    spawnClaudeCalls.push({ prompt: opts.prompt, systemPrompt: opts.systemPrompt, options: opts });
    const result = spawnClaudeResults[spawnCallIndex] || { stdout: "", stderr: "no mock", exitCode: 1 };
    spawnCallIndex++;
    return result;
  },
}));

// Mock writeFile for challenge report writing
const writtenFiles: Array<{ path: string; content: string }> = [];
mock.module("fs/promises", () => ({
  readFile: async (path: string, _encoding?: string) => {
    if (path.includes("explorer.md")) return "# Agent Explorer\nExplore the codebase.";
    if (path.includes("spec-architect.md")) return "# Agent Spec Architect\nGenerate specs.";
    if (path.includes("devils-advocate.md")) return "# Agent Devil's Advocate\nFind contradictions.";
    if (path.includes("edge-case-hunter.md")) return "# Agent Edge Case Hunter\nFind edge cases.";
    if (path.includes("simplicity-skeptic.md")) return "# Agent Simplicity Skeptic\nFind complexity.";
    if (path.includes("reviewer.md")) return "# Agent Reviewer\nReview code.";
    // Pass through to Bun native file read for other paths (avoids circular mock call)
    return Bun.file(path).text();
  },
  writeFile: async (path: string, content: string) => {
    writtenFiles.push({ path, content });
  },
  mkdir: async () => {},
  rename: async () => {},
}));

// Now import the module under test
import {
  runSddChallenge,
  runSddExplore,
  runSddImplement,
  runSddReview,
  runSddSpec,
} from "../../src/sdd-agents.ts";
import type { HandoffSummary } from "../../src/conversation-handoff.ts";

// ── Helpers ──────────────────────────────────────────────────

function makeHandoff(overrides: Partial<HandoffSummary> = {}): HandoffSummary {
  return {
    objective: "test-feature",
    decisions: ["Use Composer pattern"],
    constraints: ["No markdown"],
    filesIdentified: ["src/test.ts"],
    resolvedQuestions: [],
    outOfScope: [],
    explorationRef: "docs/explorations/EXPLORE-test-feature.md",
    specRef: undefined,
    ...overrides,
  };
}

function makeBctx(): any {
  return {
    supabase: null,
    sendResponse: async () => {},
    callClaude: async () => "",
  };
}

// ── Setup / Teardown ─────────────────────────────────────────

beforeEach(() => {
  spawnClaudeCalls.length = 0;
  spawnClaudeResults = [];
  spawnCallIndex = 0;
  writtenFiles.length = 0;
});

afterAll(() => {
  mock.restore();
});

// ── Tests ────────────────────────────────────────────────────

describe("sdd-agents", () => {
  // ── V18: No forbidden imports ──────────────────────────────

  describe("V18: import constraints", () => {
    it("V18: sdd-agents.ts does not import from forbidden modules", async () => {
      const { readFileSync } = await import("fs");
      const source = readFileSync(
        require("path").join(process.cwd(), "src/sdd-agents.ts"),
        "utf-8",
      );

      const forbidden = [
        "orchestrator",
        "blackboard",
        "gate-evaluator",
        "bmad-agents",
        "bmad-prompts",
        "agent-schemas",
        "adversarial-challenge",
        "adversarial-verifier",
        "spec-lite",
        "pipeline-selection",
        "pipeline-state",
        "workflow",
        "prd.ts",
        "auto-pipeline",
        "llm-router",
        "code-review",
        "conversation-session",
        "trust-scores",
        "gate-persistence",
        "agent-messaging",
        "feedback-loop",
      ];

      for (const mod of forbidden) {
        const pattern = new RegExp(`from\\s+['"]\\.\\./.*${mod}`);
        expect(source).not.toMatch(pattern);
      }
    });
  });

  // ── V5: runSddExplore ─────────────────────────────────────

  describe("runSddExplore", () => {
    it("V5: returns SDD_EXPLORE_GO when agent output contains GO verdict", async () => {
      spawnClaudeResults = [
        {
          stdout: "## Verdict\nGO\n\nExploration complete.",
          stderr: "",
          exitCode: 0,
        },
      ];

      const result = await runSddExplore("test-feature", 123, undefined, makeBctx());
      expect(result).toMatch(/^SDD_EXPLORE_GO:/);
    });

    it("V5: returns SDD_EXPLORE_PIVOT when agent output contains PIVOT verdict", async () => {
      spawnClaudeResults = [
        {
          stdout: "## Verdict\nPIVOT\n\nNeed different approach.",
          stderr: "",
          exitCode: 0,
        },
      ];

      const result = await runSddExplore("test-feature", 123, undefined, makeBctx());
      expect(result).toMatch(/^SDD_EXPLORE_PIVOT:/);
    });

    it("V5: returns SDD_EXPLORE_DROP when agent output contains DROP verdict", async () => {
      spawnClaudeResults = [
        {
          stdout: "## Verdict\nDROP\n\nNot viable.",
          stderr: "",
          exitCode: 0,
        },
      ];

      const result = await runSddExplore("test-feature", 123, undefined, makeBctx());
      expect(result).toMatch(/^SDD_EXPLORE_DROP:/);
    });

    it("V5: defaults to GO when no verdict found in output", async () => {
      spawnClaudeResults = [
        {
          stdout: "Exploration terminee. Pas de probleme majeur.",
          stderr: "",
          exitCode: 0,
        },
      ];

      const result = await runSddExplore("test-feature", 123, undefined, makeBctx());
      expect(result).toMatch(/^SDD_EXPLORE_GO:/);
    });

    it("V19: returns SDD_EXPLORE_FAILED when spawnClaude exits with error", async () => {
      spawnClaudeResults = [
        {
          stdout: "",
          stderr: "Agent timeout",
          exitCode: 1,
        },
      ];

      const result = await runSddExplore("test-feature", 123, undefined, makeBctx());
      expect(result).toMatch(/^SDD_EXPLORE_FAILED:/);
    });

    it("builds prompt directly with spawnClaude (R12: no buildExploreFn reuse)", async () => {
      spawnClaudeResults = [
        { stdout: "## Verdict\nGO\n\nDone.", stderr: "", exitCode: 0 },
      ];

      await runSddExplore("test-feature", 123, undefined, makeBctx());

      expect(spawnClaudeCalls).toHaveLength(1);
      expect(spawnClaudeCalls[0].prompt).toContain("test-feature");
    });
  });

  // ── V6, V7: runSddSpec ────────────────────────────────────

  describe("runSddSpec", () => {
    it("V6: returns SDD_SPEC_OK on success", async () => {
      spawnClaudeResults = [
        {
          stdout: "Spec SPEC-test-feature.md generated with 8 V-criteria.",
          stderr: "",
          exitCode: 0,
        },
      ];

      const handoff = makeHandoff();
      const result = await runSddSpec("test-feature", handoff, makeBctx());
      expect(result).toMatch(/^SDD_SPEC_OK:/);
    });

    it("V6: returns SDD_SPEC_FAILED on error", async () => {
      spawnClaudeResults = [
        { stdout: "", stderr: "Spec generation failed", exitCode: 1 },
      ];

      const result = await runSddSpec("test-feature", makeHandoff(), makeBctx());
      expect(result).toMatch(/^SDD_SPEC_FAILED:/);
    });

    it("V7: includes CONTEXTE CONVERSATIONNEL section in prompt", async () => {
      spawnClaudeResults = [
        { stdout: "Spec generated.", stderr: "", exitCode: 0 },
      ];

      await runSddSpec("test-feature", makeHandoff(), makeBctx());

      expect(spawnClaudeCalls).toHaveLength(1);
      expect(spawnClaudeCalls[0].prompt).toContain("CONTEXTE CONVERSATIONNEL");
    });

    it("includes handoff decisions in the prompt", async () => {
      spawnClaudeResults = [
        { stdout: "Spec generated.", stderr: "", exitCode: 0 },
      ];

      const handoff = makeHandoff({ decisions: ["Use REST API", "No websockets"] });
      await runSddSpec("test-feature", handoff, makeBctx());

      expect(spawnClaudeCalls[0].prompt).toContain("Use REST API");
      expect(spawnClaudeCalls[0].prompt).toContain("No websockets");
    });
  });

  // ── V8, V9, V10, V20: runSddChallenge ─────────────────────

  describe("runSddChallenge", () => {
    it("V8: calls spawnClaude 3 times in parallel (Promise.allSettled)", async () => {
      spawnClaudeResults = [
        { stdout: "DA report: all good.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
        { stdout: "EC report: edge case found.\n## Verdict de l'agent: GO_WITH_CHANGES", stderr: "", exitCode: 0 },
        { stdout: "SS report: too complex.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
      ];

      await runSddChallenge("test-feature", makeBctx());
      expect(spawnClaudeCalls).toHaveLength(3);
    });

    it("V9: consolidates 3 reports into adversarial-SPEC-{name}.md", async () => {
      spawnClaudeResults = [
        { stdout: "DA findings here.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
        { stdout: "EC findings here.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
        { stdout: "SS findings here.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
      ];

      await runSddChallenge("test-feature", makeBctx());

      expect(writtenFiles).toHaveLength(1);
      expect(writtenFiles[0].path).toContain("adversarial-SPEC-test-feature.md");
      expect(writtenFiles[0].content).toContain("DA findings");
      expect(writtenFiles[0].content).toContain("EC findings");
      expect(writtenFiles[0].content).toContain("SS findings");
    });

    it("V10: returns most severe verdict (NO-GO > GO_WITH_CHANGES > GO)", async () => {
      spawnClaudeResults = [
        { stdout: "Report 1.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
        { stdout: "Report 2.\n## Verdict de l'agent: NO-GO", stderr: "", exitCode: 0 },
        { stdout: "Report 3.\n## Verdict de l'agent: GO_WITH_CHANGES", stderr: "", exitCode: 0 },
      ];

      const result = await runSddChallenge("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_CHALLENGE_NO-GO:/);
    });

    it("V10: GO_WITH_CHANGES is more severe than GO", async () => {
      spawnClaudeResults = [
        { stdout: "Report 1.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
        { stdout: "Report 2.\n## Verdict de l'agent: GO_WITH_CHANGES", stderr: "", exitCode: 0 },
        { stdout: "Report 3.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
      ];

      const result = await runSddChallenge("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_CHALLENGE_GO_WITH_CHANGES:/);
    });

    it("F-EC-2: uses Promise.allSettled — failed agents are documented as AGENT CRASH", async () => {
      spawnClaudeResults = [
        { stdout: "DA report ok.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "Agent crashed", exitCode: 1 },
        { stdout: "SS report ok.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
      ];

      const result = await runSddChallenge("test-feature", makeBctx());

      // Should not be FAILED since 2/3 agents succeeded
      expect(result).not.toMatch(/^SDD_CHALLENGE_FAILED:/);

      // Consolidated report should mention the crash
      expect(writtenFiles).toHaveLength(1);
      expect(writtenFiles[0].content).toContain("AGENT CRASH");
    });

    it("returns SDD_CHALLENGE_FAILED when all 3 agents fail", async () => {
      spawnClaudeResults = [
        { stdout: "", stderr: "Error 1", exitCode: 1 },
        { stdout: "", stderr: "Error 2", exitCode: 1 },
        { stdout: "", stderr: "Error 3", exitCode: 1 },
      ];

      const result = await runSddChallenge("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_CHALLENGE_FAILED:/);
    });

    it("V20: saves report to docs/reviews/adversarial-SPEC-{name}.md", async () => {
      spawnClaudeResults = [
        { stdout: "DA ok.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
        { stdout: "EC ok.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
        { stdout: "SS ok.\n## Verdict de l'agent: GO", stderr: "", exitCode: 0 },
      ];

      await runSddChallenge("test-feature", makeBctx());

      expect(writtenFiles).toHaveLength(1);
      expect(writtenFiles[0].path).toMatch(/docs\/reviews\/adversarial-SPEC-test-feature\.md$/);
    });

    it("derives verdict from BLOQUANT/MAJEUR/MINEUR when no explicit verdict", async () => {
      spawnClaudeResults = [
        { stdout: "Finding [BLOQUANT]: critical issue", stderr: "", exitCode: 0 },
        { stdout: "Finding [MAJEUR]: important issue", stderr: "", exitCode: 0 },
        { stdout: "Finding [MINEUR]: small issue", stderr: "", exitCode: 0 },
      ];

      const result = await runSddChallenge("test-feature", makeBctx());
      // BLOQUANT maps to NO-GO
      expect(result).toMatch(/^SDD_CHALLENGE_NO-GO:/);
    });
  });

  // ── V11: runSddImplement ───────────────────────────────────

  describe("runSddImplement", () => {
    it("V11: passes useWorktree: true to spawnClaude", async () => {
      spawnClaudeResults = [
        {
          stdout: "Implementation complete. PR#42 created.",
          stderr: "",
          exitCode: 0,
        },
      ];

      await runSddImplement("test-feature", makeBctx());

      expect(spawnClaudeCalls).toHaveLength(1);
      expect(spawnClaudeCalls[0].options.useWorktree).toBe(true);
    });

    it("returns SDD_IMPLEMENT_OK on success", async () => {
      spawnClaudeResults = [
        {
          stdout: "Implementation complete.",
          stderr: "",
          exitCode: 0,
        },
      ];

      const result = await runSddImplement("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_IMPLEMENT_OK:/);
    });

    it("V19: returns SDD_IMPLEMENT_FAILED on error", async () => {
      spawnClaudeResults = [
        { stdout: "", stderr: "Build failed", exitCode: 1 },
      ];

      const result = await runSddImplement("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_IMPLEMENT_FAILED:/);
    });

    it("includes spec and adversarial references in prompt", async () => {
      spawnClaudeResults = [
        { stdout: "Done.", stderr: "", exitCode: 0 },
      ];

      await runSddImplement("test-feature", makeBctx());

      expect(spawnClaudeCalls[0].prompt).toContain("SPEC-test-feature.md");
      expect(spawnClaudeCalls[0].prompt).toContain("adversarial-SPEC-test-feature.md");
    });
  });

  // ── runSddReview ───────────────────────────────────────────

  describe("runSddReview", () => {
    it("returns SDD_REVIEW_OK on success", async () => {
      spawnClaudeResults = [
        { stdout: "Review complete. No issues.", stderr: "", exitCode: 0 },
      ];

      const result = await runSddReview("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_REVIEW_OK:/);
    });

    it("V19: returns SDD_REVIEW_FAILED on error", async () => {
      spawnClaudeResults = [
        { stdout: "", stderr: "Review error", exitCode: 1 },
      ];

      const result = await runSddReview("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_REVIEW_FAILED:/);
    });
  });
});
