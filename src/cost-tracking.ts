/**
 * Cost Tracking Module — S23-05/06/07
 *
 * Tracks token usage and estimated cost per agent execution.
 * Parses Claude CLI output for usage metadata.
 * Aggregates costs per sprint for /metrics and /cost commands.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

export interface TokenUsage {
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  costUsd: number;
}

export interface CostEntry {
  taskId?: string;
  sprintId?: string;
  agentRole?: string;
  agentName?: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  durationMs: number;
  retryAttempt?: number;
  context?: string;
  metadata?: Record<string, unknown>;
}

export interface SprintCostSummary {
  sprintId: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  agentExecutions: number;
  costByAgent: Record<string, { tokens: number; cost: number; count: number }>;
  costByTask: Array<{ taskId: string; tokens: number; cost: number }>;
}

// ── Pricing ──────────────────────────────────────────────────

/** Approximate pricing per 1M tokens (Claude Sonnet 4 via CLI) */
const PRICE_PER_M_INPUT = 3.0; // $3/M input tokens
const PRICE_PER_M_OUTPUT = 15.0; // $15/M output tokens

/**
 * Estimate cost from token counts.
 */
export function estimateCost(tokensInput: number, tokensOutput: number): number {
  const inputCost = (tokensInput / 1_000_000) * PRICE_PER_M_INPUT;
  const outputCost = (tokensOutput / 1_000_000) * PRICE_PER_M_OUTPUT;
  return Math.round((inputCost + outputCost) * 10000) / 10000; // 4 decimal places
}

// ── Parse Claude CLI Output ──────────────────────────────────

/**
 * Parse token usage from Claude CLI stderr/output.
 *
 * Claude CLI with --output-format text doesn't emit structured usage data,
 * so we estimate from the output length as a fallback.
 * If structured usage data is found (JSON format), we parse it.
 */
export function parseTokenUsage(
  output: string,
  promptLength: number = 0
): TokenUsage {
  // Try to find structured usage data in output (Claude CLI may include it)
  const usageMatch = output.match(
    /\{[^{}]*"input_tokens"\s*:\s*(\d+)[^{}]*"output_tokens"\s*:\s*(\d+)[^{}]*\}/
  );

  if (usageMatch) {
    const tokensInput = parseInt(usageMatch[1], 10);
    const tokensOutput = parseInt(usageMatch[2], 10);
    return {
      tokensInput,
      tokensOutput,
      tokensTotal: tokensInput + tokensOutput,
      costUsd: estimateCost(tokensInput, tokensOutput),
    };
  }

  // Fallback: estimate from text lengths
  // ~4 chars per token for English/French text
  const estimatedInput = Math.max(promptLength, 500) / 4;
  const estimatedOutput = Math.max(output.length, 100) / 4;
  const tokensInput = Math.round(estimatedInput);
  const tokensOutput = Math.round(estimatedOutput);

  return {
    tokensInput,
    tokensOutput,
    tokensTotal: tokensInput + tokensOutput,
    costUsd: estimateCost(tokensInput, tokensOutput),
  };
}

// ── Persistence ──────────────────────────────────────────────

/**
 * Log a cost entry to the cost_tracking table.
 */
export async function logCost(
  supabase: SupabaseClient | null,
  entry: CostEntry
): Promise<void> {
  if (!supabase) return;

  try {
    const { error } = await supabase.from("cost_tracking").insert({
      task_id: entry.taskId || null,
      sprint_id: entry.sprintId || null,
      agent_role: entry.agentRole || null,
      agent_name: entry.agentName || null,
      tokens_input: entry.tokensInput,
      tokens_output: entry.tokensOutput,
      cost_usd: entry.costUsd,
      duration_ms: entry.durationMs,
      retry_attempt: entry.retryAttempt || 0,
      context: entry.context || null,
      metadata: entry.metadata || {},
    });
    if (error) console.error("logCost error:", error);
  } catch (error) {
    console.error("logCost error:", error);
  }
}

// ── Aggregation ──────────────────────────────────────────────

/**
 * Get cost summary for a sprint.
 */
