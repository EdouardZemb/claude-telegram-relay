/**
 * @module cost-estimate
 * @description Pre-implementation cost estimation based on agent budgets and historical data.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAgents } from "./bmad-agents.ts";

// ── Types ────────────────────────────────────────────────────

export interface PipelineCostEstimate {
  pipeline: string;
  taskCount: number;
  costPerTask: number;
  totalEstimate: number;
  agentBreakdown: Array<{ role: string; budget: number }>;
}

export interface SprintCostEstimate {
  pipeline: string;
  taskCount: number;
  estimate: PipelineCostEstimate;
  historicalAvg: number | null;
  ratio: number | null;
  warning: boolean;
}

// ── Pipeline Definitions ────────────────────────────────────

const PIPELINE_AGENTS: Record<string, string[]> = {
  DEFAULT: ["analyst", "pm", "architect", "dev", "qa", "sm"],
  QUICK: ["dev", "qa"],
  REVIEW: ["qa", "architect"],
};

// ── Cost Estimation ─────────────────────────────────────────

/**
 * Estimate the cost of a pipeline based on agent budgets from bmad-agents.ts.
 */
export function estimatePipelineCost(pipeline: string, taskCount: number): PipelineCostEstimate {
  const pipelineKey = pipeline.toUpperCase();
  const agentIds = PIPELINE_AGENTS[pipelineKey] || PIPELINE_AGENTS.DEFAULT;
  const agents = getAgents();

  const agentBreakdown: Array<{ role: string; budget: number }> = [];
  let costPerTask = 0;

  for (const agentId of agentIds!) {
    const agent = agents.find(a => a.id === agentId);
    const budget = 0.50; // agents run unconstrained (maxBudgetUsd removed)
    agentBreakdown.push({ role: agentId, budget });
    costPerTask += budget;
  }

  return {
    pipeline: pipelineKey,
    taskCount,
    costPerTask,
    totalEstimate: costPerTask * taskCount,
    agentBreakdown,
  };
}

/**
 * Get historical average cost per sprint from the last N sprints.
 */
export async function getHistoricalAverage(
  supabase: SupabaseClient | null,
  n: number = 3
): Promise<number | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("cost_tracking")
      .select("sprint_id, cost_usd");

    if (error || !data?.length) return null;

    // Group by sprint
    const sprintCosts: Record<string, number> = {};
    for (const row of data) {
      if (!row.sprint_id) continue;
      sprintCosts[row.sprint_id] = (sprintCosts[row.sprint_id] || 0) + (Number(row.cost_usd) || 0);
    }

    const sprints = Object.entries(sprintCosts)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, n);

    if (sprints.length === 0) return null;

    const total = sprints.reduce((sum, [, cost]) => sum + cost, 0);
    return Math.round((total / sprints.length) * 10000) / 10000;
  } catch {
    return null;
  }
}

/**
 * Full sprint cost estimate with historical comparison.
 */
export async function estimateSprintCost(
  supabase: SupabaseClient | null,
  taskCount: number,
  pipeline: string = "DEFAULT"
): Promise<SprintCostEstimate> {
  const estimate = estimatePipelineCost(pipeline, taskCount);
  const historicalAvg = await getHistoricalAverage(supabase);

  const ratio = historicalAvg && historicalAvg > 0
    ? Math.round((estimate.totalEstimate / historicalAvg) * 10) / 10
    : null;

  return {
    pipeline: estimate.pipeline,
    taskCount,
    estimate,
    historicalAvg,
    ratio,
    warning: ratio !== null && ratio > 2,
  };
}

/**
 * Format cost estimate for Telegram (plain text).
 */
export function formatCostEstimate(result: SprintCostEstimate): string {
  const lines: string[] = [
    `Estimation de cout — ${result.taskCount} taches, pipeline ${result.pipeline}`,
    "",
  ];

  lines.push("Par agent:");
  for (const { role, budget } of result.estimate.agentBreakdown) {
    lines.push(`  ${role}: $${budget.toFixed(2)}`);
  }

  lines.push("");
  lines.push(`Cout par tache: $${result.estimate.costPerTask.toFixed(2)}`);
  lines.push(`Cout total estime: $${result.estimate.totalEstimate.toFixed(2)}`);

  if (result.historicalAvg !== null) {
    lines.push("");
    lines.push(`Moyenne historique: $${result.historicalAvg.toFixed(2)} par sprint`);
    lines.push(`Ratio: ${result.ratio}x`);
  } else {
    lines.push("");
    lines.push("Pas de donnees historiques pour comparaison.");
  }

  if (result.warning) {
    lines.push("");
    lines.push("ATTENTION: cout estime depasse 2x la moyenne historique!");
  }

  return lines.join("\n");
}
