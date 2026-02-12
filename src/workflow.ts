/**
 * Workflow Engine — S11 Amelioration Continue
 *
 * Charge le workflow configurable depuis config/workflow.yaml,
 * expose les etapes, transitions et checkpoints,
 * et log chaque transition dans workflow_logs.
 */

import { parse } from "yaml";
import { readFileSync } from "fs";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

export interface CheckpointConfig {
  enabled: boolean;
  mode: "off" | "light" | "strict";
  criteria?: string[];
}

export interface WorkflowStep {
  id: string;
  label: string;
  description: string;
  checkpoint: CheckpointConfig;
  skip_conditions?: Array<{ priority_lte?: number; description?: string }>;
}

export interface WorkflowTransition {
  from: string;
  to: string;
  condition?: string;
}

export interface CheckpointModeConfig {
  description: string;
  auto_pass?: boolean;
  max_retries?: number;
}

export interface WorkflowConfig {
  version: number;
  steps: WorkflowStep[];
  transitions: WorkflowTransition[];
  checkpoint_modes: Record<string, CheckpointModeConfig>;
}

export interface WorkflowLogEntry {
  task_id?: string;
  sprint_id?: string;
  step_from: string;
  step_to: string;
  duration_seconds?: number;
  had_rework?: boolean;
  checkpoint_mode?: string;
  checkpoint_result?: "pass" | "fail" | "skipped" | "corrected";
  checkpoint_notes?: string;
  agent_notes?: string;
}

// ── Load Config ──────────────────────────────────────────────

const CONFIG_PATH = join(
  process.env.PROJECT_DIR || join(import.meta.dir, ".."),
  "config",
  "workflow.yaml"
);

let _config: WorkflowConfig | null = null;

export function loadWorkflowConfig(): WorkflowConfig {
  if (_config) return _config;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    _config = parse(raw) as WorkflowConfig;
    return _config;
  } catch (err) {
    console.error("Failed to load workflow config:", err);
    return getDefaultConfig();
  }
}

export function reloadWorkflowConfig(): WorkflowConfig {
  _config = null;
  return loadWorkflowConfig();
}

function getDefaultConfig(): WorkflowConfig {
  return {
    version: 1,
    steps: [
      { id: "request", label: "Demande", description: "Reception de la demande", checkpoint: { enabled: false, mode: "off" } },
      { id: "decomposition", label: "Decomposition", description: "Decoupage en sous-taches", checkpoint: { enabled: true, mode: "light" } },
      { id: "validation", label: "Validation", description: "Validation utilisateur", checkpoint: { enabled: false, mode: "off" } },
      { id: "execution", label: "Execution", description: "Implementation", checkpoint: { enabled: true, mode: "strict" } },
      { id: "review", label: "Review", description: "Verification", checkpoint: { enabled: true, mode: "light" } },
      { id: "closure", label: "Cloture", description: "Merge et deploy", checkpoint: { enabled: false, mode: "off" } },
    ],
    transitions: [
      { from: "request", to: "decomposition" },
      { from: "decomposition", to: "validation" },
      { from: "decomposition", to: "execution", condition: "auto_validated" },
      { from: "validation", to: "execution" },
      { from: "execution", to: "review" },
      { from: "review", to: "closure" },
    ],
    checkpoint_modes: {
      off: { description: "Pas d'evaluation", auto_pass: true },
      light: { description: "Verification rapide", max_retries: 1 },
      strict: { description: "Evaluation approfondie", max_retries: 3 },
    },
  };
}

// ── Query Helpers ────────────────────────────────────────────

export function getStep(stepId: string): WorkflowStep | undefined {
  const config = loadWorkflowConfig();
  return config.steps.find((s) => s.id === stepId);
}

export function getStepIds(): string[] {
  const config = loadWorkflowConfig();
  return config.steps.map((s) => s.id);
}

export function getValidTransitions(fromStep: string): WorkflowTransition[] {
  const config = loadWorkflowConfig();
  return config.transitions.filter((t) => t.from === fromStep);
}

export function canTransition(fromStep: string, toStep: string): boolean {
  return getValidTransitions(fromStep).some((t) => t.to === toStep);
}

