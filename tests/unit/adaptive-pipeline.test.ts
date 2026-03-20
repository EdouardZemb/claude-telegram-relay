/**
 * Unit Tests — S44 T8: Adaptive Pipeline (SOLO, LIGHT) + Fusion Planner
 *
 * Tests pipeline definitions, planner agent, difficulty-based
 * pipeline selection, and router integration.
 */

import { describe, it, expect } from "bun:test";
import {
  SOLO_PIPELINE,
  LIGHT_PIPELINE,
  DEFAULT_PIPELINE,
  QUICK_PIPELINE,
  REVIEW_PIPELINE,
  selectPipeline,
  selectAdaptivePipeline,
  classifyPipeline,
  classifyAdaptivePipeline,
} from "../../src/orchestrator";
import {
  routerPipelineToRoles,
  scoreToPipeline,
  analyzeDescription,
  type RouterDecision,
} from "../../src/llm-router";
import { getAgent, getAgents } from "../../src/bmad-agents";
import {
  validateAgentOutput,
  getSchemaForRole,
  getJsonSchemaForRole,
  formatStructuredOutput,
  type PlannerOutput,
} from "../../src/agent-schemas";
import { getMcpToolsForRole } from "../../src/mcp-config";

// ── Pipeline Definitions ──────────────────────────────────────

describe("Pipeline Definitions (S44 T8)", () => {
  it("SOLO_PIPELINE contains only dev", () => {
    expect(SOLO_PIPELINE).toEqual(["dev"]);
  });

  it("LIGHT_PIPELINE contains planner, dev, qa", () => {
    expect(LIGHT_PIPELINE).toEqual(["planner", "dev", "qa"]);
  });

  it("DEFAULT_PIPELINE is unchanged (5 agents)", () => {
    expect(DEFAULT_PIPELINE).toHaveLength(5);
    expect(DEFAULT_PIPELINE).toContain("analyst");
    expect(DEFAULT_PIPELINE).toContain("pm");
  });

  it("QUICK_PIPELINE is unchanged", () => {
    expect(QUICK_PIPELINE).toEqual(["dev", "qa"]);
  });

  it("REVIEW_PIPELINE is unchanged", () => {
    expect(REVIEW_PIPELINE).toEqual(["qa", "architect"]);
  });
});

// ── Planner Agent ────────────────────────────────────────────

describe("Planner Agent (S44 T8)", () => {
  it("exists in agent registry", () => {
    const planner = getAgent("planner");
    expect(planner).toBeDefined();
    expect(planner!.name).toBe("Ivy");
    expect(planner!.title).toBe("Planner");
  });

  it("has correct configuration", () => {
    const planner = getAgent("planner");
    expect(planner!.effort).toBe("medium");
    expect(planner!.model).toBe("claude-sonnet-4-6");
  });

  it("has trust thresholds", () => {
    const planner = getAgent("planner");
    expect(planner!.trustThresholds).toBeDefined();
    expect(planner!.trustThresholds!.specAutoApprove).toBe(75);
    expect(planner!.trustThresholds!.implAutoApprove).toBe(88);
  });

  it("has commands defined", () => {
    const planner = getAgent("planner");
    expect(planner!.commands.length).toBeGreaterThan(0);
  });

  it("total agent count is 8", () => {
    expect(getAgents().length).toBe(8);
  });
});

// ── Planner Schema ───────────────────────────────────────────

