/**
 * Unit Tests — src/dag-executor.ts (S25 T2)
 *
 * Tests for DAG-based parallel execution of agents.
 */

import { describe, it, expect } from "bun:test";
import type { AgentRole, AgentStepResult } from "../../src/orchestrator";
import {
  executeDag,
  DEFAULT_DAG,
  QUICK_DAG,
  REVIEW_DAG,
  getDAG,
  buildSequentialDAG,
} from "../../src/dag-executor";

function makeResult(agentId: AgentRole, durationMs: number = 50, success = true): AgentStepResult {
  return {
    agentId,
    agentName: agentId,
    success,
    output: `output of ${agentId}`,
    structured: null,
    durationMs,
  };
}

function makeRunAgent(delays: Record<string, number> = {}, failures: Set<string> = new Set()) {
  const startTimes: Map<string, number> = new Map();
  const endTimes: Map<string, number> = new Map();
  const startTime = Date.now();

  return {
    runAgent: async (agentId: AgentRole): Promise<AgentStepResult> => {
      startTimes.set(agentId, Date.now() - startTime);
      const delay = delays[agentId] ?? 20;
      await new Promise((r) => setTimeout(r, delay));
      endTimes.set(agentId, Date.now() - startTime);
      return makeResult(agentId, delay, !failures.has(agentId));
    },
    startTimes,
    endTimes,
  };
}

describe("executeDag", () => {
  it("DEFAULT_DAG: analyst+PM parallel, architect waits for both (AC-001)", async () => {
    const { runAgent, startTimes } = makeRunAgent({ analyst: 30, pm: 30, architect: 20, dev: 20, qa: 20 });

    const result = await executeDag(DEFAULT_DAG, runAgent);

    expect(result.allSucceeded).toBe(true);
    expect(result.nodes).toHaveLength(5);

    // analyst and pm should start at roughly the same time
    const analystStart = startTimes.get("analyst")!;
    const pmStart = startTimes.get("pm")!;
    expect(Math.abs(analystStart - pmStart)).toBeLessThan(15);

    // architect should start after both analyst and pm
    const architectStart = startTimes.get("architect")!;
    expect(architectStart).toBeGreaterThan(analystStart + 10);
    expect(architectStart).toBeGreaterThan(pmStart + 10);
  });

  it("agent starts as soon as deps resolved (AC-002)", async () => {
    // pm finishes fast, analyst slow. architect must wait for both.
    const { runAgent, startTimes } = makeRunAgent({ analyst: 100, pm: 10, architect: 10, dev: 10, qa: 10 });

    const result = await executeDag(DEFAULT_DAG, runAgent);

    expect(result.allSucceeded).toBe(true);
    // architect waited for slow analyst
    const architectStart = startTimes.get("architect")!;
    expect(architectStart).toBeGreaterThanOrEqual(90);
  });

  it("parallel wall-clock < sequential sum (AC-003)", async () => {
    const { runAgent } = makeRunAgent({ analyst: 40, pm: 40, architect: 20, dev: 20, qa: 20 });

    const result = await executeDag(DEFAULT_DAG, runAgent);

    const sequentialSum = result.nodes.reduce(
      (sum, n) => sum + (n.result?.durationMs || 0), 0
    );
    // Wall clock should be less than sum (analyst+pm overlap)
    expect(result.totalDurationMs).toBeLessThan(sequentialSum);
  });

  it("QUICK_DAG: dev only, no parallelism overhead (EC-005)", async () => {
    const { runAgent } = makeRunAgent({ dev: 20, qa: 20 });

    const result = await executeDag(QUICK_DAG, runAgent);

    expect(result.allSucceeded).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].agent).toBe("dev");
    expect(result.nodes[1].agent).toBe("qa");
  });

  it("REVIEW_DAG: qa then architect", async () => {
    const { runAgent, startTimes } = makeRunAgent({ qa: 30, architect: 20 });

    const result = await executeDag(REVIEW_DAG, runAgent);

    expect(result.allSucceeded).toBe(true);
    const qaStart = startTimes.get("qa")!;
    const archStart = startTimes.get("architect")!;
    expect(archStart).toBeGreaterThan(qaStart + 15);
  });

  it("failed node blocks dependents", async () => {
    const failures = new Set(["architect"]);
    const { runAgent } = makeRunAgent({ analyst: 10, pm: 10, architect: 10, dev: 10, qa: 10 }, failures);

    const result = await executeDag(DEFAULT_DAG, runAgent);

    expect(result.allSucceeded).toBe(false);
    const devNode = result.nodes.find((n) => n.agent === "dev");
    expect(devNode?.status).toBe("skipped"); // blocked by failed architect
  });

  it("all nodes reach terminal state", async () => {
    const { runAgent } = makeRunAgent();

    const result = await executeDag(DEFAULT_DAG, runAgent);

    for (const node of result.nodes) {
      expect(["succeeded", "failed", "skipped"]).toContain(node.status);
    }
  });

  it("empty DAG completes immediately", async () => {
    const emptyDag = new Map();
    const { runAgent } = makeRunAgent();

    const result = await executeDag(emptyDag, runAgent);

    expect(result.nodes).toHaveLength(0);
    expect(result.allSucceeded).toBe(true);
    expect(result.totalDurationMs).toBeLessThan(50);
  });

  it("onNodeFailed with skip decision allows continuation", async () => {
    const failures = new Set(["analyst"]);
    const { runAgent } = makeRunAgent({ analyst: 10, pm: 10, architect: 10, dev: 10, qa: 10 }, failures);

    const result = await executeDag(DEFAULT_DAG, runAgent, {
      onNodeFailed: async () => "skip",
    });

    const analystNode = result.nodes.find((n) => n.agent === "analyst");
    expect(analystNode?.status).toBe("skipped");

    // architect should still run (deps are succeeded or skipped)
    const archNode = result.nodes.find((n) => n.agent === "architect");
    expect(archNode?.status).toBe("succeeded");
  });
});

describe("getDAG", () => {
  it("returns DEFAULT_DAG for DEFAULT", () => {
    const dag = getDAG("DEFAULT");
    expect(dag.size).toBe(5);
    expect(dag.get("analyst")).toEqual([]);
    expect(dag.get("pm")).toEqual([]);
  });

  it("returns QUICK_DAG for QUICK", () => {
    const dag = getDAG("QUICK");
    expect(dag.size).toBe(2);
  });

  it("builds sequential DAG for unknown type with roles", () => {
    const dag = getDAG("CUSTOM", ["dev", "qa"] as AgentRole[]);
    expect(dag.get("dev")).toEqual([]);
    expect(dag.get("qa")).toEqual(["dev"]);
  });
});

describe("buildSequentialDAG", () => {
  it("creates linear chain", () => {
    const dag = buildSequentialDAG(["analyst", "pm", "dev"] as AgentRole[]);
    expect(dag.get("analyst")).toEqual([]);
    expect(dag.get("pm")).toEqual(["analyst"]);
    expect(dag.get("dev")).toEqual(["pm"]);
  });
});
