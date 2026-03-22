/**
 * Unit Tests — S28 CLI Optimization
 *
 * Tests for BmadAgent CLI flags (T3), JSON Schema (T4),
 * cost tracking multi-model (T6), prompt split (T7).
 */

import { describe, expect, it } from "bun:test";
import { getJsonSchemaForRole, parseAgentOutput } from "../../src/agent-schemas";
import { getAgent, getAgents } from "../../src/bmad-agents";
import {
  buildAgentSystemPromptPart,
  buildAgentTaskPromptPart,
  buildFullAgentPrompt,
} from "../../src/bmad-prompts";
import { estimateCost, MODEL_PRICING, parseTokenUsage } from "../../src/cost-tracking";

// ── T3: BmadAgent CLI Flags ──────────────────────────────────

describe("BmadAgent CLI flags (T3)", () => {
  it("all 6 agents have effort defined", () => {
    for (const agent of getAgents()) {
      expect(agent.effort).toBeDefined();
      expect(["low", "medium", "high", "max"]).toContain(agent.effort);
    }
  });

  it("all 6 agents have model defined", () => {
    for (const agent of getAgents()) {
      expect(agent.model).toBeDefined();
      expect(typeof agent.model).toBe("string");
    }
  });

  it("all 6 agents have fallbackModel defined", () => {
    for (const agent of getAgents()) {
      expect(agent.fallbackModel).toBeDefined();
      expect(typeof agent.fallbackModel).toBe("string");
    }
  });

  it("agents have no maxBudgetUsd (unlimited)", () => {
    for (const agent of getAgents()) {
      expect(agent.maxBudgetUsd).toBeUndefined();
    }
  });

  it("analyst uses medium effort and sonnet", () => {
    const agent = getAgent("analyst")!;
    expect(agent.effort).toBe("medium");
    expect(agent.model).toBe("claude-sonnet-4-6");
  });

  it("dev uses high effort and opus", () => {
    const agent = getAgent("dev")!;
    expect(agent.effort).toBe("high");
    expect(agent.model).toBe("claude-opus-4-6");
  });

  it("sm uses low effort and haiku", () => {
    const agent = getAgent("sm")!;
    expect(agent.effort).toBe("low");
    expect(agent.model).toBe("claude-haiku-4-5");
  });

  it("architect uses high effort and opus", () => {
    const agent = getAgent("architect")!;
    expect(agent.effort).toBe("high");
    expect(agent.model).toBe("claude-opus-4-6");
  });

  it("qa uses high effort and sonnet", () => {
    const agent = getAgent("qa")!;
    expect(agent.effort).toBe("high");
    expect(agent.model).toBe("claude-sonnet-4-6");
  });

  it("pm uses medium effort and sonnet", () => {
    const agent = getAgent("pm")!;
    expect(agent.effort).toBe("medium");
    expect(agent.model).toBe("claude-sonnet-4-6");
  });
});

// ── T4: JSON Schema for --json-schema flag ───────────────────

describe("getJsonSchemaForRole (T4)", () => {
  it("returns a valid schema for all 6 agent roles", () => {
    const roles = ["analyst", "pm", "architect", "dev", "qa", "sm"];
    for (const role of roles) {
      const schema = getJsonSchemaForRole(role);
      expect(schema).not.toBeNull();
      expect((schema as any).type).toBe("object");
      expect((schema as any).required).toBeDefined();
      expect(Array.isArray((schema as any).required)).toBe(true);
    }
  });

  it("returns schema for gate_evaluation", () => {
    const schema = getJsonSchemaForRole("gate_evaluation");
    expect(schema).not.toBeNull();
    expect((schema as any).required).toContain("pass");
    expect((schema as any).required).toContain("score");
  });

  it("returns schema for drift_report", () => {
    const schema = getJsonSchemaForRole("drift_report");
    expect(schema).not.toBeNull();
    expect((schema as any).required).toContain("coverage_score");
    expect((schema as any).required).toContain("overall_verdict");
  });

  it("returns null for unknown role", () => {
    expect(getJsonSchemaForRole("unknown")).toBeNull();
  });

  it("analyst schema requires analysis and risks", () => {
    const schema = getJsonSchemaForRole("analyst") as any;
    expect(schema.required).toContain("analysis");
    expect(schema.required).toContain("risks");
  });

  it("dev schema requires files_modified and summary", () => {
    const schema = getJsonSchemaForRole("dev") as any;
    expect(schema.required).toContain("files_modified");
    expect(schema.required).toContain("summary");
  });

  it("qa schema requires score and findings", () => {
    const schema = getJsonSchemaForRole("qa") as any;
    expect(schema.required).toContain("score");
    expect(schema.required).toContain("findings");
  });
});

