/**
 * @module supervisor
 * @description Deterministic TypeScript supervisor: agent status tracking,
 * retry/skip/escalate decisions, timeout, structured report with speedup ratio.
 */

/**
 * Supervisor — S25 T4
 *
 * Deterministic TypeScript supervisor for parallel agent execution.
 * Zero LLM cost. Tracks statuses, retries, timeouts, escalation.
 */

import type { AgentRole, AgentStepResult } from "./orchestrator.ts";

// ── Types ────────────────────────────────────────────────────

export type AgentStatusType =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "retrying"
  | "skipped"
  | "timed_out";

export interface AgentStatus {
  id: string;
  role: AgentRole;
  status: AgentStatusType;
  attempts: number;
  maxAttempts: number;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number;
  result: AgentStepResult | null;
  error?: string;
}

export type SupervisorDecision = "retry" | "skip" | "escalate";

export interface SupervisorReport {
  succeeded: AgentStatus[];
  failed: AgentStatus[];
  skipped: AgentStatus[];
  retried: AgentStatus[];
  timed_out: AgentStatus[];
  total_wall_time_ms: number;
  sequential_equivalent_ms: number;
  speedup_ratio: number;
  per_agent_timing: Array<{
    agent: AgentRole;
    startMs: number;
    endMs: number;
    durationMs: number;
  }>;
  /** S38: Inter-agent communication metrics */
  message_count: number;
  clarification_count: number;
  conflict_count: number;
}

/** Non-critical agents that can be skipped on failure */
const NON_CRITICAL_AGENTS: AgentRole[] = ["analyst", "sm"];

/** Default timeout per agent: 10 minutes */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// ── Supervisor ────────────────────────────────────────────────

export class Supervisor {
  private agents: Map<string, AgentStatus> = new Map();
  private pipelineStartTime: number = 0;
  private maxAttempts: number;
  private timeoutMs: number;
  /** S38: Inter-agent communication counters */
  private _messageCount: number = 0;
  private _clarificationCount: number = 0;
  private _conflictCount: number = 0;

  constructor(options: { maxAttempts?: number; timeoutMs?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Register an agent to track.
   */
  register(agentId: string, role: AgentRole): void {
    this.agents.set(agentId, {
      id: agentId,
      role,
      status: "pending",
      attempts: 0,
      maxAttempts: this.maxAttempts,
      startedAt: null,
      completedAt: null,
      durationMs: 0,
      result: null,
    });
  }

  /**
   * Mark the start of pipeline execution.
   */
  startPipeline(): void {
    this.pipelineStartTime = Date.now();
  }

  /**
   * Mark an agent as started.
   */
  markStarted(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.status = "running";
    agent.startedAt = Date.now();
    agent.attempts++;
  }

  /**
   * Mark an agent as completed (success or failure).
   */
  markCompleted(agentId: string, result: AgentStepResult): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.completedAt = Date.now();
    agent.durationMs = result.durationMs;
    agent.result = result;

    if (result.success) {
      agent.status = "succeeded";
    } else {
      agent.status = "failed";
      agent.error = result.error;
    }
  }

  /**
   * Mark an agent as timed out.
   */
  markTimedOut(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.status = "timed_out";
    agent.completedAt = Date.now();
    agent.durationMs = agent.startedAt ? Date.now() - agent.startedAt : 0;
    agent.error = `Timeout after ${this.timeoutMs}ms`;
  }

  /**
   * Decide what to do when an agent fails.
   */
  decide(agentId: string): SupervisorDecision {
    const agent = this.agents.get(agentId);
    if (!agent) return "escalate";

    if (agent.attempts < agent.maxAttempts) {
      agent.status = "retrying";
      return "retry";
    }

    if (NON_CRITICAL_AGENTS.includes(agent.role)) {
      agent.status = "skipped";
      return "skip";
    }

    return "escalate";
  }

  /**
   * Check if an agent has exceeded its timeout.
   */
  isTimedOut(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.startedAt) return false;
    return Date.now() - agent.startedAt > this.timeoutMs;
  }

  /**
   * Get the current status of an agent.
   */
  getStatus(agentId: string): AgentStatus | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all agent statuses.
   */
  getAllStatuses(): AgentStatus[] {
    return [...this.agents.values()];
  }

  /**
   * S38: Record a message event.
   */
  recordMessage(): void {
    this._messageCount++;
  }

  /**
   * S38: Record a clarification event.
   */
  recordClarification(): void {
    this._clarificationCount++;
  }

  /**
   * S38: Record a conflict event.
   */
  recordConflict(): void {
    this._conflictCount++;
  }

  /**
   * S38: Get inter-agent communication counters.
   */
  getInterAgentMetrics(): { messageCount: number; clarificationCount: number; conflictCount: number } {
    return {
      messageCount: this._messageCount,
      clarificationCount: this._clarificationCount,
      conflictCount: this._conflictCount,
    };
  }

  /**
   * Generate the final supervisor report.
   */
  generateReport(): SupervisorReport {
    const statuses = [...this.agents.values()];
    const now = Date.now();
    const wallTime = this.pipelineStartTime ? now - this.pipelineStartTime : 0;
    const sequentialMs = statuses.reduce((sum, a) => sum + a.durationMs, 0);

    const perAgentTiming = statuses
      .filter((a) => a.startedAt !== null)
      .map((a) => ({
        agent: a.role,
        startMs: a.startedAt! - this.pipelineStartTime,
        endMs: (a.completedAt || now) - this.pipelineStartTime,
        durationMs: a.durationMs,
      }));

    return {
      succeeded: statuses.filter((a) => a.status === "succeeded"),
      failed: statuses.filter((a) => a.status === "failed"),
      skipped: statuses.filter((a) => a.status === "skipped"),
      retried: statuses.filter((a) => a.attempts > 1),
      timed_out: statuses.filter((a) => a.status === "timed_out"),
      total_wall_time_ms: wallTime,
      sequential_equivalent_ms: sequentialMs,
      speedup_ratio: wallTime > 0 ? sequentialMs / wallTime : 1,
      per_agent_timing: perAgentTiming,
      message_count: this._messageCount,
      clarification_count: this._clarificationCount,
      conflict_count: this._conflictCount,
    };
  }
}
