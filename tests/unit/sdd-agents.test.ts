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

// biome-ignore lint/suspicious/noExplicitAny: test mock
const spawnClaudeCalls: Array<{ prompt: string; systemPrompt?: string; options: any }> = [];
let spawnClaudeResults: Array<{ stdout: string; stderr: string; exitCode: number }> = [];
let spawnCallIndex = 0;

// Mock the agent module
mock.module("../../src/agent.ts", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  spawnClaude: async (opts: any) => {
    spawnClaudeCalls.push({ prompt: opts.prompt, systemPrompt: opts.systemPrompt, options: opts });
    const result = spawnClaudeResults[spawnCallIndex] || {
      stdout: "",
      stderr: "no mock",
      exitCode: 1,
    };
    spawnCallIndex++;
    return result;
  },
}));

// Track writeFile calls without global mock — use the test hook exported by sdd-agents
const writtenFiles: Array<{ path: string; content: string }> = [];

import type { HandoffSummary } from "../../src/conversation-handoff.ts";
// Now import the module under test
import {
  runSddChallenge,
  runSddDoc,
  runSddExplore,
  runSddImplement,
  runSddReview,
  runSddSpec,
  setSpawnSyncHook,
  setWriteFileHook,
} from "../../src/sdd-agents.ts";

// Install the hook once at module level — captures writes into writtenFiles
setWriteFileHook(async (path: string, content: string) => {
  writtenFiles.push({ path, content });
});

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

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeBctx(): any {
  return {
    supabase: null,
    sendResponse: async () => {},
    callClaude: async () => "",
  };
}

// ── Setup / Teardown ─────────────────────────────────────────

// Track spawnSync calls (for VC8)
const spawnSyncCalls: string[][] = [];

beforeEach(() => {
  spawnClaudeCalls.length = 0;
  spawnClaudeResults = [];
  spawnCallIndex = 0;
  writtenFiles.length = 0;
  spawnSyncCalls.length = 0;
  // Install spawnSync hook
  setSpawnSyncHook((args) => {
    spawnSyncCalls.push(args);
    return { exitCode: 0 };
  });
});