export async function getSprintCostSummary(
  supabase: SupabaseClient | null,
  sprintId: string
): Promise<SprintCostSummary | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("cost_tracking")
      .select("task_id, agent_role, agent_name, tokens_input, tokens_output, cost_usd")
      .eq("sprint_id", sprintId);

    if (error || !data?.length) {
      return {
        sprintId,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        agentExecutions: 0,
        costByAgent: {},
        costByTask: [],
      };
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    const costByAgent: Record<string, { tokens: number; cost: number; count: number }> = {};
    const taskCosts: Record<string, { tokens: number; cost: number }> = {};

    for (const row of data) {
      const input = row.tokens_input || 0;
      const output = row.tokens_output || 0;
      const cost = Number(row.cost_usd) || 0;

      totalInputTokens += input;
      totalOutputTokens += output;
      totalCostUsd += cost;

      // By agent
      const role = row.agent_role || "unknown";
      if (!costByAgent[role]) costByAgent[role] = { tokens: 0, cost: 0, count: 0 };
      costByAgent[role].tokens += input + output;
      costByAgent[role].cost += cost;
      costByAgent[role].count += 1;

      // By task
      if (row.task_id) {
        if (!taskCosts[row.task_id]) taskCosts[row.task_id] = { tokens: 0, cost: 0 };
        taskCosts[row.task_id].tokens += input + output;
        taskCosts[row.task_id].cost += cost;
      }
    }

    const costByTask = Object.entries(taskCosts)
      .map(([taskId, costs]) => ({ taskId, ...costs }))
      .sort((a, b) => b.cost - a.cost);

    return {
      sprintId,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      agentExecutions: data.length,
      costByAgent,
      costByTask,
    };
  } catch (error) {
    console.error("getSprintCostSummary error:", error);
    return null;
  }
}

/**
 * Get total cost across all sprints.
 */
export async function getTotalCost(
  supabase: SupabaseClient | null
): Promise<{ totalTokens: number; totalCostUsd: number; executions: number }> {
  if (!supabase) return { totalTokens: 0, totalCostUsd: 0, executions: 0 };

  try {
    const { data, error } = await supabase
      .from("cost_tracking")
      .select("tokens_input, tokens_output, cost_usd");

    if (error || !data?.length) return { totalTokens: 0, totalCostUsd: 0, executions: 0 };

    let totalTokens = 0;
    let totalCostUsd = 0;

    for (const row of data) {
      totalTokens += (row.tokens_input || 0) + (row.tokens_output || 0);
      totalCostUsd += Number(row.cost_usd) || 0;
    }

    return {
      totalTokens,
      totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      executions: data.length,
    };
  } catch {
    return { totalTokens: 0, totalCostUsd: 0, executions: 0 };
  }
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format cost summary for Telegram (plain text).
 */
export function formatCostSummary(summary: SprintCostSummary | null): string {
  if (!summary) return "Pas de donnees de cout disponibles.";

  if (summary.agentExecutions === 0) {
    return `Couts Sprint ${summary.sprintId}\n\nAucune execution d'agent enregistree.`;
  }

  const lines: string[] = [
    `Couts Sprint ${summary.sprintId}`,
    "",
    `Executions: ${summary.agentExecutions}`,
    `Tokens totaux: ${formatTokenCount(summary.totalTokens)} (${formatTokenCount(summary.totalInputTokens)} in / ${formatTokenCount(summary.totalOutputTokens)} out)`,
    `Cout estime: $${summary.totalCostUsd.toFixed(4)}`,
  ];

  // Cost by agent
  const agents = Object.entries(summary.costByAgent).sort(
    (a, b) => b[1].cost - a[1].cost
  );
  if (agents.length > 0) {
    lines.push("");
    lines.push("Par agent:");
    for (const [role, stats] of agents) {
      lines.push(
        `  ${role}: ${stats.count}x, ${formatTokenCount(stats.tokens)} tokens, $${stats.cost.toFixed(4)}`
      );
    }
  }

  // Top tasks by cost
  if (summary.costByTask.length > 0) {
    lines.push("");
    lines.push("Top taches:");
    for (const task of summary.costByTask.slice(0, 5)) {
      lines.push(
        `  ${task.taskId.slice(0, 8)}: ${formatTokenCount(task.tokens)} tokens, $${task.cost.toFixed(4)}`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Format a token count for display (e.g., 1234567 → "1.2M").
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