describe("Planner Schema (S44 T8)", () => {
  it("has schema description", () => {
    const schema = getSchemaForRole("planner");
    expect(schema).toContain("planner");
    expect(schema).toContain("feasibility");
    expect(schema).toContain("analysis");
    expect(schema).toContain("subtasks");
  });

  it("has JSON Schema", () => {
    const jsonSchema = getJsonSchemaForRole("planner");
    expect(jsonSchema).not.toBeNull();
    expect((jsonSchema as any).properties.role.const).toBe("planner");
    expect((jsonSchema as any).required).toContain("feasibility");
    expect((jsonSchema as any).required).toContain("analysis");
    expect((jsonSchema as any).required).toContain("subtasks");
  });

  it("validates correct planner output", () => {
    const output = {
      role: "planner",
      feasibility: "high",
      analysis: "Task is straightforward",
      risks: [{ severity: "low", description: "Minor risk" }],
      subtasks: [
        {
          title: "Implement feature",
          description: "Add the new module",
          priority: 1,
          acceptance_criteria: "Given/When/Then",
        },
      ],
      priorities: ["Ship fast"],
    };
    expect(validateAgentOutput(output, "planner")).toBe(true);
  });

  it("rejects planner output missing feasibility", () => {
    const output = {
      role: "planner",
      subtasks: [{ title: "t", description: "d", priority: 1 }],
      priorities: ["p"],
    };
    expect(validateAgentOutput(output, "planner")).toBe(false);
  });

  it("rejects planner output missing analysis", () => {
    const output = {
      role: "planner",
      feasibility: "high",
      subtasks: [{ title: "t", description: "d", priority: 1 }],
      priorities: ["p"],
    };
    expect(validateAgentOutput(output, "planner")).toBe(false);
  });

  it("formats planner output correctly", () => {
    const output: PlannerOutput = {
      role: "planner",
      feasibility: "high",
      analysis: "The task is feasible",
      risks: [{ severity: "low", description: "Minor" }],
      subtasks: [
        {
          title: "Step 1",
          description: "First step",
          priority: 1,
          acceptance_criteria: "Done",
        },
      ],
      priorities: ["Speed"],
    };
    const formatted = formatStructuredOutput(output);
    expect(formatted).toContain("Faisabilite: high");
    expect(formatted).toContain("Analyse: The task is feasible");
    expect(formatted).toContain("[P1] Step 1");
    expect(formatted).toContain("[low] Minor");
  });
});

// ── Planner MCP Config ──────────────────────────────────────

describe("Planner MCP Config (S44 T8)", () => {
  it("has MCP tools configured", () => {
    const tools = getMcpToolsForRole("planner");
    expect(tools.length).toBeGreaterThan(0);
  });

  it("has capture_thought access", () => {
    const tools = getMcpToolsForRole("planner");
    expect(tools).toContain("capture_thought");
  });

  it("does not have blackboard write access", () => {
    const tools = getMcpToolsForRole("planner");
    expect(tools).not.toContain("write_blackboard");
  });
});

// ── Router Pipeline Mapping ──────────────────────────────────

describe("Router Pipeline Mapping (S44 T8)", () => {
  function decision(pipeline: string): RouterDecision {
    return { pipeline: pipeline as any, models: {}, budget: 1, reasoning: "" };
  }

  it("maps SOLO to [dev]", () => {
    expect(routerPipelineToRoles(decision("SOLO"))).toEqual(["dev"]);
  });

  it("maps LIGHT to [planner, dev, qa]", () => {
    expect(routerPipelineToRoles(decision("LIGHT"))).toEqual(["planner", "dev", "qa"]);
  });

  it("maps QUICK to [dev, qa]", () => {
    expect(routerPipelineToRoles(decision("QUICK"))).toEqual(["dev", "qa"]);
  });

  it("maps REVIEW to [qa, architect]", () => {
    expect(routerPipelineToRoles(decision("REVIEW"))).toEqual(["qa", "architect"]);
  });

  it("maps DEFAULT to full pipeline", () => {
    expect(routerPipelineToRoles(decision("DEFAULT"))).toEqual([
      "analyst", "pm", "architect", "dev", "qa",
    ]);
  });
});

// ── Difficulty Score → Pipeline ──────────────────────────────

describe("Difficulty Score Integration (S44 T8)", () => {
  it("score 0 → SOLO", () => {
    expect(scoreToPipeline(0)).toBe("SOLO");
  });

  it("score 0.15 → SOLO", () => {
    expect(scoreToPipeline(0.15)).toBe("SOLO");
  });

  it("score 0.29 → SOLO", () => {
    expect(scoreToPipeline(0.29)).toBe("SOLO");
  });

  it("score 0.3 → LIGHT", () => {
    expect(scoreToPipeline(0.3)).toBe("LIGHT");
  });

  it("score 0.45 → LIGHT", () => {
    expect(scoreToPipeline(0.45)).toBe("LIGHT");
  });

  it("score 0.6 → LIGHT", () => {
    expect(scoreToPipeline(0.6)).toBe("LIGHT");
  });

  it("score 0.61 → DEFAULT", () => {
    expect(scoreToPipeline(0.61)).toBe("DEFAULT");
  });

  it("score 1.0 → DEFAULT", () => {
    expect(scoreToPipeline(1.0)).toBe("DEFAULT");
  });
});

// ── selectPipeline backward compatibility ────────────────────

