/**
 * @module orchestrator.types
 * @description Types, interfaces, and constants for the orchestrator pipeline.
 */

import type { DriftReport } from "../adversarial-verifier.ts";
import type { StructuredAgentOutput } from "../agent-schemas.ts";
import type { generateTraceabilityReport } from "../blackboard.ts";
import type { GateEvaluation } from "../gate-evaluator.ts";

// ── Types ────────────────────────────────────────────────────

export type AgentRole =
  | "analyst"
  | "pm"
  | "architect"
  | "dev"
  | "qa"
  | "sm"
  | "explorer"
  | "planner";

export interface AgentStepResult {
  agentId: AgentRole;
  agentName: string;
  success: boolean;
  output: string;
  structured: StructuredAgentOutput | null;
  error?: string;
  durationMs: number;
  retryCount?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
}

export interface OrchestratedResult {
  success: boolean;
  steps: AgentStepResult[];
  totalDurationMs: number;
  summary: string;
  /** S24: Blackboard data (only present when useBlackboard=true) */
  blackboard?: {
    sessionId: string;
    gateEvaluations: GateEvaluation[];
    driftReport: DriftReport | null;
    traceabilityReport: ReturnType<typeof generateTraceabilityReport> | null;
  };
}

/** Maps agent roles to the workflow command they execute */
export const AGENT_COMMAND_MAP: Record<AgentRole, string> = {
  analyst: "patterns",
  pm: "plan",
  architect: "architecture",
  dev: "exec",
  qa: "alerts",
  sm: "sprint",
  explorer: "explore",
  planner: "plan",
};

export interface OrchestrateOptions {
  pipeline?: AgentRole[];
  onProgress?: (message: string) => Promise<void>;
  /** Stop the pipeline if an agent fails */
  stopOnFailure?: boolean;
  /** Skip agents that aren't relevant (e.g., analyst for simple tasks) */
  skipIfSimple?: boolean;
  /** Max retry attempts per agent (default: 0 = no retry) */
  maxRetries?: number;
  /** Use dynamic pipeline selection based on task analysis (S22-06) */
  autoPipeline?: boolean;
  /** Use blackboard for structured context passing (S24) */
  useBlackboard?: boolean;
  /** S33: Resume from a previous pipeline run session ID */
  resumeSessionId?: string;
  /** S34: Per-role model overrides from LLM router (AC-019) */
  modelOverrides?: Partial<Record<AgentRole, string>>;
  /** S34: Enable model cascade for agents (Haiku -> Sonnet -> Opus) */
  cascade?: boolean;
  /** S43: Conversation context from the session that triggered this pipeline */
  conversationContext?: string;
  /** P1: Run the last 2 agents in parallel (overlap mode). Incompatible with useBlackboard */
  overlap?: boolean;
  /** P2: Rebuild agent context via buildAgentContext() between each agent (except the first) */
  refreshContext?: boolean;
  /** Skip adversarial challenge (P2+E1) even if feature flag is active. F-EC-4: skips both P2 and E1 together */
  skipChallenge?: boolean;
  /** Callback to pause/resume pipeline on adversarial PAUSE (F-DA-1) */
  onAdversarialPause?: (
    result: import("../agent-schemas.ts").AdversarialResult,
    impact: import("../agent-schemas.ts").ImpactAnalysisResult | null,
  ) => Promise<boolean>;
}
