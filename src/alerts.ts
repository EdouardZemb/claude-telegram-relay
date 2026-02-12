/**
 * Proactive Alerts — S12 Intelligence Reflexive
 *
 * Detecte les anomalies en temps reel dans le workflow
 * et envoie des notifications proactives sur Telegram.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

export interface Alert {
  type: "stuck_task" | "high_rework" | "behind_schedule" | "long_running_step";
  severity: "info" | "warning" | "critical";
  message: string;
  data: Record<string, unknown>;
}

export interface AlertConfig {
  stuckThresholdHours: number;     // Hours before a task is considered stuck
  reworkThresholdPercent: number;   // % rework rate that triggers alert
  scheduleCheckEnabled: boolean;
}

const DEFAULT_CONFIG: AlertConfig = {
  stuckThresholdHours: 24,
  reworkThresholdPercent: 40,
  scheduleCheckEnabled: true,
};

// ── Detection ────────────────────────────────────────────────

/**
 * Check for stuck tasks — tasks in_progress for too long without progress.
 */
export async function checkStuckTasks(
  supabase: SupabaseClient,
  config: AlertConfig = DEFAULT_CONFIG
): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const thresholdMs = config.stuckThresholdHours * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();

  const { data: stuckTasks } = await supabase
    .from("tasks")
    .select("id, title, status, updated_at, sprint")
    .eq("status", "in_progress")
    .order("updated_at", { ascending: true });

  for (const task of stuckTasks ?? []) {
    const updatedAt = new Date(task.updated_at).getTime();
    if (updatedAt < new Date(cutoff).getTime()) {
      const hoursStuck = Math.round((Date.now() - updatedAt) / (60 * 60 * 1000));
      alerts.push({
        type: "stuck_task",
        severity: hoursStuck > config.stuckThresholdHours * 2 ? "critical" : "warning",
        message: `Tache bloquee depuis ${hoursStuck}h: "${task.title}"`,
        data: { taskId: task.id, title: task.title, hoursStuck, sprint: task.sprint },
      });
    }
  }

  return alerts;
}

/**
 * Check for abnormally high rework rate in the current sprint.
 */
export async function checkReworkRate(
  supabase: SupabaseClient,
  sprintId: string,
  config: AlertConfig = DEFAULT_CONFIG
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  const { data: logs } = await supabase
    .from("workflow_logs")
    .select("had_rework")
    .eq("sprint_id", sprintId);

  if (!logs || logs.length < 5) return alerts; // Not enough data

  const reworkCount = logs.filter((l: any) => l.had_rework).length;
  const reworkRate = (reworkCount / logs.length) * 100;

  if (reworkRate > config.reworkThresholdPercent) {
    alerts.push({
      type: "high_rework",
      severity: reworkRate > 60 ? "critical" : "warning",
      message: `Taux de retouche eleve dans ${sprintId}: ${Math.round(reworkRate)}% (${reworkCount}/${logs.length})`,
      data: { sprintId, reworkRate: Math.round(reworkRate), reworkCount, totalTransitions: logs.length },
    });
  }

  return alerts;
}

/**
 * Check if sprint completion is behind expected pace.
 */
export async function checkSprintPace(
  supabase: SupabaseClient,
  sprintId: string
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, status, created_at")
    .eq("sprint", sprintId);

  if (!tasks || tasks.length === 0) return alerts;

  const total = tasks.length;
  const done = tasks.filter((t: any) => t.status === "done").length;
  const completionRate = done / total;

  // Estimate sprint progress based on earliest task creation
  const firstTask = tasks.reduce((earliest: any, t: any) =>
    new Date(t.created_at) < new Date(earliest.created_at) ? t : earliest
  );

  const sprintAgeMs = Date.now() - new Date(firstTask.created_at).getTime();
  const sprintAgeDays = sprintAgeMs / (24 * 60 * 60 * 1000);

  // Assume 7-day sprint by default
  const expectedProgress = Math.min(sprintAgeDays / 7, 1);

  if (expectedProgress > 0.5 && completionRate < expectedProgress * 0.6) {
    alerts.push({
      type: "behind_schedule",
      severity: completionRate < expectedProgress * 0.3 ? "critical" : "warning",
      message: `Sprint ${sprintId} en retard: ${done}/${total} taches (${Math.round(completionRate * 100)}%) apres ${Math.round(sprintAgeDays)} jours`,
      data: {
        sprintId,
        done,
        total,
        completionRate: Math.round(completionRate * 100),
        sprintAgeDays: Math.round(sprintAgeDays),
        expectedProgress: Math.round(expectedProgress * 100),
      },
    });
  }

  return alerts;
}

/**
 * Run all alert checks and return combined results.
 */
export async function runAllChecks(
  supabase: SupabaseClient,
  sprintId?: string,
  config?: AlertConfig
): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const cfg = config ?? DEFAULT_CONFIG;

  const stuckAlerts = await checkStuckTasks(supabase, cfg);
  alerts.push(...stuckAlerts);

  if (sprintId) {
    const reworkAlerts = await checkReworkRate(supabase, sprintId, cfg);
    alerts.push(...reworkAlerts);

    if (cfg.scheduleCheckEnabled) {
      const paceAlerts = await checkSprintPace(supabase, sprintId);
      alerts.push(...paceAlerts);
    }
  }

  return alerts;
}

// ── Formatting ───────────────────────────────────────────────

export function formatAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return "Aucune alerte active. Tout est nominal.";

  const lines = [`${alerts.length} alerte${alerts.length > 1 ? "s" : ""} detectee${alerts.length > 1 ? "s" : ""} :`, ""];

  for (const alert of alerts) {
    const icon = alert.severity === "critical" ? "!!" : alert.severity === "warning" ? "!" : "~";
    lines.push(`  ${icon} ${alert.message}`);
  }

  return lines.join("\n");
}
