/**
 * @module llm-ops
 * @description Unified LLM-Ops facade: prompt versioning, circuit-breaker,
 * span attribution, aggregated observability, periodic health checks.
 * Orchestrates existing modules without duplicating logic.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "./logger.ts";

const log = createLogger("llm-ops");

// ── Cost Tracking (inlined from cost-tracking.ts) ────────────

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
  model?: string;
  cascadeEscalations?: number;
  span_id?: string;
  session_id?: string;
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

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
};

const DEFAULT_PRICING = MODEL_PRICING["claude-sonnet-4-6"];

export function estimateCost(tokensInput: number, tokensOutput: number, model?: string): number {
  const pricing = (model && MODEL_PRICING[model]) || DEFAULT_PRICING;
  const inputCost = (tokensInput / 1_000_000) * pricing.input;
  const outputCost = (tokensOutput / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

export function parseTokenUsage(
  output: string,
  promptLength: number = 0,
  model?: string,
): TokenUsage {
  const usageMatch = output.match(
    /\{[^{}]*"input_tokens"\s*:\s*(\d+)[^{}]*"output_tokens"\s*:\s*(\d+)[^{}]*\}/,
  );
  if (usageMatch) {
    const tokensInput = parseInt(usageMatch[1], 10);
    const tokensOutput = parseInt(usageMatch[2], 10);
    return {
      tokensInput,
      tokensOutput,
      tokensTotal: tokensInput + tokensOutput,
      costUsd: estimateCost(tokensInput, tokensOutput, model),
    };
  }
  const estimatedInput = Math.max(promptLength, 500) / 4;
  const estimatedOutput = Math.max(output.length, 100) / 4;
  const tokensInput = Math.round(estimatedInput);
  const tokensOutput = Math.round(estimatedOutput);
  return {
    tokensInput,
    tokensOutput,
    tokensTotal: tokensInput + tokensOutput,
    costUsd: estimateCost(tokensInput, tokensOutput, model),
  };
}

export async function logCost(supabase: SupabaseClient | null, entry: CostEntry): Promise<void> {
  if (!supabase) return;
  try {
    const row: Record<string, unknown> = {
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
      model: entry.model || null,
    };
    if (entry.span_id) row.span_id = entry.span_id;
    if (entry.session_id) row.session_id = entry.session_id;
    const { error } = await supabase.from("cost_tracking").insert(row);
    if (error) log.error("logCost error", { error: String(error) });
  } catch (error) {
    log.error("logCost error", { error: String(error) });
  }
}

export async function getSprintCostSummary(
  supabase: SupabaseClient | null,
  sprintId: string,
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
      const role = row.agent_role || "unknown";
      if (!costByAgent[role]) costByAgent[role] = { tokens: 0, cost: 0, count: 0 };
      costByAgent[role].tokens += input + output;
      costByAgent[role].cost += cost;
      costByAgent[role].count += 1;
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
    log.error("getSprintCostSummary error", { error: String(error) });
    return null;
  }
}

export async function getTotalCost(
  supabase: SupabaseClient | null,
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

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

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
  const agents = Object.entries(summary.costByAgent).sort((a, b) => b[1].cost - a[1].cost);
  if (agents.length > 0) {
    lines.push("", "Par agent:");
    for (const [role, stats] of agents) {
      lines.push(
        `  ${role}: ${stats.count}x, ${formatTokenCount(stats.tokens)} tokens, $${stats.cost.toFixed(4)}`,
      );
    }
  }
  if (summary.costByTask.length > 0) {
    lines.push("", "Top taches:");
    for (const task of summary.costByTask.slice(0, 5)) {
      lines.push(
        `  ${task.taskId.slice(0, 8)}: ${formatTokenCount(task.tokens)} tokens, $${task.cost.toFixed(4)}`,
      );
    }
  }
  return lines.join("\n");
}
// ── Constants ────────────────────────────────────────────────

/** Interval for periodic LLM-Ops check in heartbeat (R7) — 30 minutes */
export const LLMOPS_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────