describe("parseAgentOutput with direct JSON (T4)", () => {
  it("parses direct JSON output (from --output-format json)", () => {
    const directJson = JSON.stringify({
      analysis: "Test analysis",
      risks: [{ severity: "low", description: "minor risk" }],
      recommendations: ["do this"],
      dependencies: [],
      feasibility: "high",
    });

    const result = parseAgentOutput(directJson, "analyst");
    expect(result).not.toBeNull();
    expect(result!.role).toBe("analyst");
  });

  it("still parses <<<JSON>>> markers as fallback", () => {
    const raw = `Some text\n<<<JSON>>>\n{"files_modified": ["a.ts"], "summary": "done", "tests_added": [], "issues_encountered": []}\n<<<END>>>\nMore text`;
    const result = parseAgentOutput(raw, "dev");
    expect(result).not.toBeNull();
    expect(result!.role).toBe("dev");
  });

  it("still falls back to largest JSON object", () => {
    const raw = `{"small": 1}\n{"score": 85, "findings": [], "summary": "ok", "tests_missing": []}`;
    const result = parseAgentOutput(raw, "qa");
    expect(result).not.toBeNull();
  });
});

// ── T6: Cost Tracking Multi-Model ────────────────────────────

describe("MODEL_PRICING (T6)", () => {
  it("has pricing for opus, sonnet, and haiku", () => {
    expect(MODEL_PRICING["claude-opus-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
  });

  it("opus is more expensive than sonnet", () => {
    expect(MODEL_PRICING["claude-opus-4-6"].input).toBeGreaterThan(
      MODEL_PRICING["claude-sonnet-4-6"].input,
    );
    expect(MODEL_PRICING["claude-opus-4-6"].output).toBeGreaterThan(
      MODEL_PRICING["claude-sonnet-4-6"].output,
    );
  });

  it("haiku is cheaper than sonnet", () => {
    expect(MODEL_PRICING["claude-haiku-4-5"].input).toBeLessThan(
      MODEL_PRICING["claude-sonnet-4-6"].input,
    );
    expect(MODEL_PRICING["claude-haiku-4-5"].output).toBeLessThan(
      MODEL_PRICING["claude-sonnet-4-6"].output,
    );
  });
});

describe("estimateCost with model (T6)", () => {
  it("calculates higher cost for opus", () => {
    const opusCost = estimateCost(1_000_000, 1_000_000, "claude-opus-4-6");
    const sonnetCost = estimateCost(1_000_000, 1_000_000, "claude-sonnet-4-6");
    expect(opusCost).toBeGreaterThan(sonnetCost);
  });

  it("calculates lower cost for haiku", () => {
    const haikuCost = estimateCost(1_000_000, 1_000_000, "claude-haiku-4-5");
    const sonnetCost = estimateCost(1_000_000, 1_000_000, "claude-sonnet-4-6");
    expect(haikuCost).toBeLessThan(sonnetCost);
  });

  it("defaults to sonnet pricing when model is undefined", () => {
    const defaultCost = estimateCost(1_000_000, 1_000_000);
    const sonnetCost = estimateCost(1_000_000, 1_000_000, "claude-sonnet-4-6");
    expect(defaultCost).toBe(sonnetCost);
  });

  it("defaults to sonnet pricing for unknown model", () => {
    const unknownCost = estimateCost(1_000_000, 1_000_000, "unknown-model");
    const sonnetCost = estimateCost(1_000_000, 1_000_000, "claude-sonnet-4-6");
    expect(unknownCost).toBe(sonnetCost);
  });

  it("opus 1M in + 1M out = $90", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "claude-opus-4-6");
    expect(cost).toBe(90);
  });

  it("haiku 1M in + 1M out = $4.80", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "claude-haiku-4-5");
    expect(cost).toBe(4.8);
  });
});

