/**
 * Unit Tests — Trust Score + Gate Evaluator Integration (S35)
 *
 * Tests for evaluateAndRework trust score updates,
 * auto-approval logic, and double-loop feedback context.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  evaluateAndRework,
  type GateEvaluation,
} from "../../src/gate-evaluator";
import {
  getCachedTrustScore,
  resetTrustScoreCache,
  updateTrustScore,
  shouldAutoApprove,
} from "../../src/trust-scores";
import { buildFeedbackContext } from "../../src/feedback-loop";

beforeEach(() => {
  resetTrustScoreCache();
});

// ── evaluateAndRework trust score updates ─────────────────────

describe("evaluateAndRework with trust scores", () => {
  it("updates trust score on pass without rework (AC-010)", async () => {
    const result = await evaluateAndRework(
      null,
      "session-trust-1",
      "dev",
      "implementation",
      { code: "good" },
      async () => ({ code: "reworked" }),
      {
        maxIterations: 2,
        customEvaluator: async () => ({
          pass: true, score: 85, issues: [], gate_name: "implementation",
        }),
      }
    );

    expect(result.finalEvaluation.pass).toBe(true);
    expect(result.passedAtIteration).toBe(0);

    // Wait a tick for async trust update
    await new Promise((resolve) => setTimeout(resolve, 50));
    const trust = getCachedTrustScore("dev");
    expect(trust.score).toBe(55); // 50 + 5
    expect(trust.consecutivePasses).toBe(1);
  });

  it("updates trust score on pass with rework", async () => {
    let evalCount = 0;
    const result = await evaluateAndRework(
      null,
      "session-trust-2",
      "pm",
      "tasks",
      { tasks: [] },
      async () => ({ tasks: ["reworked"] }),
      {
        maxIterations: 2,
        customEvaluator: async () => {
          evalCount++;
          if (evalCount === 1) {
            return { pass: false, score: 40, issues: [{ severity: "major", description: "Bad", suggestion: "Fix" }], gate_name: "tasks" };
          }
          return { pass: true, score: 75, issues: [], gate_name: "tasks" };
        },
      }
    );

    expect(result.finalEvaluation.pass).toBe(true);
    expect(result.passedAtIteration).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const trust = getCachedTrustScore("pm");
    expect(trust.score).toBe(51); // 50 + 1 (pass with rework)
  });

  it("updates trust score on failure after max rework", async () => {
    const result = await evaluateAndRework(
      null,
      "session-trust-3",
      "architect",
      "plan",
      { plan: "bad" },
      async () => ({ plan: "still bad" }),
      {
        maxIterations: 1,
        customEvaluator: async () => ({
          pass: false, score: 30, issues: [{ severity: "critical", description: "Poor", suggestion: "Redo" }], gate_name: "plan",
        }),
      }
    );

    expect(result.finalEvaluation.pass).toBe(false);
    expect(result.passedAtIteration).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));
    const trust = getCachedTrustScore("architect");
    expect(trust.score).toBe(40); // 50 - 10
    expect(trust.consecutiveFailures).toBe(1);
  });

  it("preserves backward compatibility with number maxIterations", async () => {
    const result = await evaluateAndRework(
      null,
      "session-compat",
      "qa",
      "spec",
      { spec: "ok" },
      async () => ({ spec: "reworked" }),
      2, // legacy number format
      async () => ({ pass: true, score: 80, issues: [], gate_name: "spec" }) // legacy customEvaluator
    );

    expect(result.finalEvaluation.pass).toBe(true);
  });
});

// ── Auto-approval flow ───────────────────────────────────────

describe("auto-approval trust score progression", () => {
  it("builds trust from 50 to 70 for dev spec auto-approval (S42 per-role)", async () => {
    // S42: dev specAutoApprove = 70 (lower than global 80 because dev output is verified by tests)
    // 4 consecutive passes: 50 + 4*5 = 70
    for (let i = 0; i < 4; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    const trust = getCachedTrustScore("dev");
    expect(trust.score).toBe(70);
    expect(trust.consecutivePasses).toBe(4);

    // Spec gate should be auto-approvable for P3 (dev threshold is 70)
    expect(shouldAutoApprove("dev", "spec", 3)).toBe(true);
    // But not implementation (dev needs 85)
    expect(shouldAutoApprove("dev", "implementation", 3)).toBe(false);
  });

  it("builds trust from 50 to 85 for dev impl auto-approval (S42 per-role)", async () => {
    // S42: dev implAutoApprove = 85
    // 7 consecutive passes: 50 + 7*5 = 85
    for (let i = 0; i < 7; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(getCachedTrustScore("dev").score).toBe(85);

    // Implementation gate should now be auto-approvable for P3
    expect(shouldAutoApprove("dev", "implementation", 3)).toBe(true);
  });

  it("drops trust on failure, disabling auto-approval", async () => {
    // Build to 70 (dev specAutoApprove threshold)
    for (let i = 0; i < 4; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(shouldAutoApprove("dev", "spec", 3)).toBe(true);

    // One failure: 70 - 10 = 60
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").score).toBe(60);
    expect(shouldAutoApprove("dev", "spec", 3)).toBe(false);
  });
});

// ── Feedback context with double-loop rules ──────────────────

describe("buildFeedbackContext with double-loop rules", () => {
  it("returns empty string when no rules (baseline)", () => {
    expect(buildFeedbackContext("dev" as any)).toBe("");
  });
});
