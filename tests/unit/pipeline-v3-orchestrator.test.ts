/**
 * Unit Tests — src/pipeline-v3/orchestrator.ts
 *
 * V-criteria covered:
 * V1: bridgeSpec reads and returns spec content
 * V2: bridgeSpec throws on empty spec
 * V3: buildImplementPrompt includes spec content and name
 * V4: buildImplementPrompt includes previous change requests when present
 * V5: buildFixPrompt includes change requests and spec content
 * V6: runV3Pipeline happy path: bridge -> implement -> review (APPROVED) -> done
 * V7: runV3Pipeline reflective loop: implement -> review (REJECTED) -> fix -> implement -> review (APPROVED)
 * V8: runV3Pipeline circuit breaker trips after maxIterations
 * V9: runV3Pipeline reports progress at each phase
 * V10: runV3Pipeline bridge failure returns V3_FAILED:bridge
 * V11: runV3Pipeline implement failure returns V3_FAILED:implement
 * V12: runV3Pipeline extracts PR URL from implement output
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  _setReadFileHookForTests,
  _setReviewPanelHookForTests,
  _setSpawnHookForTests,
  bridgeSpec,
  buildFixPrompt,
  buildImplementPrompt,
  runV3Pipeline,
} from "../../src/pipeline-v3/orchestrator.ts";
import type { PanelVerdict } from "../../src/pipeline-v3/types.ts";

describe("pipeline-v3/orchestrator", () => {
  afterEach(() => {
    _setSpawnHookForTests(undefined);
    _setReadFileHookForTests(undefined);
    _setReviewPanelHookForTests(undefined);
  });

  // ── bridgeSpec ──────────────────────────────────────────────

  describe("bridgeSpec", () => {
    it("V1: reads and returns spec content", async () => {
      _setReadFileHookForTests(async () => "# SPEC-UNIFIEE\n\nContent here");
      const content = await bridgeSpec("/path/to/spec.md");
      expect(content).toContain("SPEC-UNIFIEE");
    });

    it("V2: throws on empty spec", async () => {
      _setReadFileHookForTests(async () => "");
      await expect(bridgeSpec("/path/to/spec.md")).rejects.toThrow("empty");
    });

    it("V2: throws on whitespace-only spec", async () => {
      _setReadFileHookForTests(async () => "   \n  \n  ");
      await expect(bridgeSpec("/path/to/spec.md")).rejects.toThrow("empty");
    });

    it("V1: throws on read error", async () => {
      _setReadFileHookForTests(async () => {
        throw new Error("ENOENT");
      });
      await expect(bridgeSpec("/nonexistent")).rejects.toThrow("ENOENT");
    });
  });

  // ── buildImplementPrompt ────────────────────────────────────

  describe("buildImplementPrompt", () => {
    it("V3: includes spec content and name", () => {
      const prompt = buildImplementPrompt("# Spec content", "test-feature", "");
      expect(prompt).toContain("# Spec content");
      expect(prompt).toContain("test-feature");
      expect(prompt).toContain("IMPLEMENTATION V3");
    });

    it("V4: includes previous change requests when present", () => {
      const prompt = buildImplementPrompt("spec", "test", "Fix the SQL injection");
      expect(prompt).toContain("Fix the SQL injection");
      expect(prompt).toContain("CORRECTIONS DEMANDÉES");
    });

    it("V4: no corrections section when empty", () => {
      const prompt = buildImplementPrompt("spec", "test", "");
      expect(prompt).not.toContain("CORRECTIONS DEMANDÉES");
    });
  });

  // ── buildFixPrompt ──────────────────────────────────────────

  describe("buildFixPrompt", () => {
    it("V5: includes change requests and spec content", () => {
      const prompt = buildFixPrompt("my-feature", "Fix XSS", "# Spec");
      expect(prompt).toContain("Fix XSS");
      expect(prompt).toContain("# Spec");
      expect(prompt).toContain("CORRECTIONS V3");
      expect(prompt).toContain("my-feature");
    });
  });

  // ── runV3Pipeline ───────────────────────────────────────────

  describe("runV3Pipeline", () => {
    function makeApprovedPanel(): PanelVerdict {
      return {
        verdict: "APPROVED",
        approvedCount: 3,
        totalResponded: 3,
        vetoed: false,
        findings: [],
        changeRequests: "",
      };
    }

    function makeRejectedPanel(): PanelVerdict {
      return {
        verdict: "CHANGES_REQUESTED",
        approvedCount: 1,
        totalResponded: 3,
        vetoed: false,
        findings: [],
        changeRequests: "Fix the bugs",
      };
    }

    it("V6: happy path — bridge -> implement -> review (APPROVED) -> done", async () => {
      _setReadFileHookForTests(async () => "# SPEC\nV3 implementation");

      _setSpawnHookForTests(async () => ({
        stdout: "Implementation done. https://github.com/repo/pull/42",
        stderr: "",
        exitCode: 0,
      }));

      _setReviewPanelHookForTests(async () => makeApprovedPanel());

      const progressMessages: string[] = [];
      const onProgress = async (msg: string) => {
        progressMessages.push(msg);
      };

      const { result, run } = await runV3Pipeline("mat-1", "test-feature", "/spec.md", onProgress);

      expect(result).toContain("V3_DONE:test-feature");
      expect(result).toContain("pull/42");
      expect(run.finalStatus).toBe("merged");
      expect(run.panelHistory.length).toBe(1);
      expect(run.iteration).toBe(0);
    });

    it("V7: reflective loop — rejected then approved", async () => {
      _setReadFileHookForTests(async () => "# SPEC");

      let implementCalls = 0;
      _setSpawnHookForTests(async (opts) => {
        implementCalls++;
        return {
          stdout: `Implementation iteration ${implementCalls}.\nhttps://github.com/repo/pull/99`,
          stderr: "",
          exitCode: 0,
        };
      });

      let reviewCalls = 0;
      _setReviewPanelHookForTests(async () => {
        reviewCalls++;
        if (reviewCalls === 1) return makeRejectedPanel();
        return makeApprovedPanel();
      });

      const progressMessages: string[] = [];
      const { result, run } = await runV3Pipeline("mat-1", "test-loop", "/spec.md", async (msg) => {
        progressMessages.push(msg);
      });

      expect(result).toContain("V3_DONE:test-loop");
      expect(run.finalStatus).toBe("merged");
      expect(run.panelHistory.length).toBe(2);
      expect(run.iteration).toBe(1);
      // 3 spawn calls: implement(1) + fix(1) + implement(2)
      expect(implementCalls).toBe(3);
    });

    it("V8: circuit breaker trips after maxIterations", async () => {
      _setReadFileHookForTests(async () => "# SPEC");

      _setSpawnHookForTests(async () => ({
        stdout: "Code here.\nhttps://github.com/repo/pull/1",
        stderr: "",
        exitCode: 0,
      }));

      // Always reject
      _setReviewPanelHookForTests(async () => makeRejectedPanel());

      const progressMessages: string[] = [];
      const { result, run } = await runV3Pipeline(
        "mat-1",
        "stuck-feature",
        "/spec.md",
        async (msg) => {
          progressMessages.push(msg);
        },
      );

      expect(result).toContain("V3_CIRCUIT_BREAKER:stuck-feature");
      expect(run.finalStatus).toBe("circuit_breaker");
      // Default max iterations is 3, so we should have 3 panel verdicts
      expect(run.panelHistory.length).toBe(3);
    });

    it("V9: reports progress at each phase", async () => {
      _setReadFileHookForTests(async () => "# SPEC");

      _setSpawnHookForTests(async () => ({
        stdout: "Done.\nhttps://github.com/repo/pull/1",
        stderr: "",
        exitCode: 0,
      }));

      _setReviewPanelHookForTests(async () => makeApprovedPanel());

      const progressMessages: string[] = [];
      await runV3Pipeline("mat-1", "progress-test", "/spec.md", async (msg) => {
        progressMessages.push(msg);
      });

      expect(progressMessages.some((m) => m.includes("Bridge"))).toBe(true);
      expect(progressMessages.some((m) => m.includes("Implementation"))).toBe(true);
      expect(progressMessages.some((m) => m.includes("Panel"))).toBe(true);
    });

    it("V10: bridge failure returns V3_FAILED:bridge", async () => {
      _setReadFileHookForTests(async () => {
        throw new Error("ENOENT");
      });

      const { result, run } = await runV3Pipeline(
        "mat-1",
        "bad-spec",
        "/nonexistent.md",
        async () => {},
      );

      expect(result).toBe("V3_FAILED:bridge:bad-spec");
      expect(run.finalStatus).toBe("failed");
    });

    it("V11: implement failure returns V3_FAILED:implement", async () => {
      _setReadFileHookForTests(async () => "# SPEC");

      _setSpawnHookForTests(async () => ({
        stdout: "",
        stderr: "spawn error",
        exitCode: 1,
      }));

      const { result, run } = await runV3Pipeline("mat-1", "impl-fail", "/spec.md", async () => {});

      expect(result).toBe("V3_FAILED:implement:impl-fail");
      expect(run.finalStatus).toBe("failed");
    });

    it("V12: extracts PR URL from implement output", async () => {
      _setReadFileHookForTests(async () => "# SPEC");

      _setSpawnHookForTests(async () => ({
        stdout: "PR created: https://github.com/owner/repo/pull/42",
        stderr: "",
        exitCode: 0,
      }));

      _setReviewPanelHookForTests(async () => makeApprovedPanel());

      const { run } = await runV3Pipeline("mat-1", "pr-extract", "/spec.md", async () => {});

      expect(run.prUrl).toBe("https://github.com/owner/repo/pull/42");
    });
  });
});
