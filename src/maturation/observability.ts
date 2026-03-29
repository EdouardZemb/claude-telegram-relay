/**
 * @module maturation/observability
 * @description V1 observability: aggregated stats over maturation runs from filesystem.
 * Reads meta.json files from .maturation/runs/ without modifying pipeline behavior.
 * Used by /brain health to surface maturation pipeline health.
 */

import { createLogger } from "../logger.ts";
import { listRuns } from "./documents.ts";
import type { MaturationPhase, MaturationRun } from "./types.ts";

const log = createLogger("maturation/observability");

// ── Types ────────────────────────────────────────────────────

export interface MaturationRunSummary {
  id: string;
  name: string;
  currentPhase: MaturationPhase;
  maturityScore?: number;
  hasShowstopper: boolean;
  iteration: number;
  overlaysUsed: boolean;
  createdAt: string;
}

export interface MaturationStats {
  totalRuns: number;
  completedRuns: number;
  showstopperCount: number;
  loopbackCount: number;
  avgMaturityScore: number;
  overlayUsageCount: number;
  byPhase: Record<string, number>;
  recentRuns: MaturationRunSummary[];
}

// ── Helpers ──────────────────────────────────────────────────

function extractMaturityScoreFromRun(run: MaturationRun): number | undefined {
  const synthesizeStep = run.steps.synthesize;
  if (synthesizeStep?.score !== undefined && synthesizeStep.score > 0) {
    return synthesizeStep.score;
  }
  return undefined;
}

function hasShowstopperInRun(run: MaturationRun): boolean {
  const advocateStep = run.steps.advocate;
  if (!advocateStep?.verdict) return false;
  return advocateStep.verdict.toUpperCase().includes("SHOWSTOPPER");
}

function hasOverlaysUsedInRun(run: MaturationRun): boolean {
  for (const step of Object.values(run.steps)) {
    if (step.overlaysUsed === true) return true;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Aggregates stats from all maturation runs on disk.
 * Reads listRuns() (sorted by createdAt desc) and builds a summary.
 */
export async function getMaturationStats(): Promise<MaturationStats> {
  let runs: MaturationRun[] = [];
  try {
    runs = await listRuns();
  } catch (err) {
    log.error("getMaturationStats: failed to list runs", { error: String(err) });
  }

  const stats: MaturationStats = {
    totalRuns: runs.length,
    completedRuns: 0,
    showstopperCount: 0,
    loopbackCount: 0,
    avgMaturityScore: 0,
    overlayUsageCount: 0,
    byPhase: {},
    recentRuns: [],
  };

  let maturityScoreSum = 0;
  let maturityScoreCount = 0;

  for (const run of runs) {
    // Count by current phase
    stats.byPhase[run.currentPhase] = (stats.byPhase[run.currentPhase] ?? 0) + 1;

    if (run.currentPhase === "validate") {
      stats.completedRuns++;
    }

    if (hasShowstopperInRun(run)) {
      stats.showstopperCount++;
    }

    if (run.iteration > 0) {
      stats.loopbackCount++;
    }

    if (hasOverlaysUsedInRun(run)) {
      stats.overlayUsageCount++;
    }

    const score = extractMaturityScoreFromRun(run);
    if (score !== undefined) {
      maturityScoreSum += score;
      maturityScoreCount++;
    }

    // Keep last 5 runs as summaries
    if (stats.recentRuns.length < 5) {
      stats.recentRuns.push({
        id: run.id.slice(0, 8),
        name: run.name,
        currentPhase: run.currentPhase,
        maturityScore: score,
        hasShowstopper: hasShowstopperInRun(run),
        iteration: run.iteration,
        overlaysUsed: hasOverlaysUsedInRun(run),
        createdAt: run.createdAt,
      });
    }
  }

  if (maturityScoreCount > 0) {
    stats.avgMaturityScore = Math.round((maturityScoreSum / maturityScoreCount) * 10) / 10;
  }

  return stats;
}

/**
 * Formats MaturationStats as an HTML string for Telegram /brain health.
 */
export function formatMaturationStats(stats: MaturationStats): string {
  if (stats.totalRuns === 0) {
    return "<b>Maturation</b>\nAucun run enregistre.";
  }

  const showstopperRate =
    stats.totalRuns > 0 ? Math.round((stats.showstopperCount / stats.totalRuns) * 100) : 0;
  const loopbackRate =
    stats.totalRuns > 0 ? Math.round((stats.loopbackCount / stats.totalRuns) * 100) : 0;

  const lines: string[] = [
    "<b>Maturation Pipeline</b>",
    `• Runs totaux : <b>${stats.totalRuns}</b> (${stats.completedRuns} completes)`,
    `• Score moyen : <b>${stats.avgMaturityScore > 0 ? `${stats.avgMaturityScore}/10` : "N/A"}</b>`,
    `• Showstoppers : ${stats.showstopperCount} (${showstopperRate}%)`,
    `• Loop-backs : ${stats.loopbackCount} (${loopbackRate}%)`,
  ];

  if (stats.overlayUsageCount > 0) {
    lines.push(`• Overlays actifs : ${stats.overlayUsageCount} run(s)`);
  }

  if (stats.recentRuns.length > 0) {
    lines.push("\n<b>5 derniers runs :</b>");
    for (const r of stats.recentRuns) {
      const score = r.maturityScore !== undefined ? ` — ${r.maturityScore}/10` : "";
      const flags = [
        r.hasShowstopper ? "⚠ STOP" : "",
        r.iteration > 0 ? `↻${r.iteration}` : "",
        r.overlaysUsed ? "🔧" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const flagStr = flags ? ` [${flags}]` : "";
      lines.push(`  • <code>${r.name.slice(0, 40)}</code> (${r.currentPhase}${score}${flagStr})`);
    }
  }

  return lines.join("\n");
}