export function getCheckpointConfig(stepId: string): CheckpointConfig {
  const step = getStep(stepId);
  return step?.checkpoint ?? { enabled: false, mode: "off" };
}

// ── Workflow Tracker ─────────────────────────────────────────

export class WorkflowTracker {
  private supabase: SupabaseClient;
  private taskId: string | undefined;
  private sprintId: string | undefined;
  private currentStep: string;
  private stepStartedAt: number;

  constructor(
    supabase: SupabaseClient,
    opts?: { taskId?: string; sprintId?: string; startStep?: string }
  ) {
    this.supabase = supabase;
    this.taskId = opts?.taskId;
    this.sprintId = opts?.sprintId;
    this.currentStep = opts?.startStep ?? "request";
    this.stepStartedAt = Date.now();
  }

  getCurrentStep(): string {
    return this.currentStep;
  }

  async transition(
    toStep: string,
    opts?: {
      had_rework?: boolean;
      checkpoint_result?: "pass" | "fail" | "skipped" | "corrected";
      checkpoint_notes?: string;
      agent_notes?: string;
    }
  ): Promise<boolean> {
    const checkpoint = getCheckpointConfig(this.currentStep);
    const durationSeconds = Math.round((Date.now() - this.stepStartedAt) / 1000);

    const entry: WorkflowLogEntry = {
      task_id: this.taskId,
      sprint_id: this.sprintId,
      step_from: this.currentStep,
      step_to: toStep,
      duration_seconds: durationSeconds,
      had_rework: opts?.had_rework ?? false,
      checkpoint_mode: checkpoint.mode,
      checkpoint_result: opts?.checkpoint_result ?? (checkpoint.enabled ? undefined : "skipped"),
      checkpoint_notes: opts?.checkpoint_notes,
      agent_notes: opts?.agent_notes,
    };

    const { error } = await this.supabase.from("workflow_logs").insert(entry);
    if (error) {
      console.error("workflow_logs insert error:", error);
      return false;
    }

    this.currentStep = toStep;
    this.stepStartedAt = Date.now();
    return true;
  }

  async logCheckpoint(
    result: "pass" | "fail" | "corrected",
    notes?: string
  ): Promise<void> {
    const checkpoint = getCheckpointConfig(this.currentStep);
    await this.supabase.from("workflow_logs").insert({
      task_id: this.taskId,
      sprint_id: this.sprintId,
      step_from: this.currentStep,
      step_to: this.currentStep,
      duration_seconds: 0,
      checkpoint_mode: checkpoint.mode,
      checkpoint_result: result,
      checkpoint_notes: notes,
    });
  }
}

// ── Metrics Collection ───────────────────────────────────────

export async function collectSprintMetrics(
  supabase: SupabaseClient,
  sprintId: string
): Promise<boolean> {
  // Get task stats
  const { data: tasks, error: tasksError } = await supabase
    .from("tasks")
    .select("id, status, created_at, completed_at")
    .eq("sprint", sprintId);

  if (tasksError || !tasks) {
    console.error("collectSprintMetrics tasks error:", tasksError);
    return false;
  }

  const planned = tasks.length;
  const completed = tasks.filter((t: any) => t.status === "done").length;

  // Avg delivery time (hours from created to completed)
  const deliveryTimes = tasks
    .filter((t: any) => t.status === "done" && t.completed_at)
    .map((t: any) => {
      const created = new Date(t.created_at).getTime();
      const done = new Date(t.completed_at).getTime();
      return (done - created) / (1000 * 60 * 60);
    });
  const avgDeliveryHours =
    deliveryTimes.length > 0
      ? deliveryTimes.reduce((a: number, b: number) => a + b, 0) / deliveryTimes.length
      : null;

  // Get workflow log stats for this sprint
  const { data: logs } = await supabase
    .from("workflow_logs")
    .select("had_rework, checkpoint_result")
    .eq("sprint_id", sprintId);

  const reworkCount = logs?.filter((l: any) => l.had_rework).length ?? 0;

  // First pass rate: tasks that went through review without rework
  const taskIds = tasks.map((t: any) => t.id);
  const { data: reviewLogs } = await supabase
    .from("workflow_logs")
    .select("task_id, had_rework")
    .eq("step_to", "review")
    .in("task_id", taskIds.length > 0 ? taskIds : ["none"]);

  const reviewedTasks = new Set(reviewLogs?.map((l: any) => l.task_id) ?? []);
  const firstPassTasks = reviewLogs?.filter((l: any) => !l.had_rework) ?? [];
  const firstPassRate =
    reviewedTasks.size > 0
      ? (firstPassTasks.length / reviewedTasks.size) * 100
      : null;

  // Upsert metrics
  const { error: upsertError } = await supabase
    .from("sprint_metrics")
    .upsert(
      {
        sprint_id: sprintId,
        tasks_planned: planned,
        tasks_completed: completed,
        avg_delivery_hours: avgDeliveryHours ? Math.round(avgDeliveryHours * 100) / 100 : null,
        first_pass_rate: firstPassRate ? Math.round(firstPassRate * 100) / 100 : null,
        rework_count: reworkCount,
        sprint_ended_at: new Date().toISOString(),
      },
      { onConflict: "sprint_id" }
    );

  if (upsertError) {
    console.error("collectSprintMetrics upsert error:", upsertError);
    return false;
  }

  return true;
}

