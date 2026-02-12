/**
 * Pattern Detection — S12 Intelligence Reflexive
 *
 * Analyse les workflow_logs et sprint_metrics sur plusieurs sprints
 * pour identifier des tendances et proposer des ameliorations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkflowConfig } from "./workflow";

// ── Types ────────────────────────────────────────────────────

export interface DetectedPattern {
  type: "slow_step" | "useless_checkpoint" | "critical_checkpoint" | "high_rework" | "improving" | "degrading";
  severity: "info" | "warning" | "critical";
  description: string;
  data: Record<string, unknown>;
}

export interface WorkflowSuggestion {
  action: string;
  reason: string;
  priority: "high" | "medium" | "low";
  target_step?: string;
  suggested_change?: string;
}

export interface PatternAnalysis {
  patterns: DetectedPattern[];
  suggestions: WorkflowSuggestion[];
  sprintCount: number;
  analyzedAt: string;
}

// ── Analysis ─────────────────────────────────────────────────

/**
 * Analyse les donnees de plusieurs sprints pour detecter des patterns.
 */
export async function analyzePatterns(
  supabase: SupabaseClient,
  options?: { minSprints?: number }
): Promise<PatternAnalysis> {
  const patterns: DetectedPattern[] = [];
  const minSprints = options?.minSprints ?? 2;

  // Get all sprint metrics
  const { data: allMetrics } = await supabase
    .from("sprint_metrics")
    .select("*")
    .order("created_at", { ascending: true });

  const metrics = allMetrics ?? [];

  // Get all workflow logs
  const { data: allLogs } = await supabase
    .from("workflow_logs")
    .select("*")
    .order("created_at", { ascending: true });

  const logs = allLogs ?? [];

  // Get accepted retro actions
  const { data: allRetros } = await supabase
    .from("retros")
    .select("sprint_id, actions_accepted, patterns_detected")
    .order("created_at", { ascending: true });

  const retros = allRetros ?? [];

  // ── Pattern 1: Slow steps ──────────────────────────────────
  const stepDurations = computeStepDurations(logs);
  for (const [step, durations] of Object.entries(stepDurations)) {
    if (durations.length < 3) continue; // Need enough data
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const median = sortedMedian(durations);

    // A step is "slow" if average > 1 hour and median > 45 min
    if (avg > 3600 && median > 2700) {
      patterns.push({
        type: "slow_step",
        severity: avg > 7200 ? "warning" : "info",
        description: `L'etape "${step}" prend en moyenne ${formatDuration(avg)} (mediane: ${formatDuration(median)})`,
        data: { step, avg_seconds: Math.round(avg), median_seconds: Math.round(median), sample_count: durations.length },
      });
    }
  }

  // ── Pattern 2: Useless checkpoints ─────────────────────────
  const checkpointStats = computeCheckpointStats(logs);
  for (const [step, stats] of Object.entries(checkpointStats)) {
    if (stats.total < 5) continue; // Need enough data
    if (stats.pass === stats.total || stats.skipped === stats.total) {
      patterns.push({
        type: "useless_checkpoint",
        severity: "info",
        description: `Le checkpoint sur "${step}" n'a jamais detecte de probleme (${stats.total} passages, 100% pass/skip)`,
        data: { step, ...stats },
      });
    }
  }

  // ── Pattern 3: Critical checkpoints ────────────────────────
  for (const [step, stats] of Object.entries(checkpointStats)) {
    if (stats.total < 3) continue;
    const failRate = (stats.fail + stats.corrected) / stats.total;
    if (failRate > 0.3) {
      patterns.push({
        type: "critical_checkpoint",
        severity: failRate > 0.5 ? "critical" : "warning",
        description: `Le checkpoint sur "${step}" detecte des problemes dans ${Math.round(failRate * 100)}% des cas`,
        data: { step, fail_rate: Math.round(failRate * 100), ...stats },
      });
    }
  }

  // ── Pattern 4: High rework rate ────────────────────────────
  const sprintRework = computeSprintRework(logs);
  for (const [sprint, rework] of Object.entries(sprintRework)) {
    if (rework.total < 3) continue;
    const reworkRate = rework.reworkCount / rework.total;
    if (reworkRate > 0.25) {
      patterns.push({
        type: "high_rework",
        severity: reworkRate > 0.5 ? "critical" : "warning",
        description: `Sprint ${sprint}: taux de retouche de ${Math.round(reworkRate * 100)}% (${rework.reworkCount}/${rework.total} transitions)`,
        data: { sprint, rework_rate: Math.round(reworkRate * 100), ...rework },
      });
    }
  }

  // ── Pattern 5: Trend analysis ──────────────────────────────
  if (metrics.length >= minSprints) {
    const completionRates = metrics
      .filter((m: any) => m.tasks_planned > 0)
      .map((m: any) => ({
        sprint: m.sprint_id,
        rate: m.tasks_completed / m.tasks_planned,
      }));

    if (completionRates.length >= 2) {
      const recent = completionRates.slice(-3);
      const trend = computeTrend(recent.map((r: any) => r.rate));

      if (trend > 0.05) {
        patterns.push({
          type: "improving",
          severity: "info",
          description: `Tendance positive: le taux de completion s'ameliore sur les ${recent.length} derniers sprints`,
          data: { trend: Math.round(trend * 100), sprints: recent },
        });
      } else if (trend < -0.05) {
        patterns.push({
          type: "degrading",
          severity: "warning",
          description: `Tendance negative: le taux de completion se degrade sur les ${recent.length} derniers sprints`,
          data: { trend: Math.round(trend * 100), sprints: recent },
        });
      }
    }
  }

  // ── Generate suggestions ──────────────────────────────────
  const suggestions = generateSuggestions(patterns, retros);

  return {
    patterns,
    suggestions,
    sprintCount: metrics.length,
    analyzedAt: new Date().toISOString(),
  };
}