describe("parseTokenUsage with model (T6)", () => {
  it("uses model pricing for structured usage data", () => {
    const output = '{"input_tokens": 1000000, "output_tokens": 1000000}';
    const opusUsage = parseTokenUsage(output, 0, "claude-opus-4-6");
    const sonnetUsage = parseTokenUsage(output, 0, "claude-sonnet-4-6");
    expect(opusUsage.costUsd).toBeGreaterThan(sonnetUsage.costUsd);
  });

  it("uses model pricing for fallback estimation", () => {
    const output = "Some text output without JSON";
    const opusUsage = parseTokenUsage(output, 1000, "claude-opus-4-6");
    const sonnetUsage = parseTokenUsage(output, 1000, "claude-sonnet-4-6");
    expect(opusUsage.costUsd).toBeGreaterThan(sonnetUsage.costUsd);
  });
});

// ── T7: System/Task Prompt Split ─────────────────────────────

describe("buildAgentSystemPromptPart (T7)", () => {
  it("contains agent identity and role", () => {
    const system = buildAgentSystemPromptPart("dev", { command: "exec" });
    expect(system).toContain("Amelia");
    expect(system).toContain("ROLE:");
    expect(system).toContain("IDENTITE:");
    expect(system).toContain("STYLE:");
    expect(system).toContain("PRINCIPES:");
  });

  it("contains critical actions for dev", () => {
    const system = buildAgentSystemPromptPart("dev", { command: "exec" });
    expect(system).toContain("ACTIONS CRITIQUES:");
  });

  it("does NOT contain task-specific content", () => {
    const system = buildAgentSystemPromptPart("dev", {
      command: "exec",
      taskTitle: "Fix login bug",
      taskDescription: "Users cannot login",
    });
    // Task content should NOT be in system prompt
    expect(system).not.toContain("Fix login bug");
    expect(system).not.toContain("Users cannot login");
  });

  it("returns empty string for unknown agent", () => {
    const system = buildAgentSystemPromptPart("nonexistent", { command: "exec" });
    expect(system).toBe("");
  });
});

describe("buildAgentTaskPromptPart (T7)", () => {
  it("contains task details", () => {
    const task = buildAgentTaskPromptPart("dev", {
      command: "exec",
      taskTitle: "Add feature X",
      taskDescription: "Description of feature X",
      priority: 1,
      projectName: "my-project",
    });
    expect(task).toContain("TACHE: Add feature X");
    expect(task).toContain("DESCRIPTION: Description of feature X");
    expect(task).toContain("PRIORITE: P1");
    expect(task).toContain("PROJET: my-project");
  });

  it("contains acceptance criteria when present", () => {
    const task = buildAgentTaskPromptPart("dev", {
      command: "exec",
      taskTitle: "test",
      acceptanceCriteria: "Given/When/Then",
    });
    expect(task).toContain("CRITERES D'ACCEPTATION:");
    expect(task).toContain("Given/When/Then");
  });

  it("contains subtasks when present", () => {
    const task = buildAgentTaskPromptPart("dev", {
      command: "exec",
      taskTitle: "test",
      subtasks: [
        { title: "Step 1", done: false },
        { title: "Step 2", done: true },
      ],
    });
    expect(task).toContain("[ ] Step 1");
    expect(task).toContain("[x] Step 2");
  });

  it("does NOT contain agent identity", () => {
    const task = buildAgentTaskPromptPart("dev", {
      command: "exec",
      taskTitle: "test",
    });
    expect(task).not.toContain("Amelia");
    expect(task).not.toContain("ROLE:");
  });

  it("returns empty string when no task context", () => {
    const task = buildAgentTaskPromptPart("dev", { command: "exec" });
    expect(task).toBe("");
  });
});

describe("buildFullAgentPrompt wrapper (T7)", () => {
  it("concatenates system and task parts with separator", () => {
    const full = buildFullAgentPrompt("dev", {
      command: "exec",
      taskTitle: "Test task",
    });
    expect(full).toContain("Amelia");
    expect(full).toContain("TACHE: Test task");
    expect(full).toContain("---");
  });

  it("returns just system part when no task context", () => {
    const full = buildFullAgentPrompt("dev", { command: "exec" });
    expect(full).toContain("Amelia");
    expect(full).not.toContain("TACHE:");
  });

  it("backward compatible: same content as before for full context", () => {
    const full = buildFullAgentPrompt("pm", {
      command: "plan",
      taskTitle: "Decompose request",
      taskDescription: "Break into subtasks",
      priority: 2,
    });
    expect(full).toContain("John");
    expect(full).toContain("TACHE: Decompose request");
    expect(full).toContain("PRIORITE: P2");
  });
});
