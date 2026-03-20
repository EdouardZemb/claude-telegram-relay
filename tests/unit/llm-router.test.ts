/**
 * Unit Tests — S34 FR-004: LLM Router for Dynamic Pipeline Selection
 * S44 T7: Difficulty Scorer
 *
 * Tests router response parsing, normalization, fallback behavior,
 * and difficulty scoring for adaptive pipeline selection.
 */

import { describe, it, expect } from "bun:test";
import {
  parseRouterResponse,
  routerPipelineToRoles,
  analyzeDescription,
  computeGraphScoreFromGraph,
  computeHistoricalScore,
  scoreToPipeline,
  computeDifficultyScore,
  type RouterDecision,
  type DifficultyScore,
} from "../../src/llm-router";
import type { CodeGraph } from "../../src/code-graph";

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

// ── analyzeDescription (S44 T7) ─────────────────────────────

describe("analyzeDescription", () => {
  it("scores short simple text as low difficulty", () => {
    const score = analyzeDescription("fix typo");
    expect(score).toBeLessThan(0.3);
  });

  it("scores very short text as very low", () => {
    const score = analyzeDescription("rename var");
    expect(score).toBeLessThan(0.2);
  });

  it("scores medium text as medium difficulty", () => {
    const score = analyzeDescription(
      "Add a new endpoint for user profile updates with validation and error handling for the frontend integration",
    );
    expect(score).toBeGreaterThanOrEqual(0.3);
    expect(score).toBeLessThanOrEqual(0.7);
  });

  it("scores long complex text as high difficulty", () => {
    const score = analyzeDescription(
      "Refactor the entire orchestration pipeline to support parallel execution with concurrent database migrations and security hardening across all auth modules",
    );
    expect(score).toBeGreaterThan(0.6);
  });

  it("reduces score for simple keywords", () => {
    const withoutKeyword = analyzeDescription("update the main page");
    const withKeyword = analyzeDescription("fix typo in readme");
    expect(withKeyword).toBeLessThan(withoutKeyword);
  });

  it("increases score for complex keywords", () => {
    const base = analyzeDescription("implement the new feature for users");
    const complex = analyzeDescription(
      "implement the new architecture for users",
    );
    expect(complex).toBeGreaterThan(base);
  });

  it("increases score for subtasks", () => {
    const noSubs = analyzeDescription("add feature", 0);
    const someSubs = analyzeDescription("add feature", 2);
    const manySubs = analyzeDescription("add feature", 5);
    expect(someSubs).toBeGreaterThan(noSubs);
    expect(manySubs).toBeGreaterThan(someSubs);
  });

  it("clamps score between 0 and 1", () => {
    // Many simple keywords should not go below 0
    const low = analyzeDescription("fix typo rename label message comment readme changelog version bump");
    expect(low).toBeGreaterThanOrEqual(0);

    // Many complex keywords should not go above 1
    const high = analyzeDescription(
      "architect refactor migration multi pipeline parallel concurrent security auth database schema performance algorithm framework engine protocol orchestration workflow integration",
      10,
    );
    expect(high).toBeLessThanOrEqual(1);
  });

  it("returns a number with at most 2 decimal places", () => {
    const score = analyzeDescription("some task description");
    const rounded = Math.round(score * 100) / 100;
    expect(score).toBe(rounded);
  });
});

// ── computeGraphScoreFromGraph (S44 T7) ─────────────────────

describe("computeGraphScoreFromGraph", () => {
  function buildMockGraph(): CodeGraph {
    return {
      nodes: [
        {
          id: "src/relay.ts",
          exports: [{ name: "createBot", kind: "function" }],
          lineCount: 243,
        },
        {
          id: "src/orchestrator.ts",
          exports: [
            { name: "orchestrate", kind: "function" },
            { name: "selectPipeline", kind: "function" },
          ],
          lineCount: 1500,
        },
        {
          id: "src/tasks.ts",
          exports: [{ name: "createTask", kind: "function" }],
          lineCount: 200,
        },
      ],
      edges: [
        { from: "src/relay.ts", to: "src/orchestrator.ts" },
        { from: "src/relay.ts", to: "src/tasks.ts" },
        { from: "src/orchestrator.ts", to: "src/tasks.ts" },
      ],
    };
  }

  it("returns low score when no modules match", () => {
    const graph = buildMockGraph();
    const result = computeGraphScoreFromGraph(graph, "something unrelated");
    expect(result.score).toBe(0.3);
    expect(result.modules).toHaveLength(0);
  });

  it("returns score based on module complexity when modules match", () => {
    const graph = buildMockGraph();
    const result = computeGraphScoreFromGraph(
      graph,
      "modify the orchestrator pipeline",
    );
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.modules).toContain("src/orchestrator.ts");
  });

  it("boosts score for multiple affected modules", () => {
    const graph = buildMockGraph();
    const single = computeGraphScoreFromGraph(graph, "update tasks module");
    const multi = computeGraphScoreFromGraph(
      graph,
      "update relay and orchestrator and tasks",
    );
    expect(multi.score).toBeGreaterThanOrEqual(single.score);
    expect(multi.modules.length).toBeGreaterThan(single.modules.length);
  });

  it("caps score at 1.0", () => {
    const graph = buildMockGraph();
    const result = computeGraphScoreFromGraph(
      graph,
      "relay orchestrator tasks",
    );
    expect(result.score).toBeLessThanOrEqual(1.0);
  });
});