export async function getSprintMetrics(
  supabase: SupabaseClient,
  sprintId: string
): Promise<any | null> {
  const { data, error } = await supabase
    .from("sprint_metrics")
    .select("*")
    .eq("sprint_id", sprintId)
    .single();

  if (error) return null;
  return data;
}

export async function getAllSprintMetrics(
  supabase: SupabaseClient
): Promise<any[]> {
  const { data, error } = await supabase
    .from("sprint_metrics")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return [];
  return data ?? [];
}

// ── Formatting ───────────────────────────────────────────────

export function formatMetrics(metrics: any): string {
  if (!metrics) return "Pas de metriques disponibles pour ce sprint.";

  const lines = [
    `Metriques Sprint ${metrics.sprint_id}`,
    "",
    `Taches: ${metrics.tasks_completed}/${metrics.tasks_planned} (${metrics.completion_rate ?? 0}%)`,
  ];

  if (metrics.avg_delivery_hours !== null) {
    lines.push(`Temps moyen de livraison: ${metrics.avg_delivery_hours}h`);
  }
  if (metrics.first_pass_rate !== null) {
    lines.push(`Taux premier passage: ${metrics.first_pass_rate}%`);
  }
  if (metrics.rework_count > 0) {
    lines.push(`Retouches: ${metrics.rework_count}`);
  }
  if (metrics.incidents_count > 0) {
    lines.push(`Incidents: ${metrics.incidents_count}`);
  }

  if (metrics.sprint_ended_at) {
    const ended = new Date(metrics.sprint_ended_at);
    lines.push(`Cloture: ${ended.toLocaleDateString("fr-FR")}`);
  }

  return lines.join("\n");
}

export function formatMetricsComparison(metricsList: any[]): string {
  if (metricsList.length === 0) return "Pas de metriques disponibles.";

  const lines = ["Evolution des sprints", ""];
  for (const m of metricsList) {
    const rate = m.completion_rate ?? 0;
    const bar = "=".repeat(Math.round(rate / 5)) + " " + rate + "%";
    lines.push(`${m.sprint_id}: ${bar} (${m.tasks_completed}/${m.tasks_planned})`);
  }

  return lines.join("\n");
}

// ── Retro Generation ─────────────────────────────────────────

