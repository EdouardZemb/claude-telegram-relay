/**
 * Unit Tests — src/trust-scores.ts (S35)
 *
 * Tests for trust score calculation, auto-approval logic,
 * and formatting.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  formatTrustScores,
  getCachedTrustScore,
  getCachedTrustScores,
  resetTrustScoreCache,
  shouldAutoApprove,
  updateTrustScore,
} from "../../src/trust-scores";

beforeEach(() => {
  resetTrustScoreCache();
});

// ── Trust Score Defaults ─────────────────────────────────────

describe("getCachedTrustScore", () => {
  it("returns default score of 50 for unknown role (AC-009)", () => {
    const score = getCachedTrustScore("dev");
    expect(score.score).toBe(50);
    expect(score.consecutivePasses).toBe(0);
    expect(score.consecutiveFailures).toBe(0);
    expect(score.totalEvaluations).toBe(0);
    expect(score.totalPasses).toBe(0);
  });
});

// ── updateTrustScore ─────────────────────────────────────────

describe("updateTrustScore", () => {
  it("increases score by 5 on pass without rework", async () => {
    const result = await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    expect(result.score).toBe(55); // 50 + 5
    expect(result.consecutivePasses).toBe(1);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.totalEvaluations).toBe(1);
    expect(result.totalPasses).toBe(1);
  });

  it("increases score by 1 on pass with rework", async () => {
    const result = await updateTrustScore(null, "dev", { passed: true, hadRework: true });
    expect(result.score).toBe(51); // 50 + 1
  });

  it("decreases score by 10 on failure", async () => {
    const result = await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(result.score).toBe(40); // 50 - 10
    expect(result.consecutivePasses).toBe(0);
    expect(result.consecutiveFailures).toBe(1);
  });

  it("caps score at 100 (AC-007)", async () => {
    // Push score to 95
    for (let i = 0; i < 9; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    const high = getCachedTrustScore("dev");
    expect(high.score).toBe(95);

    // One more should cap at 100
    const result = await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    expect(result.score).toBe(100);
  });

  it("floors score at 0 (AC-007)", async () => {
    // Push score down
    for (let i = 0; i < 5; i++) {
      await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    }
    const result = getCachedTrustScore("dev");
    expect(result.score).toBe(0); // 50 - 50 = 0
  });

  it("resets consecutive passes on failure (AC-008)", async () => {
    await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    expect(getCachedTrustScore("dev").consecutivePasses).toBe(2);

    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").consecutivePasses).toBe(0);
    expect(getCachedTrustScore("dev").consecutiveFailures).toBe(1);
  });

  it("resets consecutive failures on pass", async () => {
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").consecutiveFailures).toBe(2);

    await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    expect(getCachedTrustScore("dev").consecutiveFailures).toBe(0);
    expect(getCachedTrustScore("dev").consecutivePasses).toBe(1);
  });

  it("tracks total evaluations and passes", async () => {
    await updateTrustScore(null, "qa", { passed: true, hadRework: false });
    await updateTrustScore(null, "qa", { passed: false, hadRework: true });
    await updateTrustScore(null, "qa", { passed: true, hadRework: true });

    const result = getCachedTrustScore("qa");
    expect(result.totalEvaluations).toBe(3);
    expect(result.totalPasses).toBe(2);
  });

  it("handles multiple roles independently", async () => {
    await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    await updateTrustScore(null, "pm", { passed: false, hadRework: true });

    expect(getCachedTrustScore("dev").score).toBe(55);
    expect(getCachedTrustScore("pm").score).toBe(40);
  });
});

// ── shouldAutoApprove ────────────────────────────────────────

describe("shouldAutoApprove", () => {
  it("returns false for P1 tasks regardless of trust score (AC-019)", () => {
    // Set dev trust to 95
    resetTrustScoreCache();
    for (let i = 0; i < 9; i++) {
      updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(shouldAutoApprove("dev", "spec", 1)).toBe(false);
    expect(shouldAutoApprove("dev", "implementation", 1)).toBe(false);
  });

  it("returns false for P2 tasks regardless of trust score", () => {
    resetTrustScoreCache();
    for (let i = 0; i < 9; i++) {
      updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(shouldAutoApprove("dev", "plan", 2)).toBe(false);
  });

  it("returns true for spec gate with trust >= per-role threshold (S42)", async () => {
    // PM specAutoApprove = 75, so 50 + 5*5 = 75
    for (let i = 0; i < 5; i++) {
      await updateTrustScore(null, "pm", { passed: true, hadRework: false });
    }
    expect(shouldAutoApprove("pm", "spec", 3)).toBe(true);
    expect(shouldAutoApprove("pm", "plan", 4)).toBe(true);
    expect(shouldAutoApprove("pm", "tasks", 5)).toBe(true);
  });

  it("returns false for spec gate with trust < per-role threshold", async () => {
    // PM specAutoApprove = 75, score = 55 < 75
    await updateTrustScore(null, "pm", { passed: true, hadRework: false });
    expect(shouldAutoApprove("pm", "spec", 3)).toBe(false);
  });

  it("returns true for implementation gate with trust >= per-role impl threshold (S42)", async () => {
    // Dev implAutoApprove = 85, so 50 + 7*5 = 85
    for (let i = 0; i < 7; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(shouldAutoApprove("dev", "implementation", 3)).toBe(true);
  });

  it("returns false for implementation gate with trust below per-role impl threshold", async () => {
    // Dev implAutoApprove = 85, 50 + 6*5 = 80 < 85
    for (let i = 0; i < 6; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(shouldAutoApprove("dev", "implementation", 3)).toBe(false);
  });

  it("returns false for unknown role (default score 50)", () => {
    expect(shouldAutoApprove("unknown", "spec", 3)).toBe(false);
  });
});

// ── formatTrustScores ────────────────────────────────────────

describe("formatTrustScores", () => {
  it("returns fallback message when no data", () => {
    expect(formatTrustScores()).toBe("Pas de donnees de confiance");
  });

  it("formats trust scores with stats and autonomy level", async () => {
    await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    await updateTrustScore(null, "pm", { passed: false, hadRework: true });

    const formatted = formatTrustScores();
    expect(formatted).toContain("Trust scores par role:");
    expect(formatted).toContain("dev: 55/100");
    expect(formatted).toContain("pm: 40/100");
    // S42: Autonomy labels
    expect(formatted).toContain("[Supervise]");
  });
});

// ── getCachedTrustScores ─────────────────────────────────────

describe("getCachedTrustScores", () => {
  it("returns copy of all cached scores", async () => {
    await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    await updateTrustScore(null, "qa", { passed: true, hadRework: false });

    const scores = getCachedTrustScores();
    expect(Object.keys(scores)).toContain("dev");
    expect(Object.keys(scores)).toContain("qa");
    expect(scores.dev.score).toBe(55);
  });
});