// ── Suggestion Generator ─────────────────────────────────────

function generateSuggestions(
  patterns: DetectedPattern[],
  retros: any[]
): WorkflowSuggestion[] {
  const suggestions: WorkflowSuggestion[] = [];
  const config = loadWorkflowConfig();

  for (const pattern of patterns) {
    switch (pattern.type) {
      case "slow_step": {
        const step = pattern.data.step as string;
        const stepConfig = config.steps.find((s) => s.id === step);
        if (stepConfig?.checkpoint.mode === "strict") {
          suggestions.push({
            action: `Passer le checkpoint de "${step}" en mode light`,
            reason: pattern.description,
            priority: "medium",
            target_step: step,
            suggested_change: "checkpoint.mode: light",
          });
        }
        break;
      }

      case "useless_checkpoint": {
        const step = pattern.data.step as string;
        const stepConfig = config.steps.find((s) => s.id === step);
        if (stepConfig?.checkpoint.mode !== "off") {
          suggestions.push({
            action: `Desactiver le checkpoint sur "${step}"`,
            reason: pattern.description,
            priority: "low",
            target_step: step,
            suggested_change: "checkpoint.mode: off",
          });
        }
        break;
      }

      case "critical_checkpoint": {
        const step = pattern.data.step as string;
        const stepConfig = config.steps.find((s) => s.id === step);
        if (stepConfig?.checkpoint.mode !== "strict") {
          suggestions.push({
            action: `Passer le checkpoint de "${step}" en mode strict`,
            reason: pattern.description,
            priority: "high",
            target_step: step,
            suggested_change: "checkpoint.mode: strict",
          });
        }
        break;
      }

      case "high_rework": {
        suggestions.push({
          action: "Renforcer les checkpoints avant la phase de review",
          reason: pattern.description,
          priority: "high",
        });
        break;
      }

      case "degrading": {
        suggestions.push({
          action: "Reduire le scope des sprints pour ameliorer le taux de completion",
          reason: pattern.description,
          priority: "medium",
        });
        break;
      }
    }
  }

  // Deduplicate suggestions that were already proposed in past retros
  const pastActions = new Set(
    retros.flatMap((r: any) =>
      (r.actions_accepted ?? []).map((a: any) => a.action)
    )
  );

  return suggestions.filter((s) => !pastActions.has(s.action));
}

// ── Helpers ──────────────────────────────────────────────────

function computeStepDurations(logs: any[]): Record<string, number[]> {
  const durations: Record<string, number[]> = {};
  for (const log of logs) {
    if (log.duration_seconds && log.step_from !== log.step_to) {
      if (!durations[log.step_from]) durations[log.step_from] = [];
      durations[log.step_from].push(log.duration_seconds);
    }
  }
  return durations;
}

function computeCheckpointStats(
  logs: any[]
): Record<string, { total: number; pass: number; fail: number; corrected: number; skipped: number }> {
  const stats: Record<string, { total: number; pass: number; fail: number; corrected: number; skipped: number }> = {};
  for (const log of logs) {
    if (!log.checkpoint_result) continue;
    const step = log.step_from;
    if (!stats[step]) stats[step] = { total: 0, pass: 0, fail: 0, corrected: 0, skipped: 0 };
    stats[step].total++;
    const result = log.checkpoint_result as string;
    if (result in stats[step]) {
      (stats[step] as any)[result]++;
    }
  }
  return stats;
}

function computeSprintRework(
  logs: any[]
): Record<string, { total: number; reworkCount: number }> {
  const sprints: Record<string, { total: number; reworkCount: number }> = {};
  for (const log of logs) {
    if (!log.sprint_id) continue;
    if (!sprints[log.sprint_id]) sprints[log.sprint_id] = { total: 0, reworkCount: 0 };
    sprints[log.sprint_id].total++;
    if (log.had_rework) sprints[log.sprint_id].reworkCount++;
  }
  return sprints;
}

function computeTrend(values: number[]): number {
  if (values.length < 2) return 0;
  // Simple linear regression slope
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function sortedMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h${mins}min` : `${hours}h`;
}

// ── Formatting ───────────────────────────────────────────────

export function formatPatterns(analysis: PatternAnalysis): string {
  if (analysis.patterns.length === 0 && analysis.suggestions.length === 0) {
    return `Analyse de patterns (${analysis.sprintCount} sprints)\n\nPas de patterns significatifs detectes. Continuez comme ca.`;
  }

  const lines = [
    `Analyse de patterns (${analysis.sprintCount} sprints)`,
    "",
  ];

  if (analysis.patterns.length > 0) {
    lines.push("Patterns detectes :");
    for (const p of analysis.patterns) {
      const icon = p.severity === "critical" ? "!!" : p.severity === "warning" ? "!" : "~";
      lines.push(`  ${icon} ${p.description}`);
    }
    lines.push("");
  }

  if (analysis.suggestions.length > 0) {
    lines.push("Suggestions :");
    for (const s of analysis.suggestions) {
      const prio = s.priority === "high" ? "[!!]" : s.priority === "medium" ? "[!]" : "[~]";
      lines.push(`  ${prio} ${s.action}`);
      lines.push(`      Raison: ${s.reason}`);
    }
  }

  return lines.join("\n");
}