export async function generateRetroData(
  supabase: SupabaseClient,
  sprintId: string
): Promise<{
  metrics: any;
  workflowStats: {
    totalTransitions: number;
    reworkCount: number;
    avgStepDuration: Record<string, number>;
    checkpointResults: Record<string, number>;
  };
  tasks: any[];
} | null> {
  const metrics = await getSprintMetrics(supabase, sprintId);

  // Get workflow logs for the sprint
  const { data: logs } = await supabase
    .from("workflow_logs")
    .select("*")
    .eq("sprint_id", sprintId)
    .order("created_at", { ascending: true });

  // Get tasks
  const { data: tasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("sprint", sprintId);

  // Compute workflow stats
  const totalTransitions = logs?.length ?? 0;
  const reworkCount = logs?.filter((l: any) => l.had_rework).length ?? 0;

  // Avg duration per step
  const stepDurations: Record<string, number[]> = {};
  for (const log of logs ?? []) {
    if (log.duration_seconds && log.step_from !== log.step_to) {
      if (!stepDurations[log.step_from]) stepDurations[log.step_from] = [];
      stepDurations[log.step_from].push(log.duration_seconds);
    }
  }
  const avgStepDuration: Record<string, number> = {};
  for (const [step, durations] of Object.entries(stepDurations)) {
    avgStepDuration[step] = Math.round(
      durations.reduce((a, b) => a + b, 0) / durations.length
    );
  }

  // Checkpoint results
  const checkpointResults: Record<string, number> = {};
  for (const log of logs ?? []) {
    if (log.checkpoint_result) {
      checkpointResults[log.checkpoint_result] =
        (checkpointResults[log.checkpoint_result] ?? 0) + 1;
    }
  }

  return {
    metrics,
    workflowStats: { totalTransitions, reworkCount, avgStepDuration, checkpointResults },
    tasks: tasks ?? [],
  };
}

export async function saveRetro(
  supabase: SupabaseClient,
  sprintId: string,
  retro: {
    what_worked: string[];
    what_didnt: string[];
    patterns_detected: string[];
    actions_proposed: Array<{ action: string; priority: string }>;
    raw_analysis: string;
  }
): Promise<boolean> {
  const { error } = await supabase.from("retros").upsert(
    {
      sprint_id: sprintId,
      what_worked: retro.what_worked,
      what_didnt: retro.what_didnt,
      patterns_detected: retro.patterns_detected,
      actions_proposed: retro.actions_proposed,
      raw_analysis: retro.raw_analysis,
    },
    { onConflict: "sprint_id" }
  );

  if (error) {
    console.error("saveRetro error:", error);
    return false;
  }
  return true;
}

export async function acceptRetroActions(
  supabase: SupabaseClient,
  sprintId: string,
  acceptedActions: Array<{ action: string; priority: string }>
): Promise<boolean> {
  const { error } = await supabase
    .from("retros")
    .update({
      actions_accepted: acceptedActions,
      validated_at: new Date().toISOString(),
    })
    .eq("sprint_id", sprintId);

  if (error) {
    console.error("acceptRetroActions error:", error);
    return false;
  }
  return true;
}

export async function getRetro(
  supabase: SupabaseClient,
  sprintId: string
): Promise<any | null> {
  const { data, error } = await supabase
    .from("retros")
    .select("*")
    .eq("sprint_id", sprintId)
    .single();

  if (error) return null;
  return data;
}

export function formatRetro(retro: any): string {
  if (!retro) return "Pas de retro disponible pour ce sprint.";

  const lines = [`Retro Sprint ${retro.sprint_id}`, ""];

  if (retro.what_worked?.length > 0) {
    lines.push("Ce qui a bien marche :");
    for (const item of retro.what_worked) lines.push(`  + ${item}`);
    lines.push("");
  }

  if (retro.what_didnt?.length > 0) {
    lines.push("Ce qui a coince :");
    for (const item of retro.what_didnt) lines.push(`  - ${item}`);
    lines.push("");
  }

  if (retro.patterns_detected?.length > 0) {
    lines.push("Patterns detectes :");
    for (const item of retro.patterns_detected) lines.push(`  ~ ${item}`);
    lines.push("");
  }

  if (retro.actions_proposed?.length > 0) {
    lines.push("Actions proposees :");
    for (const action of retro.actions_proposed) {
      const status = retro.actions_accepted?.some(
        (a: any) => a.action === action.action
      )
        ? "[OK]"
        : "[ ]";
      lines.push(`  ${status} ${action.action} (${action.priority})`);
    }
  }

  return lines.join("\n");
}
