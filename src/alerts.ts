/**
 * @module alerts
 * @description Anomaly detection: stuck tasks, rework spikes, schedule slips.
 */

/**
 * Proactive Alerts — S12 Intelligence Reflexive
 *
 * Detecte les anomalies en temps reel dans le workflow
 * et envoie des notifications proactives sur Telegram.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatTrustScores } from "./trust-scores.ts";

// ── Types ────────────────────────────────────────────────────

export interface Alert {
  type: "stuck_task" | "high_rework" | "behind_schedule" | "long_running_step" | "review_score_drop" | "agent_failure_pattern" | "stale_task";
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
 * Check for declining review scores (S16-07).
 * Alerts when the average review score drops below threshold
 * over the last N reviews.
 */
export async function checkReviewScoreDrop(
  supabase: SupabaseClient,
  windowSize: number = 5
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  const { data: reviews } = await supabase
    .from("workflow_logs")
    .select("metadata, created_at")
    .eq("metadata->>type", "code_review")
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(windowSize * 2);

  if (!reviews || reviews.length < windowSize) return alerts;

  const scores = reviews
    .map((r: any) => r.metadata?.score)
    .filter((s: any) => typeof s === "number");

  if (scores.length < windowSize) return alerts;

  const recentAvg = scores.slice(0, windowSize).reduce((a: number, b: number) => a + b, 0) / windowSize;
  const olderScores = scores.slice(windowSize);

  if (olderScores.length > 0) {
    const olderAvg = olderScores.reduce((a: number, b: number) => a + b, 0) / olderScores.length;
    const drop = olderAvg - recentAvg;

    if (drop > 15) {
      alerts.push({
        type: "review_score_drop",
        severity: drop > 25 ? "critical" : "warning",
        message: `Score review en chute: ${Math.round(recentAvg)} (etait ${Math.round(olderAvg)}, -${Math.round(drop)} pts)`,
        data: { recentAvg: Math.round(recentAvg), olderAvg: Math.round(olderAvg), drop: Math.round(drop) },
      });
    }
  }

  if (recentAvg < 50) {
    alerts.push({
      type: "review_score_drop",
      severity: "critical",
      message: `Score review moyen tres bas: ${Math.round(recentAvg)}/100 sur les ${windowSize} derniers reviews`,
      data: { recentAvg: Math.round(recentAvg), windowSize },
    });
  }

  return alerts;
}

/**
 * Check for recurring agent failures in orchestration (S16-07).
 */
export async function checkAgentFailurePatterns(
  supabase: SupabaseClient
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  const { data: logs } = await supabase
    .from("workflow_logs")
    .select("metadata, created_at")
    .eq("metadata->>type", "orchestration")
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!logs || logs.length < 3) return alerts;

  // Count failures per agent
  const agentFailures: Record<string, number> = {};
  const agentRuns: Record<string, number> = {};

  for (const log of logs) {
    const results = log.metadata?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      if (!r.agent) continue;
      agentRuns[r.agent] = (agentRuns[r.agent] || 0) + 1;
      if (!r.success) {
        agentFailures[r.agent] = (agentFailures[r.agent] || 0) + 1;
      }
    }
  }

  for (const [agent, failures] of Object.entries(agentFailures)) {
    const runs = agentRuns[agent] || 0;
    if (runs >= 3 && failures / runs > 0.5) {
      alerts.push({
        type: "agent_failure_pattern",
        severity: failures / runs > 0.75 ? "critical" : "warning",
        message: `Agent ${agent} echoue frequemment: ${failures}/${runs} echecs (${Math.round(failures / runs * 100)}%)`,
        data: { agent, failures, runs, failureRate: Math.round(failures / runs * 100) },
      });
    }
  }

  return alerts;
}

/**
 * Check for stale tasks in backlog > 48h without being picked up (S16-07).
 */
