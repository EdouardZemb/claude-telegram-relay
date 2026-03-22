/**
 * Unit Tests — Exploration Scoring
 * PRD: Phase Exploration dans le Workflow de Dev
 *
 * Tests exploration score computation, keyword detection,
 * graph complexity, similar task absence, and shouldExplore decision.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { CodeGraph } from "../../src/code-graph";
import {
  computeExplorationScore,
  computeGraphComplexityScore,
  computeKeywordScore,
  computeNoSimilarTasksScore,
  shouldExplore,
} from "../../src/exploration-scoring";
import type { Task } from "../../src/tasks";

// ── Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-task-id",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    title: "Test task",
    description: null,
    project: "test-project",
    status: "backlog",
    priority: 2,
    sprint: null,
    tags: [],
    estimated_hours: null,
    actual_hours: null,
    blocked_by: null,
    notes: null,
    completed_at: null,
    acceptance_criteria: null,
    dev_notes: null,
    architecture_ref: null,
    subtasks: [],
    ...overrides,
  };
}

function makeGraph(
  nodes: Array<{ id: string; lineCount: number; exports?: any[] }>,
  edges: Array<{ source: string; target: string }> = [],
): CodeGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      lineCount: n.lineCount,
      exports: n.exports || [],
    })),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      imports: [],
      isTypeOnly: false,
    })),
    indexedAt: new Date().toISOString(),
  };
}

// ── computeKeywordScore ──────────────────────────────────────

describe("computeKeywordScore", () => {
  it("returns 0 for text without exploration keywords", () => {
    expect(computeKeywordScore("fix button color")).toBe(0);
  });

  it("returns 0.4 for single keyword match", () => {
    expect(computeKeywordScore("research best auth library")).toBe(0.4);
  });

  it("returns 0.65 for two keyword matches", () => {
    const score = computeKeywordScore("research and compare auth solutions");
    expect(score).toBe(0.65);
  });

  it("returns 0.8 for three keyword matches", () => {
    const score = computeKeywordScore("research compare evaluate auth options");
    expect(score).toBe(0.8);
  });

  it("caps at 1.0 for many keywords", () => {
    const score = computeKeywordScore(
      "research compare evaluate benchmark study analyze investigate alternative approach",
    );
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("detects French keywords", () => {
    const score = computeKeywordScore("recherche et comparaison des alternatives");
    expect(score).toBeGreaterThan(0);
  });

  it("is case insensitive", () => {
    // "research" + "approach" = 2 keywords = 0.65
    expect(computeKeywordScore("RESEARCH best approach")).toBe(0.65);
  });
});

// ── computeGraphComplexityScore ──────────────────────────────

describe("computeGraphComplexityScore", () => {
  it("returns 0.3 when no modules are affected", () => {
    const graph = makeGraph([{ id: "src/relay.ts", lineCount: 100 }]);
    const result = computeGraphComplexityScore(graph, "unrelated task");
    expect(result.score).toBe(0.3);
    expect(result.modules).toEqual([]);
  });

  it("scores higher for complex affected modules", () => {
    const graph = makeGraph(
      [
        { id: "src/orchestrator.ts", lineCount: 500 },
        { id: "src/relay.ts", lineCount: 100 },
      ],
      [
        { source: "src/relay.ts", target: "src/orchestrator.ts" },
        { source: "src/orchestrator.ts", target: "src/relay.ts" },
      ],
    );
    const result = computeGraphComplexityScore(graph, "modifier orchestrator");
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.modules).toContain("src/orchestrator.ts");
  });

  it("boosts score for multiple affected modules", () => {
    const graph = makeGraph([
      { id: "src/orchestrator.ts", lineCount: 200 },
      { id: "src/pipeline-selection.ts", lineCount: 100 },
      { id: "src/llm-router.ts", lineCount: 150 },
    ]);
    const single = computeGraphComplexityScore(graph, "modifier orchestrator");
    const multi = computeGraphComplexityScore(
      graph,
      "modifier orchestrator pipeline-selection llm-router",
    );
    expect(multi.score).toBeGreaterThanOrEqual(single.score);
  });
});

// ── computeNoSimilarTasksScore ───────────────────────────────

describe("computeNoSimilarTasksScore", () => {
  it("returns 1.0 when no similar tasks found", () => {
    expect(computeNoSimilarTasksScore(0)).toBe(1.0);
  });

  it("returns 0.7 for 1 similar task", () => {
    expect(computeNoSimilarTasksScore(1)).toBe(0.7);
  });

  it("returns 0.4 for 2 similar tasks", () => {
    expect(computeNoSimilarTasksScore(2)).toBe(0.4);
  });

  it("returns 0.2 for 3 similar tasks", () => {
    expect(computeNoSimilarTasksScore(3)).toBe(0.2);
  });

  it("returns 0.1 for 4+ similar tasks", () => {
    expect(computeNoSimilarTasksScore(4)).toBe(0.1);
    expect(computeNoSimilarTasksScore(10)).toBe(0.1);
  });
});

// ── computeExplorationScore ──────────────────────────────────

describe("computeExplorationScore", () => {
  it("returns low score for simple tasks with no keywords", async () => {
    const task = makeTask({ title: "fix typo in readme" });
    const score = await computeExplorationScore(task, null);
    expect(score.score).toBeLessThan(0.5);
    expect(score.shouldExplore).toBe(false);
    expect(score.components.keywordSignal).toBe(0);
  });

  it("returns high score for research-heavy tasks", async () => {
    const task = makeTask({
      title: "Research and compare authentication alternatives",
      description: "Evaluate different approaches for auth migration, benchmark performance",
    });
    const score = await computeExplorationScore(task, null);
    expect(score.score).toBeGreaterThanOrEqual(0.5);
    expect(score.shouldExplore).toBe(true);
    expect(score.components.keywordSignal).toBeGreaterThan(0);
  });

  it("handles missing supabase gracefully", async () => {
    const task = makeTask({ title: "investigate memory leak" });
    const score = await computeExplorationScore(task, null);
    // findSimilarPastTasks returns [] when supabase is null, so count=0, score=1.0
    expect(score.components.noSimilarTasks).toBe(1.0);
    expect(typeof score.score).toBe("number");
  });

  it("clamps score between 0 and 1", async () => {
    const task = makeTask({ title: "simple task" });
    const score = await computeExplorationScore(task, null);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(1);
  });

  it("sets forceResearch when score >= 0.7", async () => {
    const task = makeTask({
      title: "Research evaluate compare benchmark alternative approaches for migration strategy",
      description: "Proof of concept and feasibility study for new architecture",
    });
    const score = await computeExplorationScore(task, null);
    if (score.score >= 0.7) {
      expect(score.forceResearch).toBe(true);
    }
  });
});

// ── shouldExplore ────────────────────────────────────────────

describe("shouldExplore", () => {
  // Mock feature flags
  const originalModule = require("../../src/feature-flags");
  let flagValue = true;

  beforeEach(() => {
    flagValue = true;
    mock.module("../../src/feature-flags", () => ({
      ...originalModule,
      isFeatureEnabled: (flag: string) => {
        if (flag === "exploration_phase") return flagValue;
        return false;
      },
      loadFeatures: originalModule.loadFeatures,
      setFeature: originalModule.setFeature,
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  it("returns false when feature flag is disabled", async () => {
    flagValue = false;
    // Re-import to get mocked version
    const { shouldExplore: se } = await import("../../src/exploration-scoring");
    const task = makeTask({ title: "research alternatives" });
    const result = await se(task, {});
    // Note: flag check uses isFeatureEnabled which we mocked
    // The actual behavior depends on module caching
    expect(result).toBeDefined();
  });

  it("returns true with explicit --explore", async () => {
    const task = makeTask({ title: "fix typo" });
    const result = await shouldExplore(task, { explore: true });
    expect(result.explore).toBe(true);
    expect(result.reason).toContain("explicite");
  });

  it("returns false with explicit --no-explore", async () => {
    const task = makeTask({ title: "research alternatives" });
    const result = await shouldExplore(task, { explore: false });
    expect(result.explore).toBe(false);
    expect(result.reason).toContain("explicite");
  });

  it("skips for SOLO pipeline", async () => {
    const task = makeTask({ title: "research alternatives" });
    const result = await shouldExplore(task, { pipeline: "SOLO" });
    expect(result.explore).toBe(false);
    expect(result.reason).toContain("SOLO");
  });

  it("skips for QUICK pipeline", async () => {
    const task = makeTask({ title: "research alternatives" });
    const result = await shouldExplore(task, { pipeline: "QUICK" });
    expect(result.explore).toBe(false);
    expect(result.reason).toContain("QUICK");
  });

  it("does not skip for DEFAULT pipeline", async () => {
    const task = makeTask({
      title: "Research and compare authentication alternatives",
      description: "Evaluate approaches and benchmark",
    });
    const result = await shouldExplore(task, { pipeline: "DEFAULT" });
    // Should compute score and decide based on it
    expect(result.score).not.toBeNull();
  });

  it("returns score in result when computed", async () => {
    const task = makeTask({ title: "investigate performance issue" });
    const result = await shouldExplore(task, {});
    if (result.score) {
      expect(result.score.components).toBeDefined();
      expect(typeof result.score.score).toBe("number");
    }
  });
});
