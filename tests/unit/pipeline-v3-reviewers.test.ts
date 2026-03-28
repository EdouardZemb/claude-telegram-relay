/**
 * Unit Tests — src/pipeline-v3/reviewers.ts
 *
 * V-criteria covered:
 * V1: extractReviewerVerdict extracts APPROVED/CHANGES_REQUESTED correctly
 * V2: extractReviewerVerdict fail-closed (F-TC-2) — no verdict = CHANGES_REQUESTED
 * V3: extractVeto only detects veto for security role
 * V4: computePanelVerdict quorum 2/3 logic
 * V5: computePanelVerdict veto overrides quorum
 * V6: buildReviewPrompt includes all required elements
 * V7: runReviewPanel spawns 3 agents and collects verdicts
 * V8: Agent crash = fail-closed CHANGES_REQUESTED
 * V9: All agents fail = panel CHANGES_REQUESTED
 * V10: Panel with mixed verdicts and quorum
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  _setSpawnHookForTests,
  buildReviewPrompt,
  computePanelVerdict,
  extractReviewerVerdict,
  extractVeto,
  runReviewPanel,
} from "../../src/pipeline-v3/reviewers.ts";
import type { ReviewerFinding, ReviewerRole, ReviewVerdict } from "../../src/pipeline-v3/types.ts";

describe("pipeline-v3/reviewers", () => {
  afterEach(() => {
    _setSpawnHookForTests(undefined);
  });

  // ── extractReviewerVerdict ──────────────────────────────────

  describe("extractReviewerVerdict", () => {
    it("V1: extracts APPROVED", () => {
      expect(extractReviewerVerdict("Some analysis...\nVERDICT: APPROVED")).toBe("APPROVED");
    });

    it("V1: extracts CHANGES_REQUESTED", () => {
      expect(extractReviewerVerdict("Issues found\nVERDICT: CHANGES_REQUESTED")).toBe(
        "CHANGES_REQUESTED",
      );
    });

    it("V1: uses last occurrence (F-EC-1 pattern)", () => {
      const output =
        "The V-criteria say VERDICT: APPROVED in the spec.\nBut actually:\nVERDICT: CHANGES_REQUESTED";
      expect(extractReviewerVerdict(output)).toBe("CHANGES_REQUESTED");
    });

    it("V1: case insensitive", () => {
      expect(extractReviewerVerdict("verdict: approved")).toBe("APPROVED");
      expect(extractReviewerVerdict("Verdict: Changes_Requested")).toBe("CHANGES_REQUESTED");
    });

    it("V2: fail-closed — no verdict found returns CHANGES_REQUESTED (F-TC-2)", () => {
      expect(extractReviewerVerdict("")).toBe("CHANGES_REQUESTED");
      expect(extractReviewerVerdict("Some random text without a verdict line")).toBe(
        "CHANGES_REQUESTED",
      );
    });

    it("V2: fail-closed — partial match not accepted", () => {
      expect(extractReviewerVerdict("VERDICT: MAYBE")).toBe("CHANGES_REQUESTED");
      expect(extractReviewerVerdict("VERDICT: GO")).toBe("CHANGES_REQUESTED");
    });
  });

  // ── extractVeto ─────────────────────────────────────────────

  describe("extractVeto", () => {
    it("V3: detects veto for security role", () => {
      expect(extractVeto("VETO: SQL injection found", "security")).toBe(true);
    });

    it("V3: no veto when not present", () => {
      expect(extractVeto("All looks good\nVERDICT: APPROVED", "security")).toBe(false);
    });

    it("V3: ignores veto for non-security roles", () => {
      expect(extractVeto("VETO: something", "performance")).toBe(false);
      expect(extractVeto("VETO: something", "architecture")).toBe(false);
    });

    it("V3: case insensitive veto detection", () => {
      expect(extractVeto("veto: Critical issue", "security")).toBe(true);
    });
  });

  // ── computePanelVerdict ─────────────────────────────────────

  describe("computePanelVerdict", () => {
    function makeFinding(
      role: ReviewerRole,
      verdict: ReviewVerdict,
      veto = false,
    ): ReviewerFinding {
      return { role, verdict, findings: `${role} analysis`, veto };
    }

    it("V4: quorum 3/3 APPROVED = APPROVED", () => {
      const panel = computePanelVerdict([
        makeFinding("security", "APPROVED"),
        makeFinding("performance", "APPROVED"),
        makeFinding("architecture", "APPROVED"),
      ]);
      expect(panel.verdict).toBe("APPROVED");
      expect(panel.approvedCount).toBe(3);
      expect(panel.vetoed).toBe(false);
    });

    it("V4: quorum 2/3 APPROVED = APPROVED", () => {
      const panel = computePanelVerdict([
        makeFinding("security", "APPROVED"),
        makeFinding("performance", "CHANGES_REQUESTED"),
        makeFinding("architecture", "APPROVED"),
      ]);
      expect(panel.verdict).toBe("APPROVED");
      expect(panel.approvedCount).toBe(2);
    });

    it("V4: quorum 1/3 APPROVED = CHANGES_REQUESTED", () => {
      const panel = computePanelVerdict([
        makeFinding("security", "APPROVED"),
        makeFinding("performance", "CHANGES_REQUESTED"),
        makeFinding("architecture", "CHANGES_REQUESTED"),
      ]);
      expect(panel.verdict).toBe("CHANGES_REQUESTED");
      expect(panel.approvedCount).toBe(1);
    });

    it("V4: quorum 0/3 APPROVED = CHANGES_REQUESTED", () => {
      const panel = computePanelVerdict([
        makeFinding("security", "CHANGES_REQUESTED"),
        makeFinding("performance", "CHANGES_REQUESTED"),
        makeFinding("architecture", "CHANGES_REQUESTED"),
      ]);
      expect(panel.verdict).toBe("CHANGES_REQUESTED");
      expect(panel.approvedCount).toBe(0);
    });

    it("V5: veto overrides quorum (security vetoes despite 3/3 approved)", () => {
      const panel = computePanelVerdict([
        makeFinding("security", "APPROVED", true), // veto exercised
        makeFinding("performance", "APPROVED"),
        makeFinding("architecture", "APPROVED"),
      ]);
      expect(panel.verdict).toBe("CHANGES_REQUESTED");
      expect(panel.vetoed).toBe(true);
      expect(panel.approvedCount).toBe(3);
    });

    it("V10: changeRequests consolidates rejected findings", () => {
      const panel = computePanelVerdict([
        makeFinding("security", "APPROVED"),
        makeFinding("performance", "CHANGES_REQUESTED"),
        makeFinding("architecture", "CHANGES_REQUESTED"),
      ]);
      expect(panel.changeRequests).toContain("PERFORMANCE");
      expect(panel.changeRequests).toContain("ARCHITECTURE");
      expect(panel.changeRequests).not.toContain("SECURITY");
    });

    it("V4: APPROVED verdict has empty changeRequests", () => {
      const panel = computePanelVerdict([
        makeFinding("security", "APPROVED"),
        makeFinding("performance", "APPROVED"),
        makeFinding("architecture", "APPROVED"),
      ]);
      expect(panel.changeRequests).toBe("");
    });
  });

  // ── buildReviewPrompt ───────────────────────────────────────

  describe("buildReviewPrompt", () => {
    it("V6: includes spec path and branch name", () => {
      const prompt = buildReviewPrompt(
        "security",
        "docs/specs/SPEC-test.md",
        "feature/test",
        undefined,
        "",
      );
      expect(prompt).toContain("docs/specs/SPEC-test.md");
      expect(prompt).toContain("feature/test");
    });

    it("V6: includes PR URL when provided", () => {
      const prompt = buildReviewPrompt(
        "security",
        "spec.md",
        "branch",
        "https://github.com/repo/pull/42",
        "",
      );
      expect(prompt).toContain("https://github.com/repo/pull/42");
    });

    it("V6: includes previous findings when provided", () => {
      const prompt = buildReviewPrompt("security", "spec.md", "branch", undefined, "Fix the XSS");
      expect(prompt).toContain("Fix the XSS");
      expect(prompt).toContain("précédentes");
    });

    it("V6: security role includes veto instruction", () => {
      const prompt = buildReviewPrompt("security", "spec.md", "branch", undefined, "");
      expect(prompt).toContain("VETO");
    });

    it("V6: non-security roles do not include veto instruction", () => {
      const prompt = buildReviewPrompt("performance", "spec.md", "branch", undefined, "");
      expect(prompt).not.toContain("VETO");

      const prompt2 = buildReviewPrompt("architecture", "spec.md", "branch", undefined, "");
      expect(prompt2).not.toContain("VETO");
    });

    it("V6: includes verdict format instruction", () => {
      const prompt = buildReviewPrompt("architecture", "spec.md", "branch", undefined, "");
      expect(prompt).toContain("VERDICT: APPROVED");
      expect(prompt).toContain("VERDICT: CHANGES_REQUESTED");
    });
  });

  // ── runReviewPanel ──────────────────────────────────────────

  describe("runReviewPanel", () => {
    it("V7: spawns 3 agents and returns panel verdict", async () => {
      const calls: string[] = [];
      _setSpawnHookForTests(async (opts) => {
        calls.push(opts.prompt);
        return { stdout: "All good.\nVERDICT: APPROVED", stderr: "", exitCode: 0 };
      });

      const panel = await runReviewPanel("spec.md", "branch", undefined, "");

      expect(calls.length).toBe(3);
      expect(panel.verdict).toBe("APPROVED");
      expect(panel.approvedCount).toBe(3);
      expect(panel.totalResponded).toBe(3);
      expect(panel.findings.length).toBe(3);
    });

    it("V8: agent crash results in CHANGES_REQUESTED for that agent", async () => {
      let callIdx = 0;
      _setSpawnHookForTests(async () => {
        callIdx++;
        if (callIdx === 1) {
          // security crashes
          return { stdout: "", stderr: "OOM", exitCode: 1 };
        }
        return { stdout: "Fine.\nVERDICT: APPROVED", stderr: "", exitCode: 0 };
      });

      const panel = await runReviewPanel("spec.md", "branch", undefined, "");

      // Security crashed -> CHANGES_REQUESTED, others approved
      expect(panel.findings[0].verdict).toBe("CHANGES_REQUESTED");
      expect(panel.findings[1].verdict).toBe("APPROVED");
      expect(panel.findings[2].verdict).toBe("APPROVED");
      // Quorum 2/3 = APPROVED (crashed security doesn't veto unless it explicitly vetoes)
      expect(panel.approvedCount).toBe(2);
      expect(panel.verdict).toBe("APPROVED");
    });

    it("V9: all agents fail = panel CHANGES_REQUESTED", async () => {
      _setSpawnHookForTests(async () => {
        return { stdout: "", stderr: "error", exitCode: 1 };
      });

      const panel = await runReviewPanel("spec.md", "branch", undefined, "");

      expect(panel.verdict).toBe("CHANGES_REQUESTED");
      expect(panel.approvedCount).toBe(0);
    });

    it("V10: mixed verdicts with quorum", async () => {
      let callIdx = 0;
      _setSpawnHookForTests(async () => {
        callIdx++;
        if (callIdx <= 2) {
          return { stdout: "Good.\nVERDICT: APPROVED", stderr: "", exitCode: 0 };
        }
        return {
          stdout: "Bad patterns.\nVERDICT: CHANGES_REQUESTED",
          stderr: "",
          exitCode: 0,
        };
      });

      const panel = await runReviewPanel("spec.md", "branch", undefined, "");

      expect(panel.approvedCount).toBe(2);
      expect(panel.verdict).toBe("APPROVED");
    });

    it("V5: security veto blocks merge even with quorum", async () => {
      let callIdx = 0;
      _setSpawnHookForTests(async () => {
        callIdx++;
        if (callIdx === 1) {
          // Security: approved but vetoes
          return {
            stdout: "SQL injection found\nVETO: Critical SQL injection\nVERDICT: APPROVED",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "Fine.\nVERDICT: APPROVED", stderr: "", exitCode: 0 };
      });

      const panel = await runReviewPanel("spec.md", "branch", undefined, "");

      expect(panel.vetoed).toBe(true);
      expect(panel.verdict).toBe("CHANGES_REQUESTED");
    });

    it("V8: agent exception results in CHANGES_REQUESTED", async () => {
      let callIdx = 0;
      _setSpawnHookForTests(async () => {
        callIdx++;
        if (callIdx === 1) throw new Error("Network timeout");
        return { stdout: "Fine.\nVERDICT: APPROVED", stderr: "", exitCode: 0 };
      });

      const panel = await runReviewPanel("spec.md", "branch", undefined, "");

      expect(panel.findings[0].verdict).toBe("CHANGES_REQUESTED");
      expect(panel.findings[0].findings).toContain("exception");
    });
  });
});