afterEach(() => {
  setSpawnSyncHook(undefined);
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
      spawnClaudeResults = [{ stdout: "## Verdict\nGO\n\nDone.", stderr: "", exitCode: 0 }];

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
      spawnClaudeResults = [{ stdout: "", stderr: "Spec generation failed", exitCode: 1 }];

      const result = await runSddSpec("test-feature", makeHandoff(), makeBctx());
      expect(result).toMatch(/^SDD_SPEC_FAILED:/);
    });

    it("V7: includes CONTEXTE CONVERSATIONNEL section in prompt", async () => {
      spawnClaudeResults = [{ stdout: "Spec generated.", stderr: "", exitCode: 0 }];

      await runSddSpec("test-feature", makeHandoff(), makeBctx());

      expect(spawnClaudeCalls).toHaveLength(1);
      expect(spawnClaudeCalls[0].prompt).toContain("CONTEXTE CONVERSATIONNEL");
    });

    it("includes handoff decisions in the prompt", async () => {
      spawnClaudeResults = [{ stdout: "Spec generated.", stderr: "", exitCode: 0 }];

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
        {
          stdout: "EC report: edge case found.\n## Verdict de l'agent: GO_WITH_CHANGES",
          stderr: "",
          exitCode: 0,
        },
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
      spawnClaudeResults = [{ stdout: "", stderr: "Build failed", exitCode: 1 }];

      const result = await runSddImplement("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_IMPLEMENT_FAILED:/);
    });

    it("includes spec and adversarial references in prompt", async () => {
      spawnClaudeResults = [{ stdout: "Done.", stderr: "", exitCode: 0 }];

      await runSddImplement("test-feature", makeBctx());

      expect(spawnClaudeCalls[0].prompt).toContain("SPEC-test-feature.md");
      expect(spawnClaudeCalls[0].prompt).toContain("adversarial-SPEC-test-feature.md");
    });
  });

  // ── runSddReview ───────────────────────────────────────────

  describe("runSddReview", () => {
    it("defaults to CHANGES_REQUESTED when no explicit verdict", async () => {
      spawnClaudeResults = [{ stdout: "Review complete. No issues.", stderr: "", exitCode: 0 }];

      const result = await runSddReview("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_REVIEW_CHANGES_REQUESTED:/);
    });

    it("V19: returns SDD_REVIEW_FAILED on error", async () => {
      spawnClaudeResults = [{ stdout: "", stderr: "Review error", exitCode: 1 }];

      const result = await runSddReview("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_REVIEW_FAILED:/);
    });

    it("VC7: returns SDD_REVIEW_APPROVED when stdout contains 'VERDICT: APPROVED'", async () => {
      spawnClaudeResults = [
        { stdout: "Conformite verifiee.\nVERDICT: APPROVED", stderr: "", exitCode: 0 },
      ];

      const result = await runSddReview("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_REVIEW_APPROVED:/);
    });

    it("VC7: returns SDD_REVIEW_CHANGES_REQUESTED when stdout contains 'VERDICT: CHANGES_REQUESTED'", async () => {
      spawnClaudeResults = [
        {
          stdout: "Des corrections sont requises.\nVERDICT: CHANGES_REQUESTED",
          stderr: "",
          exitCode: 0,
        },
      ];

      const result = await runSddReview("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_REVIEW_CHANGES_REQUESTED:/);
    });

    it("VC7: defaults to CHANGES_REQUESTED when no VERDICT found (conservative)", async () => {
      spawnClaudeResults = [
        { stdout: "Review complete. No explicit verdict.", stderr: "", exitCode: 0 },
      ];

      const result = await runSddReview("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_REVIEW_CHANGES_REQUESTED:/);
    });

    it("VC7: uses LAST occurrence of VERDICT to avoid false positives (F-EC-1)", async () => {
      // First occurrence is quoted in criteria, last is the real verdict
      spawnClaudeResults = [
        {
          stdout:
            "Si l'implementation passe, le verdict attendu est VERDICT: APPROVED\nMais en realite des bugs sont trouves.\nVERDICT: CHANGES_REQUESTED",
          stderr: "",
          exitCode: 0,
        },
      ];

      const result = await runSddReview("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_REVIEW_CHANGES_REQUESTED:/);
    });

    it("VC8: calls gh pr review --approve when verdict APPROVED and prUrl provided", async () => {
      process.env.GITHUB_REPO = "owner/repo";
      spawnClaudeResults = [{ stdout: "All good.\nVERDICT: APPROVED", stderr: "", exitCode: 0 }];

      const result = await runSddReview(
        "test-feature",
        makeBctx(),
        "https://github.com/owner/repo/pull/42",
      );

      expect(result).toMatch(/^SDD_REVIEW_APPROVED:/);
      expect(spawnSyncCalls).toHaveLength(1);
      expect(spawnSyncCalls[0][0]).toBe("gh");
      expect(spawnSyncCalls[0][1]).toBe("pr");
      expect(spawnSyncCalls[0][2]).toBe("review");
      expect(spawnSyncCalls[0][3]).toBe("42");
      expect(spawnSyncCalls[0]).toContain("--approve");

      delete process.env.GITHUB_REPO;
    });

    it("VC8: does NOT call gh pr review when verdict CHANGES_REQUESTED", async () => {
      process.env.GITHUB_REPO = "owner/repo";
      spawnClaudeResults = [
        { stdout: "Issues found.\nVERDICT: CHANGES_REQUESTED", stderr: "", exitCode: 0 },
      ];

      await runSddReview("test-feature", makeBctx(), "https://github.com/owner/repo/pull/42");

      expect(spawnSyncCalls).toHaveLength(0);
      delete process.env.GITHUB_REPO;
    });

    it("VC8: does NOT call gh pr review when GITHUB_REPO is empty (F-DA-3)", async () => {
      delete process.env.GITHUB_REPO;
      spawnClaudeResults = [{ stdout: "All good.\nVERDICT: APPROVED", stderr: "", exitCode: 0 }];

      const result = await runSddReview(
        "test-feature",
        makeBctx(),
        "https://github.com/owner/repo/pull/42",
      );

      expect(result).toMatch(/^SDD_REVIEW_APPROVED:/);
      expect(spawnSyncCalls).toHaveLength(0);
    });

    it("VC8: does NOT call gh pr review when prUrl is absent", async () => {
      process.env.GITHUB_REPO = "owner/repo";
      spawnClaudeResults = [{ stdout: "All good.\nVERDICT: APPROVED", stderr: "", exitCode: 0 }];

      await runSddReview("test-feature", makeBctx());

      expect(spawnSyncCalls).toHaveLength(0);
      delete process.env.GITHUB_REPO;
    });
  });

  // ── runSddDoc ─────────────────────────────────────────────

  describe("runSddDoc", () => {
    it("V6: returns SDD_DOC_OK when spawnClaude returns exitCode=0 and stdout non-empty", async () => {
      spawnClaudeResults = [
        { stdout: "Documentation updated. CLAUDE.md revised.", stderr: "", exitCode: 0 },
      ];

      const result = await runSddDoc("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_DOC_OK:/);
    });

    it("V7: returns SDD_DOC_FAILED when spawnClaude returns exitCode!=0", async () => {
      spawnClaudeResults = [{ stdout: "", stderr: "timeout", exitCode: 1 }];

      const result = await runSddDoc("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_DOC_FAILED:/);
    });

    it("V7b: returns SDD_DOC_FAILED when spawnClaude returns empty stdout with exitCode=0", async () => {
      spawnClaudeResults = [{ stdout: "", stderr: "", exitCode: 0 }];

      const result = await runSddDoc("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_DOC_FAILED:/);
    });

    it("V8: returns SDD_DOC_FAILED when spawnClaude throws exception", async () => {
      // Override mock to throw
      mock.module("../../src/agent.ts", () => ({
        spawnClaude: async () => {
          throw new Error("network error");
        },
      }));

      const result = await runSddDoc("test-feature", makeBctx());
      expect(result).toMatch(/^SDD_DOC_FAILED:/);

      // Restore normal mock
      mock.module("../../src/agent.ts", () => ({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        spawnClaude: async (opts: any) => {
          spawnClaudeCalls.push({
            prompt: opts.prompt,
            systemPrompt: opts.systemPrompt,
            options: opts,
          });
          const result = spawnClaudeResults[spawnCallIndex] || {
            stdout: "",
            stderr: "no mock",
            exitCode: 1,
          };
          spawnCallIndex++;
          return result;
        },
      }));
    });

    it("V9: prompt passed to spawnClaude contains pipeline name", async () => {
      spawnClaudeResults = [{ stdout: "Doc updated.", stderr: "", exitCode: 0 }];

      await runSddDoc("test-feature", makeBctx());

      expect(spawnClaudeCalls).toHaveLength(1);
      expect(spawnClaudeCalls[0].prompt).toContain("test-feature");
    });

    it("result message contains pipeline name", async () => {
      spawnClaudeResults = [{ stdout: "Documentation done.", stderr: "", exitCode: 0 }];

      const result = await runSddDoc("my-pipeline", makeBctx());
      expect(result).toContain("my-pipeline");
    });
  });
});