export interface PromptVersion {
  id: string;
  agentRole: string;
  templateHash: string;
  feedbackHash: string;
  combinedHash: string;
  createdAt: string;
}

export interface CircuitBreakerStatus {
  open: boolean;
  reason: string;
  suggestedDowngrade: string | null;
}

export interface LlmOpsSnapshot {
  trustScores: Record<
    string,
    { score: number; autonomyLevel: string; consecutiveFailures: number }
  >;
  recentGateEvaluations: string;
  circuitBreakers: Array<{ role: string; open: boolean; reason: string }>;
  promptVersions: Array<{ role: string; combinedHash: string; createdAt: string }>;
  costSummary: { totalSpans: number; totalCostUsd: number; topRoleByCost: string | null };
}

export interface LlmOpsCheckResult {
  anomalies: string[];
  notificationsSent: number;
  circuitBreakersOpen: string[];
}

// ── Span Attribution (R4, R8) ────────────────────────────────

/**
 * Build a synthetic span ID from session, role, and step index.
 * Format: "${sessionId}:${role}:${stepIndex}" — no external lib needed.
 */
export function buildSpanId(sessionId: string, role: string, stepIndex: number): string {
  return `${sessionId}:${role}:${stepIndex}`;
}

/**
 * Log cost with span attribution. Enriches the entry with span_id and session_id,
 * then delegates to the existing logCost() for backward compatibility (R8).
 */
export async function logCostWithSpan(
  supabase: SupabaseClient | null,
  entry: CostEntry,
  spanId: string,
  sessionId: string,
): Promise<void> {
  await logCost(supabase, {
    ...entry,
    span_id: spanId,
    session_id: sessionId,
  });
}

// ── Circuit-Breaker (R5, R6) ────────────────────────────────

/**
 * Get circuit-breaker status for an agent role.
 * Simplified: always returns healthy since trust scores are removed.
 */
export function getCircuitBreakerStatus(_role: string): CircuitBreakerStatus {
  return {
    open: false,
    reason: "healthy",
    suggestedDowngrade: null,
  };
}

// ── Prompt Versioning (R3, R11) ─────────────────────────────

/**
 * Record a prompt version: upserts on (agent_role, combined_hash).
 * Fire-and-forget pattern — never blocks the pipeline.
 * Called from the orchestrator at step execution time, NOT from the prompt builder (R11).
 */
export async function recordPromptVersion(
  supabase: SupabaseClient | null,
  role: string,
  templateHash: string,
  feedbackHash: string,
): Promise<void> {
  if (!supabase) return;

  const combinedHash = `${templateHash}:${feedbackHash}`;

  try {
    const { error } = await supabase.from("prompt_versions").upsert(
      {
        agent_role: role,
        template_hash: templateHash,
        feedback_hash: feedbackHash,
        combined_hash: combinedHash,
      },
      { onConflict: "agent_role,combined_hash" },
    );

    if (error) {
      log.error("recordPromptVersion error", { error: String(error) });
    }
  } catch (err) {
    log.error("recordPromptVersion error", { error: String(err) });
  }
}

/**
 * Get the most recent prompt version for a role.
 */
export async function getActivePromptVersion(
  supabase: SupabaseClient | null,
  role: string,
): Promise<PromptVersion | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("prompt_versions")
      .select("*")
      .eq("agent_role", role)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return null;

    const row = data[0];
    return {
      id: row.id,
      agentRole: row.agent_role,
      templateHash: row.template_hash,
      feedbackHash: row.feedback_hash,
      combinedHash: row.combined_hash,
      createdAt: row.created_at,
    };
  } catch {
    // R7: optional feature → skip
    return null;
  }
}

// ── Observability Aggregation (R1, R9) ──────────────────────

/**
 * Get a full LLM-Ops snapshot — real-time aggregation from multiple sources.
 * Acceptable latency for /monitor (< 1/h usage). Cost summary filtered to 7 days (F-DA-4).
 */
