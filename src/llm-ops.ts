/**
 * @module llm-ops
 * @description Unified LLM-Ops facade: prompt versioning, circuit-breaker,
 * span attribution, aggregated observability, periodic health checks.
 * Orchestrates existing modules without duplicating logic.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { type CostEntry, logCost } from "./cost-tracking.ts";
import { createLogger } from "./logger.ts";
import {
  formatRecentGateEvaluations,
  getAutonomyLevel,
  getCachedTrustScore,
  getCachedTrustScores,
} from "./trust-scores.ts";

const log = createLogger("llm-ops");
// ── Constants ────────────────────────────────────────────────

/** Trust score below which circuit-breaker opens (R6) */
const CB_TRUST_THRESHOLD = 30;

/** Consecutive failures triggering circuit-breaker (R6) */
const CB_FAILURE_THRESHOLD = 3;

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
 * Non-blocking: returns status + recommendation, decision stays with caller (R5).
 * Thresholds: trust_score < 30 OR consecutiveFailures >= 3 (R6).
 */
export function getCircuitBreakerStatus(role: string): CircuitBreakerStatus {
  const trust = getCachedTrustScore(role);

  if (trust.score < CB_TRUST_THRESHOLD) {
    return {
      open: true,
      reason: `trust_score ${trust.score} < ${CB_TRUST_THRESHOLD}`,
      suggestedDowngrade: "QUICK",
    };
  }

  if (trust.consecutiveFailures >= CB_FAILURE_THRESHOLD) {
    return {
      open: true,
      reason: `consecutive_failures ${trust.consecutiveFailures} >= ${CB_FAILURE_THRESHOLD}`,
      suggestedDowngrade: "QUICK",
    };
  }

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
  // Trust scores from in-memory cache (no query needed)
  const rawScores = getCachedTrustScores();
  const trustScores: LlmOpsSnapshot["trustScores"] = {};
  const allRoles = Object.keys(rawScores);

  for (const role of allRoles) {
    const ts = rawScores[role];
    const autonomy = getAutonomyLevel(role);
    trustScores[role] = {
      score: ts.score,
      autonomyLevel: autonomy.label,
      consecutiveFailures: ts.consecutiveFailures,
    };
  }

  // Circuit-breakers from trust score cache (no query needed)
  const circuitBreakers = allRoles.map((role) => {
    const cb = getCircuitBreakerStatus(role);
    return { role, open: cb.open, reason: cb.reason };
  });

  // Parallel queries: gate evaluations, prompt versions, cost summary (7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [recentEvals, promptVersionsResult, costResult] = await Promise.all([
    formatRecentGateEvaluations(supabase),
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
    recentGateEvaluations: recentEvals,
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
  notifyFn: (msg: string) => Promise<void>,
): Promise<LlmOpsCheckResult> {
  const anomalies: string[] = [];
  const circuitBreakersOpen: string[] = [];
  let notificationsSent = 0;

  // Check all known roles
  const roles: string[] = ["analyst", "pm", "architect", "dev", "qa", "sm", "explorer", "planner"];
  const scores = getCachedTrustScores();

  for (const role of roles) {
    // Only check roles that have data in the cache
    if (!scores[role]) continue;

    const cb = getCircuitBreakerStatus(role);
    if (cb.open) {
      circuitBreakersOpen.push(role);
      const msg = `[LLM-Ops] Circuit-breaker ouvert pour ${role}: ${cb.reason}`;
      anomalies.push(msg);

      try {
        await notifyFn(msg);
        notificationsSent++;
      } catch (err) {
        log.error("runLlmOpsCheck notify error", { error: String(err) });
      }
    }
  }

  return { anomalies, notificationsSent, circuitBreakersOpen };
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