export async function checkStaleTasks(
  supabase: SupabaseClient
): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: staleTasks } = await supabase
    .from("tasks")
    .select("id, title, created_at, sprint")
    .eq("status", "backlog")
    .lt("created_at", cutoff48h)
    .not("sprint", "is", null)
    .limit(10);

  for (const task of staleTasks || []) {
    const hoursOld = Math.round((Date.now() - new Date(task.created_at).getTime()) / (60 * 60 * 1000));
    alerts.push({
      type: "stale_task",
      severity: hoursOld > 96 ? "warning" : "info",
      message: `Tache en backlog depuis ${hoursOld}h: "${task.title}" (${task.sprint})`,
      data: { taskId: task.id, title: task.title, hoursOld, sprint: task.sprint },
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

  // S16-07: Enhanced proactive alerts
  const reviewAlerts = await checkReviewScoreDrop(supabase);
  alerts.push(...reviewAlerts);

  const agentAlerts = await checkAgentFailurePatterns(supabase);
  alerts.push(...agentAlerts);

  const staleAlerts = await checkStaleTasks(supabase);
  alerts.push(...staleAlerts);

  // S29: Feature-level monitoring checks (no DB required)
  const rtAlerts = checkResponseTime();
  alerts.push(...rtAlerts);

  const spawnAlerts = checkSpawnFailures();
  alerts.push(...spawnAlerts);

  const moduleAlerts = checkModuleErrors();
  alerts.push(...moduleAlerts);

  return alerts;
}

// ── Feature-Level Monitoring (S29-T10) ──────────────────────

/**
 * Ring buffer for response time measurements (in-memory, lost on restart).
 */
const RESPONSE_TIME_BUFFER_SIZE = 100;
const responseTimeBuffer: number[] = [];

/** Record a bot response time in milliseconds */
export function recordResponseTime(ms: number): void {
  responseTimeBuffer.push(ms);
  if (responseTimeBuffer.length > RESPONSE_TIME_BUFFER_SIZE) {
    responseTimeBuffer.shift();
  }
}

/** Get response time stats (p50, p95, p99, count) */
export function getResponseTimeStats(): { p50: number; p95: number; p99: number; count: number } {
  if (responseTimeBuffer.length === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0 };
  }
  const sorted = [...responseTimeBuffer].sort((a, b) => a - b);
  const len = sorted.length;
  return {
    p50: sorted[Math.floor(len * 0.5)] ?? 0,
    p95: sorted[Math.floor(len * 0.95)] ?? 0,
    p99: sorted[Math.floor(len * 0.99)] ?? 0,
    count: len,
  };
}

/**
 * Spawn success/failure counters per agent role.
 */
const spawnCounters: Record<string, { success: number; failure: number }> = {};

export function recordSpawnResult(role: string, success: boolean): void {
  if (!spawnCounters[role]) spawnCounters[role] = { success: 0, failure: 0 };
  if (success) spawnCounters[role].success++;
  else spawnCounters[role].failure++;
}

export function getSpawnStats(): Record<string, { success: number; failure: number; failureRate: number }> {
  const stats: Record<string, { success: number; failure: number; failureRate: number }> = {};
  for (const [role, counts] of Object.entries(spawnCounters)) {
    const total = counts.success + counts.failure;
    stats[role] = {
      ...counts,
      failureRate: total > 0 ? Math.round((counts.failure / total) * 100) : 0,
    };
  }
  return stats;
}

/**
 * Module error counters (last hour window).
 */
const moduleErrors: Array<{ module: string; timestamp: number }> = [];

export function recordModuleError(moduleName: string): void {
  moduleErrors.push({ module: moduleName, timestamp: Date.now() });
  // Prune entries older than 1 hour
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (moduleErrors.length > 0 && moduleErrors[0]!.timestamp < cutoff) {
    moduleErrors.shift();
  }
}

export function getModuleErrorCounts(): Record<string, number> {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const counts: Record<string, number> = {};
  for (const entry of moduleErrors) {
    if (entry.timestamp >= cutoff) {
      counts[entry.module] = (counts[entry.module] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Reset all monitoring counters (for testing).
 */
export function resetMonitoringState(): void {
  responseTimeBuffer.length = 0;
  for (const key of Object.keys(spawnCounters)) delete spawnCounters[key];
  moduleErrors.length = 0;
}

/**
 * Check response time — alert if p95 > 30s.
 */
export function checkResponseTime(): Alert[] {
  const stats = getResponseTimeStats();
  if (stats.count < 5) return []; // Not enough data
  const alerts: Alert[] = [];

  if (stats.p95 > 30000) {
    alerts.push({
      type: "long_running_step",
      severity: stats.p95 > 60000 ? "critical" : "warning",
      message: `Temps de reponse eleve: p95=${Math.round(stats.p95 / 1000)}s, p50=${Math.round(stats.p50 / 1000)}s (${stats.count} mesures)`,
      data: { p50: stats.p50, p95: stats.p95, p99: stats.p99, count: stats.count },
    });
  }

  return alerts;
}

/**
 * Check spawn failure rate — alert if any role > 20%.
 */
export function checkSpawnFailures(): Alert[] {
  const stats = getSpawnStats();
  const alerts: Alert[] = [];

  for (const [role, data] of Object.entries(stats)) {
    const total = data.success + data.failure;
    if (total >= 3 && data.failureRate > 20) {
      alerts.push({
        type: "agent_failure_pattern",
        severity: data.failureRate > 50 ? "critical" : "warning",
        message: `Agent ${role}: taux echec spawn ${data.failureRate}% (${data.failure}/${total})`,
        data: { role, ...data, total },
      });
    }
  }

  return alerts;
}

/**
 * Check module error counts — alert if any module > 10 errors/hour.
 */
export function checkModuleErrors(): Alert[] {
  const counts = getModuleErrorCounts();
  const alerts: Alert[] = [];

  for (const [mod, count] of Object.entries(counts)) {
    if (count > 10) {
      alerts.push({
        type: "agent_failure_pattern",
        severity: count > 25 ? "critical" : "warning",
        message: `Module ${mod}: ${count} erreurs dans la derniere heure`,
        data: { module: mod, errorCount: count },
      });
    }
  }

  return alerts;
}

/**
 * Format monitoring stats for /monitor command (plain text).
 * S35: Includes trust scores section.
 */
export function formatMonitoringStats(): string {
  const lines: string[] = ["Monitoring Production", ""];

  // Response time
  const rtStats = getResponseTimeStats();
  lines.push("Temps de reponse:");
  if (rtStats.count === 0) {
    lines.push("  Pas de mesures");
  } else {
    lines.push(`  p50: ${Math.round(rtStats.p50 / 1000)}s, p95: ${Math.round(rtStats.p95 / 1000)}s, p99: ${Math.round(rtStats.p99 / 1000)}s`);
    lines.push(`  ${rtStats.count} mesures`);
  }

  // Spawn stats
  const spawnStats = getSpawnStats();
  lines.push("");
  lines.push("Spawn Claude par role:");
  if (Object.keys(spawnStats).length === 0) {
    lines.push("  Aucune execution");
  } else {
    for (const [role, data] of Object.entries(spawnStats)) {
      const total = data.success + data.failure;
      lines.push(`  ${role}: ${data.success}/${total} OK (${data.failureRate}% echec)`);
    }
  }

  // Module errors
  const modErrors = getModuleErrorCounts();
  lines.push("");
  lines.push("Erreurs modules (derniere heure):");
  const sorted = Object.entries(modErrors).sort(([, a], [, b]) => b - a).slice(0, 5);
  if (sorted.length === 0) {
    lines.push("  Aucune erreur");
  } else {
    for (const [mod, count] of sorted) {
      lines.push(`  ${mod}: ${count}`);
    }
  }

  // S35: Trust scores
  lines.push("");
  lines.push(formatTrustScores());

  return lines.join("\n");
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
