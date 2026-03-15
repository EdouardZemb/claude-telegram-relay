/**
 * DAG Executor — S25 T2
 *
 * Replaces sequential for...of with a DAG-based parallel executor.
 * Evaluates dependencies and runs agents as soon as their deps are satisfied.
 * Agnostic to agents/blackboard — receives a graph and a run callback.
 */

import type { AgentRole, AgentStepResult } from "./orchestrator.ts";
import { Semaphore } from "./semaphore.ts";

// ── Types ────────────────────────────────────────────────────

export type DAGNodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface DAGNode {
  agent: AgentRole;
  deps: AgentRole[];
  status: DAGNodeStatus;
  result: AgentStepResult | null;
}

/** Adjacency list: agent -> list of dependencies */
export type DAGDefinition = Map<AgentRole, AgentRole[]>;

export interface DAGExecutionResult {
  nodes: DAGNode[];
  allSucceeded: boolean;
  totalDurationMs: number;
}

export type RunAgentFn = (
  agentId: AgentRole,
  previousResults: Map<AgentRole, AgentStepResult>
) => Promise<AgentStepResult>;

export type OnNodeFailedFn = (
  node: DAGNode
) => Promise<"retry" | "skip" | "escalate">;

// ── Pre-defined DAGs ────────────────────────────────────────

export const DEFAULT_DAG: DAGDefinition = new Map([
  ["analyst", []],
  ["pm", []],
  ["architect", ["analyst", "pm"]],
  ["dev", ["architect"]],
  ["qa", ["dev"]],
]);

export const QUICK_DAG: DAGDefinition = new Map([
  ["dev", []],
  ["qa", ["dev"]],
]);

export const REVIEW_DAG: DAGDefinition = new Map([
  ["qa", []],
  ["architect", ["qa"]],
]);

/**
 * Get the pre-defined DAG for a pipeline type.
 * Falls back to building a sequential DAG from a role list.
 */
export function getDAG(pipelineType: string, roles?: AgentRole[]): DAGDefinition {
  switch (pipelineType) {
    case "DEFAULT":
      return new Map(DEFAULT_DAG);
    case "QUICK":
      return new Map(QUICK_DAG);
    case "REVIEW":
      return new Map(REVIEW_DAG);
    default:
      // Build sequential DAG from role list
      if (roles && roles.length > 0) {
        return buildSequentialDAG(roles);
      }
      return new Map(DEFAULT_DAG);
  }
}

/**
 * Build a sequential DAG where each agent depends on the previous one.
 */
export function buildSequentialDAG(roles: AgentRole[]): DAGDefinition {
  const dag: DAGDefinition = new Map();
  for (let i = 0; i < roles.length; i++) {
    dag.set(roles[i], i > 0 ? [roles[i - 1]] : []);
  }
  return dag;
}

// ── DAG Executor ────────────────────────────────────────────

/**
 * Execute a DAG of agents with parallel scheduling.
 *
 * Algorithm:
 * 1. Initialize all nodes as pending
 * 2. Find nodes whose deps are all succeeded -> launch in parallel (via semaphore)
 * 3. When a node completes, update status, check for newly unblocked nodes
 * 4. Repeat until all nodes are terminal
 */
export async function executeDag(
  dag: DAGDefinition,
  runAgent: RunAgentFn,
  options: {
    maxConcurrency?: number;
    onNodeFailed?: OnNodeFailedFn;
    onNodeStarted?: (agent: AgentRole) => void;
    onNodeCompleted?: (agent: AgentRole, result: AgentStepResult) => void;
  } = {}
): Promise<DAGExecutionResult> {
  const startTime = Date.now();
  const semaphore = new Semaphore(options.maxConcurrency ?? 3);

  // Initialize nodes
  const nodes = new Map<AgentRole, DAGNode>();
  for (const [agent, deps] of dag) {
    nodes.set(agent, {
      agent,
      deps: [...deps],
      status: "pending",
      result: null,
    });
  }

  // Handle empty DAG
  if (nodes.size === 0) {
    return { nodes: [], allSucceeded: true, totalDurationMs: 0 };
  }

  // Collect completed results for downstream agents
  const results = new Map<AgentRole, AgentStepResult>();

  // Track running promises
  const running = new Map<AgentRole, Promise<void>>();

  /**
   * Check if a node's dependencies are all satisfied.
   */
  function isReady(node: DAGNode): boolean {
    return node.status === "pending" && node.deps.every((dep) => {
      const depNode = nodes.get(dep);
      return depNode && (depNode.status === "succeeded" || depNode.status === "skipped");
    });
  }

  /**
   * Check if all deps have failed/escalated (meaning this node can't run).
   */
  function isBlocked(node: DAGNode): boolean {
    return node.deps.some((dep) => {
      const depNode = nodes.get(dep);
      return depNode && depNode.status === "failed";
    });
  }

  /**
   * Launch a single agent node.
   */
  async function launchNode(node: DAGNode): Promise<void> {
    await semaphore.acquire();
    try {
      node.status = "running";
      options.onNodeStarted?.(node.agent);

      const result = await runAgent(node.agent, results);
      node.result = result;

      if (result.success) {
        node.status = "succeeded";
        results.set(node.agent, result);
        options.onNodeCompleted?.(node.agent, result);
      } else {
        // Let supervisor/callback decide
        if (options.onNodeFailed) {
          const decision = await options.onNodeFailed(node);
          if (decision === "skip") {
            node.status = "skipped";
          } else if (decision === "retry") {
            // Re-run the agent
            node.status = "running";
            const retryResult = await runAgent(node.agent, results);
            node.result = retryResult;
            if (retryResult.success) {
              node.status = "succeeded";
              results.set(node.agent, retryResult);
              options.onNodeCompleted?.(node.agent, retryResult);
            } else {
              node.status = "failed";
              options.onNodeCompleted?.(node.agent, retryResult);
            }
          } else {
            node.status = "failed";
            options.onNodeCompleted?.(node.agent, result);
          }
        } else {
          node.status = "failed";
          options.onNodeCompleted?.(node.agent, result);
        }
      }
    } finally {
      semaphore.release();
      running.delete(node.agent);
    }
  }

  // Main loop: keep scheduling until all nodes are terminal
  while (true) {
    // Mark blocked nodes
    for (const node of nodes.values()) {
      if (node.status === "pending" && isBlocked(node)) {
        node.status = "skipped";
      }
    }

    // Find ready nodes not yet running
    const ready: DAGNode[] = [];
    for (const node of nodes.values()) {
      if (isReady(node) && !running.has(node.agent)) {
        ready.push(node);
      }
    }

    // Launch all ready nodes
    for (const node of ready) {
      const promise = launchNode(node);
      running.set(node.agent, promise);
    }

    // If nothing is running and nothing is ready, we're done
    if (running.size === 0) break;

    // Wait for at least one running node to complete
    await Promise.race([...running.values()]);
  }

  const allNodes = [...nodes.values()];
  return {
    nodes: allNodes,
    allSucceeded: allNodes.every((n) => n.status === "succeeded" || n.status === "skipped"),
    totalDurationMs: Date.now() - startTime,
  };
}
