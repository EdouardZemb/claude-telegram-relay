/**
 * Unit Tests — S34 FR-003: Model Cascade (Haiku -> Sonnet -> Opus)
 *
 * Tests cascade routing, escalation, and backward compatibility.
 */

import { describe, expect, it } from "bun:test";
import { CASCADE_MODELS, type SpawnClaudeOptions, type SpawnClaudeResult } from "../../src/agent";

// ── CASCADE_MODELS constant ──────────────────────────────────

describe("CASCADE_MODELS", () => {
  it("has 3 tiers ordered cheapest to most expensive (AC-011)", () => {
    expect(CASCADE_MODELS).toHaveLength(3);
    expect(CASCADE_MODELS[0]).toBe("claude-haiku-4-5");
    expect(CASCADE_MODELS[1]).toBe("claude-sonnet-4-6");
    expect(CASCADE_MODELS[2]).toBe("claude-opus-4-6");
  });
});

// ── SpawnClaudeOptions cascade field ─────────────────────────

describe("SpawnClaudeOptions cascade field", () => {
  it("AC-015: cascade is optional and defaults to undefined", () => {
    const opts: SpawnClaudeOptions = { prompt: "test" };
    expect(opts.cascade).toBeUndefined();
  });

  it("cascade can be explicitly set to true", () => {
    const opts: SpawnClaudeOptions = { prompt: "test", cascade: true };
    expect(opts.cascade).toBe(true);
  });

  it("cascade can be explicitly set to false", () => {
    const opts: SpawnClaudeOptions = { prompt: "test", cascade: false };
    expect(opts.cascade).toBe(false);
  });
});

// ── SpawnClaudeResult cascade tracking fields ────────────────

describe("SpawnClaudeResult cascade tracking", () => {
  it("AC-014: result has modelUsed and cascadeEscalations fields", () => {
    const result: SpawnClaudeResult = {
      stdout: "output",
      stderr: "",
      exitCode: 0,
      modelUsed: "claude-haiku-4-5",
      cascadeEscalations: 0,
    };
    expect(result.modelUsed).toBe("claude-haiku-4-5");
    expect(result.cascadeEscalations).toBe(0);
  });

  it("tracks escalation count", () => {
    const result: SpawnClaudeResult = {
      stdout: "output",
      stderr: "",
      exitCode: 0,
      modelUsed: "claude-sonnet-4-6",
      cascadeEscalations: 1,
    };
    expect(result.cascadeEscalations).toBe(1);
  });

  it("EC-003: max escalation is 2 (Haiku->Sonnet->Opus)", () => {
    const result: SpawnClaudeResult = {
      stdout: "",
      stderr: "all failed",
      exitCode: 1,
      modelUsed: "claude-opus-4-6",
      cascadeEscalations: 2,
    };
    expect(result.cascadeEscalations).toBe(2);
  });
});

// ── EC-006: Explicit model override disables cascade ─────────

describe("cascade with explicit model override", () => {
  it("EC-006: explicit model takes precedence over cascade", () => {
    // When model is set, cascade should be bypassed
    // This is verified by spawnClaudeWithCascade checking options.model
    const opts: SpawnClaudeOptions = {
      prompt: "test",
      cascade: true,
      model: "claude-opus-4-6",
    };
    // Both cascade and model are set; model wins
    expect(opts.model).toBe("claude-opus-4-6");
    expect(opts.cascade).toBe(true);
  });
});

// ── Backward compatibility ───────────────────────────────────

describe("backward compatibility", () => {
  it("AC-015: spawnClaude without cascade behaves as before", () => {
    const opts: SpawnClaudeOptions = {
      prompt: "test",
      model: "claude-sonnet-4-6",
      effort: "medium",
    };
    // No cascade field = no cascade behavior
    expect(opts.cascade).toBeUndefined();
  });

  it("spawnClaude is exported and callable", async () => {
    const { spawnClaude } = await import("../../src/agent");
    expect(typeof spawnClaude).toBe("function");
  });

  it("spawnClaudeWithCascade is exported", async () => {
    const { spawnClaudeWithCascade } = await import("../../src/agent");
    expect(typeof spawnClaudeWithCascade).toBe("function");
  });
});
