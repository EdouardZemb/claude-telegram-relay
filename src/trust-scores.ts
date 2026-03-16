/**
 * @module trust-scores
 * @description Trust scores per agent role: tracks gate evaluation success/failure
 * to build confidence and enable progressive autonomy (S35).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

export interface TrustScore {
  agentRole: string;
  score: number; // 0-100, default 50
  consecutivePasses: number;
  consecutiveFailures: number;
  totalEvaluations: number;
  totalPasses: number;
  lastEvaluationAt: string | null;
  updatedAt: string;
}

export interface TrustScoreUpdate {
  passed: boolean;
  hadRework: boolean;
}

// ── Constants ────────────────────────────────────────────────

const DEFAULT_SCORE = 50;
const PASS_NO_REWORK_DELTA = 5;
const PASS_WITH_REWORK_DELTA = 1;
const FAIL_DELTA = -10;
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** Auto-approval thresholds */
export const AUTO_APPROVE_SPEC_THRESHOLD = 80;
export const AUTO_APPROVE_IMPL_THRESHOLD = 90;
export const AUTO_APPROVE_MAX_PRIORITY = 3; // P3+ only (P3, P4, P5)

// ── In-memory cache ──────────────────────────────────────────

const trustScoreCache: Record<string, TrustScore> = {};

export function getCachedTrustScores(): Record<string, TrustScore> {
  return { ...trustScoreCache };
}

export function getCachedTrustScore(role: string): TrustScore {
  return trustScoreCache[role] || makeDefaultTrustScore(role);
}

function makeDefaultTrustScore(role: string): TrustScore {
  return {
    agentRole: role,
    score: DEFAULT_SCORE,
    consecutivePasses: 0,
    consecutiveFailures: 0,
    totalEvaluations: 0,
    totalPasses: 0,
    lastEvaluationAt: null,
    updatedAt: new Date().toISOString(),
  };
}

// ── Load from Supabase ───────────────────────────────────────

export async function loadTrustScores(
  supabase: SupabaseClient
): Promise<Record<string, TrustScore>> {
  const { data, error } = await supabase
    .from("trust_scores")
    .select("*");

  if (error) {
    console.error("loadTrustScores error:", error);
    return trustScoreCache;
  }

  for (const row of data || []) {
    trustScoreCache[row.agent_role] = {
      agentRole: row.agent_role,
      score: row.score,
      consecutivePasses: row.consecutive_passes,
      consecutiveFailures: row.consecutive_failures,
      totalEvaluations: row.total_evaluations,
      totalPasses: row.total_passes,
      lastEvaluationAt: row.last_evaluation_at,
      updatedAt: row.updated_at,
    };
  }

  return trustScoreCache;
}

// ── Update Trust Score ───────────────────────────────────────

/**
 * Update the trust score for an agent role after a gate evaluation.
 * - Pass without rework: +5
 * - Pass with rework: +1
 * - Fail (after max rework): -10
 */
export async function updateTrustScore(
  supabase: SupabaseClient | null,
  agentRole: string,
  update: TrustScoreUpdate
): Promise<TrustScore> {
  const current = trustScoreCache[agentRole] || makeDefaultTrustScore(agentRole);

  // Calculate delta
  let delta: number;
  if (update.passed && !update.hadRework) {
    delta = PASS_NO_REWORK_DELTA;
  } else if (update.passed && update.hadRework) {
    delta = PASS_WITH_REWORK_DELTA;
  } else {
    delta = FAIL_DELTA;
  }

  // Apply
  const newScore = Math.max(MIN_SCORE, Math.min(MAX_SCORE, current.score + delta));

  const updated: TrustScore = {
    agentRole,
    score: newScore,
    consecutivePasses: update.passed ? current.consecutivePasses + 1 : 0,
    consecutiveFailures: update.passed ? 0 : current.consecutiveFailures + 1,
    totalEvaluations: current.totalEvaluations + 1,
    totalPasses: current.totalPasses + (update.passed ? 1 : 0),
    lastEvaluationAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Update cache
  trustScoreCache[agentRole] = updated;

  // Persist to Supabase
  if (supabase) {
    const { error } = await supabase
      .from("trust_scores")
      .upsert({
        agent_role: agentRole,
        score: updated.score,
        consecutive_passes: updated.consecutivePasses,
        consecutive_failures: updated.consecutiveFailures,
        total_evaluations: updated.totalEvaluations,
        total_passes: updated.totalPasses,
        last_evaluation_at: updated.lastEvaluationAt,
        updated_at: updated.updatedAt,
      }, { onConflict: "agent_role" });

    if (error) {
      console.error("updateTrustScore persist error:", error);
    }
  }

  return updated;
}

// ── Auto-Approval Check ──────────────────────────────────────

/**
 * Check if a gate can be auto-approved based on trust score.
 * Returns true if auto-approval is warranted.
 *
 * Rules:
 * - Trust >= 80 + P3+: spec/plan/tasks gates auto-approved
 * - Trust >= 90 + P3+: implementation gate auto-approved (deterministic checks still run)
 * - P1/P2: never auto-approved
 */
export function shouldAutoApprove(
  agentRole: string,
  gateName: string,
  taskPriority: number
): boolean {
  // P1/P2 always requires full evaluation
  if (taskPriority < AUTO_APPROVE_MAX_PRIORITY) return false;

  const trust = getCachedTrustScore(agentRole);

  if (gateName === "implementation") {
    return trust.score >= AUTO_APPROVE_IMPL_THRESHOLD;
  }

  // spec, plan, tasks gates
  return trust.score >= AUTO_APPROVE_SPEC_THRESHOLD;
}

// ── Formatting ───────────────────────────────────────────────

export function formatTrustScores(): string {
  const roles = Object.keys(trustScoreCache);
  if (roles.length === 0) return "Pas de donnees de confiance";

  const lines: string[] = ["Trust scores par role:"];
  for (const role of roles.sort()) {
    const ts = trustScoreCache[role];
    const passRate = ts.totalEvaluations > 0
      ? Math.round((ts.totalPasses / ts.totalEvaluations) * 100)
      : 0;
    lines.push(`  ${role}: ${ts.score}/100 (${ts.consecutivePasses} passes consecutives, ${passRate}% succes, ${ts.totalEvaluations} evals)`);
  }
  return lines.join("\n");
}

/**
 * Format recent gate evaluations for /monitor.
 */
export async function formatRecentGateEvaluations(
  supabase: SupabaseClient | null
): Promise<string> {
  if (!supabase) return "Pas de connexion Supabase";

  const { data, error } = await supabase
    .from("gate_evaluations")
    .select("agent_role, gate_name, score, passed, auto_approved, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  if (error || !data || data.length === 0) return "Aucune evaluation recente";

  const lines: string[] = ["Evaluations recentes:"];
  for (const row of data) {
    const status = row.auto_approved ? "AUTO" : (row.passed ? "PASS" : "FAIL");
    const date = new Date(row.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
    lines.push(`  ${row.agent_role}/${row.gate_name}: ${status} (${row.score}/100) ${date}`);
  }
  return lines.join("\n");
}

/**
 * Reset trust score cache (for testing).
 */
export function resetTrustScoreCache(): void {
  for (const key of Object.keys(trustScoreCache)) {
    delete trustScoreCache[key];
  }
}
