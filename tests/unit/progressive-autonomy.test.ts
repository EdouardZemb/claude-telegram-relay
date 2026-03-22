/**
 * Unit Tests — S42: Progressive Autonomy
 *
 * Tests for per-role trust thresholds, accelerated degradation,
 * autonomy levels, feedback effectiveness, enriched planner,
 * and dashboard endpoint.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getAgent, getAgents } from "../../src/bmad-agents";
import { measureRuleEffectiveness, promoteOrArchiveRules } from "../../src/feedback-loop";
import {
  AUTO_APPROVE_IMPL_THRESHOLD,
  AUTO_APPROVE_SPEC_THRESHOLD,
  formatTrustScores,
  getAutoApproveThresholds,
  getAutonomyLevel,
  getCachedTrustScore,
  resetTrustScoreCache,
  shouldAutoApprove,
  updateTrustScore,
} from "../../src/trust-scores";

beforeEach(() => {
  resetTrustScoreCache();
});

// ── S42-01: Per-role Trust Thresholds ──────────────────────────

describe("S42-01: per-role trust thresholds", () => {
  it("all agents have trustThresholds defined", () => {
    const agents = getAgents();
    for (const agent of agents) {
      expect(agent.trustThresholds).toBeDefined();
      expect(agent.trustThresholds!.specAutoApprove).toBeGreaterThan(0);
      expect(agent.trustThresholds!.implAutoApprove).toBeGreaterThan(0);
      expect(agent.trustThresholds!.implAutoApprove).toBeGreaterThan(
        agent.trustThresholds!.specAutoApprove,
      );
    }
  });

  it("dev has lower spec threshold than qa (outputs verified by tests)", () => {
    const dev = getAgent("dev")!;
    const qa = getAgent("qa")!;
    expect(dev.trustThresholds!.specAutoApprove).toBeLessThan(qa.trustThresholds!.specAutoApprove);
  });

  it("sm has lowest thresholds (low risk role)", () => {
    const sm = getAgent("sm")!;
    const agents = getAgents().filter((a) => a.id !== "sm");
    for (const agent of agents) {
      expect(sm.trustThresholds!.specAutoApprove).toBeLessThanOrEqual(
        agent.trustThresholds!.specAutoApprove,
      );
    }
  });

  it("qa has highest impl threshold (quality gate)", () => {
    const qa = getAgent("qa")!;
    const agents = getAgents().filter((a) => a.id !== "qa");
    for (const agent of agents) {
      expect(qa.trustThresholds!.implAutoApprove).toBeGreaterThanOrEqual(
        agent.trustThresholds!.implAutoApprove,
      );
    }
  });

  it("getAutoApproveThresholds returns per-role values for known agents", () => {
    const devThresholds = getAutoApproveThresholds("dev");
    const dev = getAgent("dev")!;
    expect(devThresholds.spec).toBe(dev.trustThresholds!.specAutoApprove);
    expect(devThresholds.impl).toBe(dev.trustThresholds!.implAutoApprove);
  });

  it("getAutoApproveThresholds returns global fallback for unknown agents", () => {
    const thresholds = getAutoApproveThresholds("unknown_agent");
    expect(thresholds.spec).toBe(AUTO_APPROVE_SPEC_THRESHOLD);
    expect(thresholds.impl).toBe(AUTO_APPROVE_IMPL_THRESHOLD);
  });

  it("dev auto-approves spec at 70 (per-role), not 80 (global)", async () => {
    // Dev specAutoApprove = 70
    for (let i = 0; i < 4; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(getCachedTrustScore("dev").score).toBe(70);
    expect(shouldAutoApprove("dev", "spec", 3)).toBe(true);
  });

  it("pm auto-approves spec at 75 (per-role)", async () => {
    // PM specAutoApprove = 75
    for (let i = 0; i < 5; i++) {
      await updateTrustScore(null, "pm", { passed: true, hadRework: false });
    }
    expect(getCachedTrustScore("pm").score).toBe(75);
    expect(shouldAutoApprove("pm", "spec", 3)).toBe(true);

    // But 70 is not enough for PM
    resetTrustScoreCache();
    for (let i = 0; i < 4; i++) {
      await updateTrustScore(null, "pm", { passed: true, hadRework: false });
    }
    expect(shouldAutoApprove("pm", "spec", 3)).toBe(false);
  });

  it("qa requires 92 for impl auto-approval (strictest)", async () => {
    // QA implAutoApprove = 92
    // 50 + 8*5 = 90 < 92
    for (let i = 0; i < 8; i++) {
      await updateTrustScore(null, "qa", { passed: true, hadRework: false });
    }
    expect(getCachedTrustScore("qa").score).toBe(90);
    expect(shouldAutoApprove("qa", "implementation", 3)).toBe(false);

    // 50 + 9*5 = 95 >= 92
    await updateTrustScore(null, "qa", { passed: true, hadRework: false });
    expect(shouldAutoApprove("qa", "implementation", 3)).toBe(true);
  });
});

// ── S42-01: Accelerated Degradation ───────────────────────────

describe("S42-01: accelerated degradation", () => {
  it("applies normal -10 for first 2 consecutive failures", async () => {
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").score).toBe(40); // 50 - 10

    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").score).toBe(30); // 40 - 10
  });

  it("applies accelerated -20 at 3rd consecutive failure", async () => {
    // First two failures: normal -10 each
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").consecutiveFailures).toBe(2);
    expect(getCachedTrustScore("dev").score).toBe(30);

    // Third failure: accelerated -20
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").score).toBe(10); // 30 - 20
    expect(getCachedTrustScore("dev").consecutiveFailures).toBe(3);
  });

  it("continues accelerated degradation after 3rd failure", async () => {
    // 3 failures: 50 -> 40 -> 30 -> 10
    for (let i = 0; i < 3; i++) {
      await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    }
    expect(getCachedTrustScore("dev").score).toBe(10);

    // 4th failure: still -20
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").score).toBe(0); // 10 - 20 capped at 0
  });

  it("resets to normal degradation after a pass", async () => {
    // 3 failures
    for (let i = 0; i < 3; i++) {
      await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    }

    // One pass resets consecutive failures
    await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    expect(getCachedTrustScore("dev").consecutiveFailures).toBe(0);

    // Next failure is normal -10 again
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").consecutiveFailures).toBe(1);
  });
});

// ── S42-01: Autonomy Levels ────────────────────────────────────

describe("S42-01: getAutonomyLevel", () => {
  it("returns strict for score < 40", async () => {
    // Default score = 50, but push down
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    expect(getCachedTrustScore("dev").score).toBe(30);

    const level = getAutonomyLevel("dev");
    expect(level.level).toBe("strict");
    expect(level.label).toBe("Strict");
  });

  it("returns supervised for 40 <= score < specThreshold", async () => {
    // Default score = 50
    const level = getAutonomyLevel("dev");
    expect(level.level).toBe("supervised");
    expect(level.label).toBe("Supervise");
  });

  it("returns autonomous when score >= specThreshold", async () => {
    // Dev specAutoApprove = 70
    for (let i = 0; i < 4; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    const level = getAutonomyLevel("dev");
    expect(level.level).toBe("autonomous");
    expect(level.label).toBe("Autonomie spec/plan");
  });

  it("returns full when score >= implThreshold", async () => {
    // Dev implAutoApprove = 85
    for (let i = 0; i < 7; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    const level = getAutonomyLevel("dev");
    expect(level.level).toBe("full");
    expect(level.label).toBe("Autonomie totale");
  });

  it("returns supervised for unknown role at default score", () => {
    const level = getAutonomyLevel("unknown");
    expect(level.level).toBe("supervised");
  });
});

// ── S42-01: formatTrustScores with autonomy ───────────────────

describe("S42-01: formatTrustScores with autonomy", () => {
  it("includes autonomy level label in output", async () => {
    await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    const formatted = formatTrustScores();
    expect(formatted).toContain("[Supervise]");
  });

  it("shows full autonomy for high trust", async () => {
    for (let i = 0; i < 7; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    const formatted = formatTrustScores();
    expect(formatted).toContain("[Autonomie totale]");
  });
});

// ── S42-02: Feedback Effectiveness ─────────────────────────────

describe("S42-02: feedback effectiveness", () => {
  it("measureRuleEffectiveness returns empty for agents with no rules", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gte: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    } as any;

    const results = await measureRuleEffectiveness(mockSupabase, "dev" as any);
    expect(results).toEqual([]);
  });

  it("promoteOrArchiveRules handles empty DB", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gte: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    } as any;

    const result = await promoteOrArchiveRules(mockSupabase);
    expect(result.promoted).toEqual([]);
    expect(result.archived).toEqual([]);
  });
});

// ── S42-03: Enriched Planner ──────────────────────────────────

describe("S42-03: enriched planner types", () => {
  it("PlannerRecommendation supports pipeline type", () => {
    const rec = {
      type: "pipeline" as const,
      title: "Pipeline recommande: QUICK",
      description: "Simple task",
      taskIds: ["123"],
      confidence: 0.8,
      suggestedPipeline: "QUICK",
      complexityScore: 2.5,
    };
    expect(rec.type).toBe("pipeline");
    expect(rec.suggestedPipeline).toBe("QUICK");
    expect(rec.complexityScore).toBe(2.5);
  });

  it("PlannerRecommendation supports defer type", () => {
    const rec = {
      type: "defer" as const,
      title: "Differer 2 taches P4/P5",
      description: "Sprint charge",
      taskIds: ["a", "b"],
      confidence: 0.85,
    };
    expect(rec.type).toBe("defer");
  });
});

// ── S42-04: Dashboard Autonomy Status ─────────────────────────

describe("S42-04: dashboard autonomy types", () => {
  it("trust thresholds are valid numbers for all agents", () => {
    const agents = getAgents();
    for (const agent of agents) {
      expect(typeof agent.trustThresholds?.specAutoApprove).toBe("number");
      expect(typeof agent.trustThresholds?.implAutoApprove).toBe("number");
      expect(agent.trustThresholds!.specAutoApprove).toBeGreaterThanOrEqual(60);
      expect(agent.trustThresholds!.specAutoApprove).toBeLessThanOrEqual(100);
      expect(agent.trustThresholds!.implAutoApprove).toBeGreaterThanOrEqual(80);
      expect(agent.trustThresholds!.implAutoApprove).toBeLessThanOrEqual(100);
    }
  });
});

// ── Cross-module Integration ──────────────────────────────────

describe("S42 integration: trust + auto-approval + autonomy", () => {
  it("trust progression through all autonomy levels", async () => {
    // Start: supervised (score 50)
    expect(getAutonomyLevel("dev").level).toBe("supervised");

    // Build to spec threshold (70): autonomous
    for (let i = 0; i < 4; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(getAutonomyLevel("dev").level).toBe("autonomous");
    expect(shouldAutoApprove("dev", "spec", 3)).toBe(true);
    expect(shouldAutoApprove("dev", "implementation", 3)).toBe(false);

    // Build to impl threshold (85): full
    for (let i = 0; i < 3; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(getAutonomyLevel("dev").level).toBe("full");
    expect(shouldAutoApprove("dev", "implementation", 3)).toBe(true);

    // Drop below spec threshold: back to supervised
    for (let i = 0; i < 3; i++) {
      await updateTrustScore(null, "dev", { passed: false, hadRework: true });
    }
    // 85 - 10 - 10 - 20 = 45
    expect(getCachedTrustScore("dev").score).toBe(45);
    expect(getAutonomyLevel("dev").level).toBe("supervised");
    expect(shouldAutoApprove("dev", "spec", 3)).toBe(false);
  });

  it("different roles reach autonomy at different speeds", async () => {
    // SM reaches spec autonomy fastest (threshold 60)
    for (let i = 0; i < 2; i++) {
      await updateTrustScore(null, "sm", { passed: true, hadRework: false });
    }
    expect(getCachedTrustScore("sm").score).toBe(60);
    expect(shouldAutoApprove("sm", "spec", 3)).toBe(true);

    // QA still supervised at same passes (threshold 80)
    for (let i = 0; i < 2; i++) {
      await updateTrustScore(null, "qa", { passed: true, hadRework: false });
    }
    expect(getCachedTrustScore("qa").score).toBe(60);
    expect(shouldAutoApprove("qa", "spec", 3)).toBe(false);
  });

  it("P1/P2 tasks still require full evaluation regardless of trust", async () => {
    // Push dev to max autonomy
    for (let i = 0; i < 10; i++) {
      await updateTrustScore(null, "dev", { passed: true, hadRework: false });
    }
    expect(getCachedTrustScore("dev").score).toBe(100);

    // P1/P2 still blocked
    expect(shouldAutoApprove("dev", "spec", 1)).toBe(false);
    expect(shouldAutoApprove("dev", "spec", 2)).toBe(false);
    expect(shouldAutoApprove("dev", "implementation", 1)).toBe(false);
    expect(shouldAutoApprove("dev", "implementation", 2)).toBe(false);

    // P3+ allowed
    expect(shouldAutoApprove("dev", "spec", 3)).toBe(true);
    expect(shouldAutoApprove("dev", "implementation", 3)).toBe(true);
  });
});
