/**
 * @module orchestrator
 * @description Barrel re-export for orchestrator sub-modules.
 * Multi-agent pipeline: structured JSON message passing, retry loop,
 * dynamic pipeline selection, cost tracking per agent, blackboard integration.
 */

// ── Re-exports from other modules (backward compatibility) ───
export { getDeliberationReviewer, runDeliberation, shouldDeliberate } from "./deliberation.ts";

// ── agent-step.ts ────────────────────────────────────────────
export { runAgentStep } from "./orchestrator/agent-step.ts";
// ── format.ts ────────────────────────────────────────────────
export {
  buildOrchestrationSummary,
  formatOrchestrationResult,
  logOrchestrationResult,
} from "./orchestrator/format.ts";
// ── pipeline.ts ──────────────────────────────────────────────
export { orchestrate } from "./orchestrator/pipeline.ts";
// ── types.ts ─────────────────────────────────────────────────
export {
  AGENT_COMMAND_MAP,
  type AgentRole,
  type AgentStepResult,
  type OrchestratedResult,
  type OrchestrateOptions,
} from "./orchestrator/types.ts";
export {
  classifyAdaptivePipeline,
  classifyPipeline,
  DEFAULT_PIPELINE,
  LIGHT_PIPELINE,
  type PipelineType,
  QUICK_PIPELINE,
  RESEARCH_PIPELINE,
  REVIEW_PIPELINE,
  SOLO_PIPELINE,
  selectAdaptivePipeline,
  selectPipeline,
} from "./pipeline-selection.ts";