describe("selectPipeline backward compatibility (S44 T8)", () => {
  function makeTask(title: string, desc?: string, priority?: number, subtasks?: any[]) {
    return {
      id: "t1",
      title,
      description: desc || null,
      priority: priority || 3,
      status: "backlog" as const,
      subtasks: subtasks || null,
    } as any;
  }

  it("still returns QUICK for bug keywords", () => {
    expect(selectPipeline(makeTask("fix bug in login"))).toEqual(QUICK_PIPELINE);
  });

  it("still returns REVIEW for review keywords", () => {
    expect(selectPipeline(makeTask("code review of auth module"))).toEqual(REVIEW_PIPELINE);
  });

  it("still returns QUICK for doc keywords", () => {
    expect(selectPipeline(makeTask("update documentation"))).toEqual(QUICK_PIPELINE);
  });

  it("still returns DEFAULT for complex tasks", () => {
    expect(selectPipeline(makeTask("Implement new orchestration pipeline with multi-agent support")))
      .toEqual(DEFAULT_PIPELINE);
  });

  it("respects explicit pipeline override", () => {
    const custom = ["dev" as const];
    expect(selectPipeline(makeTask("anything"), custom)).toEqual(custom);
  });
});

// ── selectAdaptivePipeline ───────────────────────────────────

describe("selectAdaptivePipeline (S44 T8)", () => {
  function makeTask(title: string, desc?: string) {
    return {
      id: "t1",
      title,
      description: desc || null,
      priority: 3,
      status: "backlog" as const,
      subtasks: null,
    } as any;
  }

  it("returns SOLO for trivial tasks", async () => {
    const result = await selectAdaptivePipeline(makeTask("fix typo"));
    expect(result).toEqual(SOLO_PIPELINE);
  });

  it("returns DEFAULT for complex tasks", async () => {
    const result = await selectAdaptivePipeline(
      makeTask(
        "Implement new orchestration engine",
        "Full architecture design with database migration, parallel execution framework, and security hardening of the authentication workflow integration",
      ),
    );
    expect(result).toEqual(DEFAULT_PIPELINE);
  });

  it("returns REVIEW for review keywords even in adaptive mode", async () => {
    const result = await selectAdaptivePipeline(makeTask("code review of auth"));
    expect(result).toEqual(REVIEW_PIPELINE);
  });

  it("respects explicit pipeline override", async () => {
    const custom = ["dev" as const, "qa" as const];
    const result = await selectAdaptivePipeline(makeTask("anything"), custom);
    expect(result).toEqual(custom);
  });
});

// ── classifyAdaptivePipeline ─────────────────────────────────

describe("classifyAdaptivePipeline (S44 T8)", () => {
  function makeTask(title: string, desc?: string) {
    return {
      id: "t1",
      title,
      description: desc || null,
      priority: 3,
      status: "backlog" as const,
      subtasks: null,
    } as any;
  }

  it("returns SOLO for trivial tasks", async () => {
    const result = await classifyAdaptivePipeline(makeTask("fix typo"));
    expect(result).toBe("SOLO");
  });

  it("returns DEFAULT for complex tasks", async () => {
    const result = await classifyAdaptivePipeline(
      makeTask(
        "Implement new orchestration engine",
        "Full architecture design with database migration and security hardening across auth workflow integration protocol",
      ),
    );
    expect(result).toBe("DEFAULT");
  });

  it("returns REVIEW for review keywords", async () => {
    const result = await classifyAdaptivePipeline(makeTask("audit code quality"));
    expect(result).toBe("REVIEW");
  });
});

// ── Router accepts SOLO/LIGHT ────────────────────────────────

describe("Router normalization (S44 T8)", () => {
  const { parseRouterResponse } = require("../../src/llm-router");

  it("parses SOLO pipeline response", () => {
    const output = JSON.stringify({
      pipeline: "SOLO",
      models: { dev: "claude-haiku-4-5" },
      budget: 0.5,
      reasoning: "Trivial change",
    });
    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.pipeline).toBe("SOLO");
  });

  it("parses LIGHT pipeline response", () => {
    const output = JSON.stringify({
      pipeline: "LIGHT",
      models: { planner: "claude-sonnet-4-6", dev: "claude-sonnet-4-6", qa: "claude-haiku-4-5" },
      budget: 2.0,
      reasoning: "Medium task",
    });
    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.pipeline).toBe("LIGHT");
    expect(decision!.models.planner).toBe("claude-sonnet-4-6");
  });
});