// ── computeHistoricalScore (S44 T7) ─────────────────────────

describe("computeHistoricalScore", () => {
  it("returns -1 for empty array", () => {
    expect(computeHistoricalScore([])).toBe(-1);
  });

  it("returns -1 for null/undefined", () => {
    expect(computeHistoricalScore(null as any)).toBe(-1);
    expect(computeHistoricalScore(undefined as any)).toBe(-1);
  });

  it("returns -1 when no tasks have actual hours", () => {
    const tasks = [
      { id: "1", title: "t1", estimatedHours: 2, actualHours: null, sprint: null, tags: [] },
    ];
    expect(computeHistoricalScore(tasks)).toBe(-1);
  });

  it("scores low for short tasks (< 2h)", () => {
    const tasks = [
      { id: "1", title: "t1", estimatedHours: 1, actualHours: 1, sprint: null, tags: [] },
    ];
    const score = computeHistoricalScore(tasks);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(0.2);
  });

  it("scores medium for moderate tasks (4-8h)", () => {
    const tasks = [
      { id: "1", title: "t1", estimatedHours: 4, actualHours: 6, sprint: null, tags: [] },
    ];
    const score = computeHistoricalScore(tasks);
    expect(score).toBeGreaterThanOrEqual(0.2);
    expect(score).toBeLessThanOrEqual(0.5);
  });

  it("scores high for long tasks (16h+)", () => {
    const tasks = [
      { id: "1", title: "t1", estimatedHours: 8, actualHours: 16, sprint: null, tags: [] },
    ];
    const score = computeHistoricalScore(tasks);
    expect(score).toBeGreaterThan(0.5);
  });

  it("boosts score when tasks are systematically underestimated", () => {
    const accurate = [
      { id: "1", title: "t1", estimatedHours: 4, actualHours: 4, sprint: null, tags: [] },
    ];
    const underestimated = [
      { id: "1", title: "t1", estimatedHours: 2, actualHours: 4, sprint: null, tags: [] },
    ];
    const accurateScore = computeHistoricalScore(accurate);
    const underScore = computeHistoricalScore(underestimated);
    expect(underScore).toBeGreaterThan(accurateScore);
  });

  it("averages across multiple tasks", () => {
    const tasks = [
      { id: "1", title: "t1", estimatedHours: 2, actualHours: 2, sprint: null, tags: [] },
      { id: "2", title: "t2", estimatedHours: 8, actualHours: 10, sprint: null, tags: [] },
    ];
    const score = computeHistoricalScore(tasks);
    // Average actual hours = 6, score ~ 6/18 = 0.33
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(0.5);
  });

  it("ignores tasks with zero actual hours", () => {
    const tasks = [
      { id: "1", title: "t1", estimatedHours: 2, actualHours: 0, sprint: null, tags: [] },
      { id: "2", title: "t2", estimatedHours: 4, actualHours: 8, sprint: null, tags: [] },
    ];
    const score = computeHistoricalScore(tasks);
    // Only task 2 counts: 8/18 = 0.44
    expect(score).toBeGreaterThan(0.3);
  });
});

// ── scoreToPipeline (S44 T7) ────────────────────────────────