export async function getLlmOpsSnapshot(supabase: SupabaseClient): Promise<LlmOpsSnapshot> {
  // Trust scores removed — empty
  const trustScores: LlmOpsSnapshot["trustScores"] = {};
  const circuitBreakers: LlmOpsSnapshot["circuitBreakers"] = [];

  // Parallel queries: prompt versions, cost summary (7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [promptVersionsResult, costResult] = await Promise.all([
    supabase
      .from("prompt_versions")
      .select("agent_role, combined_hash, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("cost_tracking")
      .select("agent_role, cost_usd, span_id")
      .gte("created_at", sevenDaysAgo),
  ]);

  // Prompt versions
  const promptVersions: LlmOpsSnapshot["promptVersions"] = [];
  if (promptVersionsResult.data) {
    for (const row of promptVersionsResult.data) {
      promptVersions.push({
        role: row.agent_role,
        combinedHash: row.combined_hash,
        createdAt: row.created_at,
      });
    }
  }

  // Cost summary (last 7 days)
  let totalSpans = 0;
  let totalCostUsd = 0;
  const roleCosts: Record<string, number> = {};

  if (costResult.data) {
    for (const row of costResult.data) {
      if (row.span_id) totalSpans++;
      const cost = Number(row.cost_usd) || 0;
      totalCostUsd += cost;
      const role = row.agent_role || "unknown";
      roleCosts[role] = (roleCosts[role] || 0) + cost;
    }
  }

  let topRoleByCost: string | null = null;
  let maxCost = 0;
  for (const [role, cost] of Object.entries(roleCosts)) {
    if (cost > maxCost) {
      maxCost = cost;
      topRoleByCost = role;
    }
  }

  return {
    trustScores,
    recentGateEvaluations: "Pas de donnees",
    circuitBreakers,
    promptVersions,
    costSummary: {
      totalSpans,
      totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      topRoleByCost,
    },
  };
}

// ── Periodic Check (R7, R10) ────────────────────────────────

/**
 * Run the periodic LLM-Ops health check.
 * Detects anomalies (open circuit-breakers) and sends notifications.
 * Does NOT create tasks — notification-only (R10).
 */
export async function runLlmOpsCheck(
  _supabase: SupabaseClient,
  _notifyFn: (msg: string) => Promise<void>,
): Promise<LlmOpsCheckResult> {
  // Simplified: trust scores removed, no circuit-breakers to check
  return { anomalies: [], notificationsSent: 0, circuitBreakersOpen: [] };
}

// ── SHA256 Hashing ──────────────────────────────────────────

/**
 * Compute SHA256 hash of a string using Bun's native CryptoHasher.
 */
export function sha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

// ── Formatting ──────────────────────────────────────────────

/**
 * Format LlmOpsSnapshot for /monitor display (plain text).
 */
export function formatLlmOpsSnapshot(snapshot: LlmOpsSnapshot): string {
  const parts: string[] = ["LLM-OPS MONITORING"];

  // Circuit-breakers
  const openCBs = snapshot.circuitBreakers.filter((cb) => cb.open);
  if (openCBs.length > 0) {
    parts.push("");
    parts.push("Circuit-breakers ouverts:");
    for (const cb of openCBs) {
      parts.push(`  ${cb.role}: ${cb.reason}`);
    }
  } else {
    parts.push("");
    parts.push("Circuit-breakers: tous fermes");
  }

  // Prompt versions
  if (snapshot.promptVersions.length > 0) {
    parts.push("");
    parts.push(`Prompt versions: ${snapshot.promptVersions.length} enregistrees`);
    for (const pv of snapshot.promptVersions.slice(0, 5)) {
      parts.push(`  ${pv.role}: ${pv.combinedHash.substring(0, 16)}...`);
    }
  }

  // Cost summary
  parts.push("");
  parts.push(
    `Couts 7j: $${snapshot.costSummary.totalCostUsd.toFixed(4)} (${snapshot.costSummary.totalSpans} spans)`,
  );
  if (snapshot.costSummary.topRoleByCost) {
    parts.push(`  Top role: ${snapshot.costSummary.topRoleByCost}`);
  }

  return parts.join("\n");
}
