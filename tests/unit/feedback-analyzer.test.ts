/**
 * Unit Tests -- src/feedback-analyzer.ts
 *
 * Tests for agent feedback analysis: detect recurring failure patterns
 * from gate evaluations and alerts, then generate overlay suggestions.
 *
 * V-criteria:
 * V1: analyzeAgentFeedback detects recurring NO-GO patterns (>= 3 in 7 days)
 * V2: analyzeAgentFeedback returns empty when no recurring patterns
 * V3: generated overlay text is a short corrective instruction
 * V4: analyzeAgentFeedback groups failures by agent role
 * V5: analyzeAgentFeedback respects the recurrence threshold
 * V6: runFeedbackLoop creates overlays from analysis results
 * V7: runFeedbackLoop is gated by prompt_feedback_loop feature flag
 * V8: runFeedbackLoop expires old overlays before creating new ones
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

// Set RELAY_DIR before imports
const TEST_DIR = join(import.meta.dir, "../../.test-feedback-analyzer-" + process.pid);
process.env.RELAY_DIR = TEST_DIR;

import {
  _setDependencies,
  type AgentFeedbackSignal,
  analyzeAgentFeedback,
  generateOverlayText,
  runFeedbackLoop,
} from "../../src/feedback-analyzer.ts";

import { _resetForTests } from "../../src/prompt-overlay.ts";

// ── Setup / Teardown ─────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  _resetForTests();
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

// ── analyzeAgentFeedback Tests ──────────────────────────────

describe("feedback-analyzer — analyzeAgentFeedback", () => {
  it("V1: detects recurring failures (>= 3 NO-GO) for an agent role", () => {
    const signals: AgentFeedbackSignal[] = [
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
    ];

    const results = analyzeAgentFeedback(signals);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].agentRole).toBe("spec-architect");
    expect(results[0].failureCount).toBe(3);
  });

  it("V2: returns empty when no recurring patterns", () => {
    const signals: AgentFeedbackSignal[] = [
      {
        agentRole: "spec-architect",
        outcome: "GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
    ];

    const results = analyzeAgentFeedback(signals);
    expect(results).toEqual([]);
  });

  it("V5: respects the recurrence threshold (2 failures is not enough)", () => {
    const signals: AgentFeedbackSignal[] = [
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
    ];

    const results = analyzeAgentFeedback(signals);
    expect(results).toEqual([]);
  });

  it("V4: groups failures by agent role", () => {
    const signals: AgentFeedbackSignal[] = [
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "reviewer",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "review",
      },
      {
        agentRole: "reviewer",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "review",
      },
      {
        agentRole: "reviewer",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "review",
      },
    ];

    const results = analyzeAgentFeedback(signals);
    expect(results.length).toBe(2);
    const roles = results.map((r) => r.agentRole).sort();
    expect(roles).toEqual(["reviewer", "spec-architect"]);
  });

  it("V4: does not mix roles — 2 failures each for 2 roles does not trigger", () => {
    const signals: AgentFeedbackSignal[] = [
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "reviewer",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "review",
      },
      {
        agentRole: "reviewer",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "review",
      },
    ];

    const results = analyzeAgentFeedback(signals);
    expect(results).toEqual([]);
  });

  it("counts GO_WITH_CHANGES as partial failure", () => {
    const signals: AgentFeedbackSignal[] = [
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "GO_WITH_CHANGES",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
    ];

    const results = analyzeAgentFeedback(signals);
    expect(results.length).toBe(1);
  });
});

// ── generateOverlayText Tests ──────────────────────────────

describe("feedback-analyzer — generateOverlayText", () => {
  it("V3: generates a short corrective instruction", () => {
    const text = generateOverlayText("spec-architect", 3, "challenge");
    expect(text).toBeTruthy();
    expect(text.length).toBeGreaterThan(10);
    expect(text.length).toBeLessThan(500);
  });

  it("V3: text mentions the failure pattern", () => {
    const text = generateOverlayText("spec-architect", 4, "challenge");
    // Should mention something about the pattern
    expect(text.toLowerCase()).toMatch(/(echec|rejet|no-go|challenge|ameliore|evite)/i);
  });

  it("V3: text differs by source type", () => {
    const challengeText = generateOverlayText("spec-architect", 3, "challenge");
    const reviewText = generateOverlayText("reviewer", 3, "review");
    // Different sources should produce different texts
    expect(challengeText).not.toBe(reviewText);
  });
});

// ── runFeedbackLoop Tests ──────────────────────────────────

describe("feedback-analyzer — runFeedbackLoop", () => {
  it("V7: does nothing when feature flag is off", async () => {
    _setDependencies({
      isFeatureEnabled: () => false,
      fetchSignals: async () => [],
    });

    const result = await runFeedbackLoop();
    expect(result.skipped).toBe(true);
    expect(result.overlaysCreated).toBe(0);
  });

  it("V6: creates overlays when recurring patterns detected", async () => {
    const signals: AgentFeedbackSignal[] = [
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
    ];

    _setDependencies({
      isFeatureEnabled: () => true,
      fetchSignals: async () => signals,
    });

    const result = await runFeedbackLoop();
    expect(result.skipped).toBe(false);
    expect(result.overlaysCreated).toBeGreaterThanOrEqual(1);
  });

  it("V8: expires old overlays during the loop", async () => {
    // Inject dependencies
    _setDependencies({
      isFeatureEnabled: () => true,
      fetchSignals: async () => [],
    });

    const result = await runFeedbackLoop();
    expect(result.skipped).toBe(false);
    expect(result.expiredCount).toBeDefined();
  });

  it("creates no overlays when no recurring patterns", async () => {
    _setDependencies({
      isFeatureEnabled: () => true,
      fetchSignals: async () => [],
    });

    const result = await runFeedbackLoop();
    expect(result.overlaysCreated).toBe(0);
  });

  it("does not create duplicate overlay for same agent+source when existing overlay active", async () => {
    const signals: AgentFeedbackSignal[] = [
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
      {
        agentRole: "spec-architect",
        outcome: "NO-GO",
        timestamp: new Date().toISOString(),
        source: "challenge",
      },
    ];

    _setDependencies({
      isFeatureEnabled: () => true,
      fetchSignals: async () => signals,
    });

    // Run twice — second run should not create duplicate
    await runFeedbackLoop();
    const result2 = await runFeedbackLoop();
    expect(result2.overlaysCreated).toBe(0);
  });
});