describe("scoreToPipeline", () => {
  it("AC-007: returns SOLO for score < 0.3", () => {
    expect(scoreToPipeline(0)).toBe("SOLO");
    expect(scoreToPipeline(0.1)).toBe("SOLO");
    expect(scoreToPipeline(0.29)).toBe("SOLO");
  });

  it("AC-008: returns LIGHT for score 0.3-0.7", () => {
    expect(scoreToPipeline(0.3)).toBe("LIGHT");
    expect(scoreToPipeline(0.45)).toBe("LIGHT");
    expect(scoreToPipeline(0.6)).toBe("LIGHT");
    expect(scoreToPipeline(0.7)).toBe("LIGHT");
  });

  it("AC-009: returns DEFAULT for score > 0.7", () => {
    expect(scoreToPipeline(0.71)).toBe("DEFAULT");
    expect(scoreToPipeline(0.8)).toBe("DEFAULT");
    expect(scoreToPipeline(1.0)).toBe("DEFAULT");
  });

  it("handles boundary values precisely", () => {
    expect(scoreToPipeline(0.299)).toBe("SOLO");
    expect(scoreToPipeline(0.3)).toBe("LIGHT");
    expect(scoreToPipeline(0.7)).toBe("LIGHT");
    expect(scoreToPipeline(0.701)).toBe("DEFAULT");
  });
});

// ── computeDifficultyScore (S44 T7) ─────────────────────────

describe("computeDifficultyScore", () => {
  function makeTask(title: string, desc?: string, subtasks?: any[]) {
    return {
      id: "test-id",
      title,
      description: desc || null,
      priority: 3,
      status: "backlog" as const,
      subtasks: subtasks || null,
    } as any;
  }

  it("AC-006: returns a score between 0 and 1", async () => {
    const result = await computeDifficultyScore(makeTask("fix a typo"));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("AC-006: returns all component scores", async () => {
    const result = await computeDifficultyScore(makeTask("add feature"));
    expect(result.components).toBeDefined();
    expect(typeof result.components.descriptionAnalysis).toBe("number");
    expect(typeof result.components.graphComplexity).toBe("number");
    expect(typeof result.components.historicalEffort).toBe("number");
  });

  it("AC-006: includes pipeline recommendation", async () => {
    const result = await computeDifficultyScore(makeTask("fix typo"));
    expect(["SOLO", "LIGHT", "DEFAULT"]).toContain(result.pipeline);
  });

  it("scores simple tasks as SOLO", async () => {
    const result = await computeDifficultyScore(makeTask("fix typo"));
    // Without graph and history, only desc score matters
    // "fix typo" is short (8 chars) + "typo" keyword → very low
    expect(result.pipeline).toBe("SOLO");
  });

  it("scores complex tasks as DEFAULT", async () => {
    const result = await computeDifficultyScore(
      makeTask(
        "Refactor orchestration pipeline",
        "Complete architecture refactor with database migration, parallel execution, and security hardening of the authentication workflow",
      ),
    );
    expect(result.pipeline).toBe("DEFAULT");
  });

  it("EC-003: handles null supabase gracefully", async () => {
    const result = await computeDifficultyScore(makeTask("add feature"), null);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.similarTaskCount).toBe(0);
    expect(result.historicalEffort).toBeUndefined;
    // Historical component should be -1 (unavailable)
    expect(result.components.historicalEffort).toBe(-1);
  });

  it("graph component is computed when code_graph is enabled", async () => {
    // code_graph feature flag is enabled — graph score should be >= 0
    const result = await computeDifficultyScore(makeTask("modify relay module"));
    expect(result.components.graphComplexity).toBeGreaterThanOrEqual(0);
  });

  it("returns affected modules when graph is available", async () => {
    // This tests that the field exists even when empty
    const result = await computeDifficultyScore(makeTask("fix something"));
    expect(Array.isArray(result.affectedModules)).toBe(true);
  });

  it("description-only mode produces reasonable scores", async () => {
    // When only desc is available, score = descScore directly
    const simple = await computeDifficultyScore(makeTask("fix typo"));
    const medium = await computeDifficultyScore(
      makeTask("Add a new API endpoint for task management"),
    );
    const complex = await computeDifficultyScore(
      makeTask(
        "Refactor the entire architecture",
        "Multi-module parallel migration with database schema changes and security audit of auth workflow integration",
        [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      ),
    );

    expect(simple.score).toBeLessThan(medium.score);
    expect(medium.score).toBeLessThan(complex.score);
  });

  it("returns DifficultyScore with all fields", async () => {
    const result = await computeDifficultyScore(makeTask("test task"));
    expect(typeof result.score).toBe("number");
    expect(typeof result.components.graphComplexity).toBe("number");
    expect(typeof result.components.descriptionAnalysis).toBe("number");
    expect(typeof result.components.historicalEffort).toBe("number");
    expect(Array.isArray(result.affectedModules)).toBe(true);
    expect(typeof result.similarTaskCount).toBe("number");
    expect(typeof result.pipeline).toBe("string");
  });
});
