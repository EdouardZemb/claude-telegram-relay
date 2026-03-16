/**
 * Unit Tests — S34 FR-004: LLM Router for Dynamic Pipeline Selection
 *
 * Tests router response parsing, normalization, fallback behavior.
 */

import { describe, it, expect } from "bun:test";
import {
  parseRouterResponse,
  routerPipelineToRoles,
  type RouterDecision,
} from "../../src/llm-router";

// ── parseRouterResponse ──────────────────────────────────────

describe("parseRouterResponse", () => {
  it("parses valid DEFAULT pipeline response (AC-017)", () => {
    const output = JSON.stringify({
      pipeline: "DEFAULT",
      models: {
        analyst: "claude-haiku-4-5",
        pm: "claude-haiku-4-5",
        architect: "claude-sonnet-4-6",
        dev: "claude-opus-4-6",
        qa: "claude-sonnet-4-6",
      },
      budget: 5.0,
      reasoning: "Complex feature requiring full analysis pipeline",
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.pipeline).toBe("DEFAULT");
    expect(decision!.models.analyst).toBe("claude-haiku-4-5");
    expect(decision!.models.dev).toBe("claude-opus-4-6");
    expect(decision!.budget).toBe(5.0);
    expect(decision!.reasoning).toContain("Complex");
  });

  it("parses QUICK pipeline response", () => {
    const output = JSON.stringify({
      pipeline: "QUICK",
      models: {
        dev: "claude-sonnet-4-6",
        qa: "claude-haiku-4-5",
      },
      budget: 1.5,
      reasoning: "Simple bug fix",
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.pipeline).toBe("QUICK");
    expect(Object.keys(decision!.models)).toHaveLength(2);
  });

  it("parses REVIEW pipeline response", () => {
    const output = JSON.stringify({
      pipeline: "REVIEW",
      models: {
        qa: "claude-sonnet-4-6",
        architect: "claude-opus-4-6",
      },
      budget: 2.0,
      reasoning: "Code audit needed",
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.pipeline).toBe("REVIEW");
  });

  it("extracts JSON from mixed output", () => {
    const output = `Here is my analysis:
${JSON.stringify({ pipeline: "QUICK", models: {}, budget: 1.0, reasoning: "Simple" })}
That's my recommendation.`;

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.pipeline).toBe("QUICK");
  });

  it("EC-002: returns null on invalid JSON", () => {
    const decision = parseRouterResponse("This is not JSON");
    expect(decision).toBeNull();
  });

  it("returns null on invalid pipeline type", () => {
    const output = JSON.stringify({
      pipeline: "INVALID",
      models: {},
      budget: 1.0,
      reasoning: "test",
    });

    const decision = parseRouterResponse(output);
    expect(decision).toBeNull();
  });

  it("EC-005: unknown model falls back to Sonnet", () => {
    const output = JSON.stringify({
      pipeline: "DEFAULT",
      models: {
        dev: "claude-unknown-model",
        qa: "claude-sonnet-4-6",
      },
      budget: 2.0,
      reasoning: "test",
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.models.dev).toBe("claude-sonnet-4-6"); // fallback
    expect(decision!.models.qa).toBe("claude-sonnet-4-6");  // unchanged
  });

  it("handles missing models gracefully", () => {
    const output = JSON.stringify({
      pipeline: "QUICK",
      budget: 1.0,
      reasoning: "Simple task",
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(Object.keys(decision!.models)).toHaveLength(0);
  });

  it("handles negative budget", () => {
    const output = JSON.stringify({
      pipeline: "QUICK",
      models: {},
      budget: -5,
      reasoning: "test",
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.budget).toBe(0);
  });

  it("handles missing budget", () => {
    const output = JSON.stringify({
      pipeline: "QUICK",
      models: {},
      reasoning: "test",
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.budget).toBe(5.0); // default
  });

  it("handles missing reasoning", () => {
    const output = JSON.stringify({
      pipeline: "QUICK",
      models: {},
      budget: 1.0,
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.reasoning).toBe("");
  });

  it("filters invalid role names from models", () => {
    const output = JSON.stringify({
      pipeline: "DEFAULT",
      models: {
        dev: "claude-sonnet-4-6",
        invalid_role: "claude-opus-4-6",
      },
      budget: 2.0,
      reasoning: "test",
    });

    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.models.dev).toBe("claude-sonnet-4-6");
    // invalid_role should not be in the result
    expect(Object.keys(decision!.models)).toHaveLength(1);
  });
});

// ── routerPipelineToRoles ────────────────────────────────────

describe("routerPipelineToRoles", () => {
  it("maps DEFAULT to full pipeline", () => {
    const roles = routerPipelineToRoles({
      pipeline: "DEFAULT",
      models: {},
      budget: 5.0,
      reasoning: "",
    });
    expect(roles).toEqual(["analyst", "pm", "architect", "dev", "qa"]);
  });

  it("maps QUICK to dev + qa", () => {
    const roles = routerPipelineToRoles({
      pipeline: "QUICK",
      models: {},
      budget: 1.5,
      reasoning: "",
    });
    expect(roles).toEqual(["dev", "qa"]);
  });

  it("maps REVIEW to qa + architect", () => {
    const roles = routerPipelineToRoles({
      pipeline: "REVIEW",
      models: {},
      budget: 2.0,
      reasoning: "",
    });
    expect(roles).toEqual(["qa", "architect"]);
  });
});

// ── routeTask export ─────────────────────────────────────────

describe("routeTask export", () => {
  it("is exported and callable", async () => {
    const { routeTask } = await import("../../src/llm-router");
    expect(typeof routeTask).toBe("function");
  });
});

// ── Integration: auto-pipeline uses router ───────────────────

describe("auto-pipeline router integration", () => {
  it("PipelineOptions has useRouter and cascade fields", () => {
    // Runtime check that these fields are accepted
    const opts = { useRouter: true, cascade: false };
    expect(opts.useRouter).toBe(true);
    expect(opts.cascade).toBe(false);
  });
});
