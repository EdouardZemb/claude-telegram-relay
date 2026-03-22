/**
 * @module pipeline-state
 * @description Pipeline checkpoint/resume: persists pipeline execution state after each
 * agent step, enables resuming failed pipelines from the last successful agent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentMessage } from "./agent-schemas.ts";
import { createLogger } from "./logger.ts";
import type { AgentRole } from "./orchestrator.ts";

const log = createLogger("pipeline-state");
// ── Types ────────────────────────────────────────────────────

export interface PipelineState {
  sessionId: string;
  taskId: string;
  pipelineType: string;
  pipelineAgents: AgentRole[];
  currentStep: number;
  stepsCompleted: StepSnapshot[];
  stepsResults: AgentMessage[];
  blackboardId?: string;
  status: "running" | "completed" | "failed" | "paused";
  error?: string;
}

export interface StepSnapshot {
  agentId: AgentRole;
  success: boolean;
  durationMs: number;
  completedAt: string;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
}

// ── In-Memory Fallback ───────────────────────────────────────

const memoryStore = new Map<string, PipelineState>();

/** Exposed for testing: clear the in-memory store */
export function _clearMemoryStore(): void {
  memoryStore.clear();
}

// ── Core Functions ───────────────────────────────────────────

/**
 * Create a new pipeline run entry.
 * Returns the session ID.
 */
export async function createPipelineRun(
  supabase: SupabaseClient | null,
  taskId: string,
  sessionId: string,
  pipelineType: string,
  pipelineAgents: AgentRole[],
  blackboardId?: string,
): Promise<string> {
  const state: PipelineState = {
    sessionId,
    taskId,
    pipelineType,
    pipelineAgents,
    currentStep: 0,
    stepsCompleted: [],
    stepsResults: [],
    blackboardId,
    status: "running",
  };

  if (supabase) {
    const { error } = await supabase.from("pipeline_runs").insert({
      session_id: sessionId,
      task_id: taskId,
      pipeline_type: pipelineType,
      pipeline_agents: pipelineAgents,
      current_step: 0,
      steps_completed: [],
      steps_results: [],
      blackboard_id: blackboardId || null,
      status: "running",
    });
    if (error) {
      log.error("createPipelineRun error", { error: String(error) });
      memoryStore.set(sessionId, state);
    }
  } else {
    memoryStore.set(sessionId, state);
  }

  return sessionId;
}

/**
 * Save pipeline state after an agent step completes.
 * Increments currentStep and appends to stepsCompleted/stepsResults.
 */
export async function savePipelineStep(
  supabase: SupabaseClient | null,
  sessionId: string,
  step: StepSnapshot,
  message: AgentMessage,
): Promise<void> {
  if (supabase) {
    // Load current state to append
    const { data: current, error: loadError } = await supabase
      .from("pipeline_runs")
      .select("current_step, steps_completed, steps_results")
      .eq("session_id", sessionId)
      .single();

    if (loadError || !current) {
      // Fallback to memory
      const memState = memoryStore.get(sessionId);
      if (memState) {
        memState.currentStep++;
        memState.stepsCompleted.push(step);
        memState.stepsResults.push(message);
      }
      return;
    }

    const stepsCompleted = [...(current.steps_completed || []), step];
    const stepsResults = [...(current.steps_results || []), message];

    const { error } = await supabase
      .from("pipeline_runs")
      .update({
        current_step: current.current_step + 1,
        steps_completed: stepsCompleted,
        steps_results: stepsResults,
      })
      .eq("session_id", sessionId);

    if (error) log.error("savePipelineStep error", { error: String(error) });
  } else {
    const state = memoryStore.get(sessionId);
    if (state) {
      state.currentStep++;
      state.stepsCompleted.push(step);
      state.stepsResults.push(message);
    }
  }
}

/**
 * Update pipeline run status.
 */
export async function updatePipelineStatus(
  supabase: SupabaseClient | null,
  sessionId: string,
  status: PipelineState["status"],
  error?: string,
): Promise<void> {
  if (supabase) {
    const updates: Record<string, unknown> = { status };
    if (error) updates.error = error;

    const { error: dbError } = await supabase
      .from("pipeline_runs")
      .update(updates)
      .eq("session_id", sessionId);

    if (dbError) log.error("updatePipelineStatus error", { error: String(dbError) });
  } else {
    const state = memoryStore.get(sessionId);
    if (state) {
      state.status = status;
      if (error) state.error = error;
    }
  }
}

/**
 * Load pipeline state for resume.
 * Returns null if no state found.
 */
export async function loadPipelineState(
  supabase: SupabaseClient | null,
  sessionId: string,
): Promise<PipelineState | null> {
  if (supabase) {
    const { data, error } = await supabase
      .from("pipeline_runs")
      .select("*")
      .eq("session_id", sessionId)
      .single();

    if (error || !data) {
      return memoryStore.get(sessionId) ?? null;
    }

    return {
      sessionId: data.session_id,
      taskId: data.task_id,
      pipelineType: data.pipeline_type,
      pipelineAgents: data.pipeline_agents,
      currentStep: data.current_step,
      stepsCompleted: data.steps_completed || [],
      stepsResults: data.steps_results || [],
      blackboardId: data.blackboard_id || undefined,
      status: data.status,
      error: data.error || undefined,
    };
  }

  return memoryStore.get(sessionId) ?? null;
}

/**
 * Find the most recent pipeline run for a task (for --resume without explicit session ID).
 * Returns the session ID or null.
 */
export async function findLatestPipelineRun(
  supabase: SupabaseClient | null,
  taskId: string,
): Promise<string | null> {
  if (supabase) {
    const { data, error } = await supabase
      .from("pipeline_runs")
      .select("session_id")
      .eq("task_id", taskId)
      .in("status", ["failed", "paused"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return null;
    return data.session_id;
  }

  // In-memory: find by task ID
  for (const [sessionId, state] of memoryStore) {
    if (state.taskId === taskId && (state.status === "failed" || state.status === "paused")) {
      return sessionId;
    }
  }
  return null;
}

/**
 * Build resume context from a saved pipeline state.
 * Returns the previously completed agent messages so the resumed pipeline
 * can continue with full context from prior agents.
 */
export function buildResumeContext(state: PipelineState): {
  resumeFromStep: number;
  previousMessages: AgentMessage[];
  remainingAgents: AgentRole[];
} {
  return {
    resumeFromStep: state.currentStep,
    previousMessages: state.stepsResults,
    remainingAgents: state.pipelineAgents.slice(state.currentStep),
  };
}
