/**
 * @module feedback-analyzer
 * @description Analyzes agent feedback signals (NO-GO verdicts, review failures)
 * to detect recurring patterns and generate prompt overlays for SDD agents.
 * Runs as part of the heartbeat feedback loop and post-SDD-job.
 *
 * Design: pure analysis functions + a runFeedbackLoop orchestrator.
 * Dependencies are injected for testability (isFeatureEnabled, fetchSignals,
 * generateOverlayFn). The LLM path (Haiku) lives inside getDeps() only,
 * keeping feedback-analyzer.ts free of a hard import on agent.ts (F-SS-1).
 */

import { createLogger } from "./logger.ts";
import {
  addOverlay,
  expireOverlays,
  getActiveOverlays,
  purgeInactiveOverlays,
} from "./prompt-overlay.ts";

const log = createLogger("feedback-analyzer");

// ── Types ────────────────────────────────────────────────────

export interface AgentFeedbackSignal {
  agentRole: string;
  outcome: "GO" | "GO_WITH_CHANGES" | "NO-GO" | "APPROVED" | "CHANGES_REQUESTED" | "FAILED";
  timestamp: string;
  /** Phase that emitted the signal (F-EC-1: "spec" and "discuss" added) */
  source: "challenge" | "review" | "implement" | "explore" | "spec" | "discuss";
  details?: string;
}

export interface RecurringPattern {
  agentRole: string;
  failureCount: number;
  source: string;
  recentOutcomes: string[];
  /** Aggregated details from individual signals — used for LLM overlay (R4) */
  aggregatedDetails?: string;
}

export interface FeedbackLoopResult {
  skipped: boolean;
  overlaysCreated: number;
  expiredCount: number;
  patternsDetected: number;
  purgedCount: number;
}

// ── Constants ────────────────────────────────────────────────

/** Minimum failures to trigger an overlay */
const RECURRENCE_THRESHOLD = 3;

/** Failure outcomes that count toward the threshold */
const FAILURE_OUTCOMES = new Set(["NO-GO", "GO_WITH_CHANGES", "CHANGES_REQUESTED", "FAILED"]);

/** Max chars for aggregated details sent to LLM */
const DETAILS_MAX_CHARS = 500;

/** Max chars for LLM-generated overlay text */
const LLM_OVERLAY_MAX_CHARS = 300;

// ── Dependency Injection ─────────────────────────────────────

interface Dependencies {
  isFeatureEnabled: (flag: string) => boolean;
  fetchSignals: () => Promise<AgentFeedbackSignal[]>;
  /**
   * Generate overlay text for a pattern. When sdd_feedback_llm_overlay is on,
   * this calls Haiku; otherwise falls back to the static template.
   * Kept injectable so tests can mock without spawning a CLI process.
   * Optional: if not provided, falls back to generateOverlayText template directly.
   */
  generateOverlayFn?: (
    agentRole: string,
    failureCount: number,
    source: string,
    aggregatedDetails?: string,
  ) => Promise<string>;
}

let _deps: Dependencies | null = null;

/**
 * @internal — for tests: inject dependencies.
 */
export function _setDependencies(deps: Dependencies | null): void {
  _deps = deps;
}

/**
 * Build the real fetchSignals implementation using Supabase.
 * Reads agent_events filtered by event_type='sdd_verdict' over 7 days.
 * Returns only negative-outcome signals (FAILURE_OUTCOMES).
 * Rows with missing/invalid payload fields are skipped defensively (F-DA-2, F-DA-9).
 */
async function buildFetchSignals(): Promise<AgentFeedbackSignal[]> {
  try {
    const { getConfig } = await import("./config.ts");
    const { createClient } = await import("@supabase/supabase-js");
    const config = getConfig();
    const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("agent_events")
      .select("agent_role,event_type,payload,created_at")
      .eq("event_type", "sdd_verdict")
      .gte("created_at", cutoff);

    if (error) {
      log.error("fetchSignals: Supabase query failed", { error: String(error) });
      return [];
    }

    const signals: AgentFeedbackSignal[] = [];
    for (const row of data ?? []) {
      const payload = row.payload;
      if (!payload || typeof payload !== "object") continue;

      const verdict = payload.verdict as string | undefined;
      const source = payload.source as string | undefined;
      if (!verdict || !source) continue;

      // Only return negative-outcome signals (R2)
      if (!FAILURE_OUTCOMES.has(verdict)) continue;

      signals.push({
        agentRole: row.agent_role as string,
        outcome: verdict as AgentFeedbackSignal["outcome"],
        timestamp: row.created_at as string,
        source: source as AgentFeedbackSignal["source"],
        details: typeof payload.details === "string" ? payload.details : undefined,
      });
    }

    return signals;
  } catch (err) {
    log.error("fetchSignals: unexpected error", { error: String(err) });
    return [];
  }
}

/**
 * Build the real generateOverlayFn using Haiku (when sdd_feedback_llm_overlay is on).
 * Falls back to the static template on any error or when the flag is off.
 */
function buildGenerateOverlayFn(isFeatureEnabled: (flag: string) => boolean) {
  return async (
    agentRole: string,
    failureCount: number,
    source: string,
    aggregatedDetails?: string,
  ): Promise<string> => {
    if (isFeatureEnabled("sdd_feedback_llm_overlay") && aggregatedDetails) {
      try {
        const { spawnClaude } = await import("./agent.ts");
        const prompt = [
          "Tu génères une instruction corrective courte (max 300 chars, en français) pour un agent IA SDD.",
          `Agent: ${agentRole}`,
          `Echecs récents (${failureCount}): source=${source}`,
          `Details des signaux: ${aggregatedDetails.substring(0, DETAILS_MAX_CHARS)}`,
          'Ecris une instruction d\'action concrète commençant par "ATTENTION :".',
        ].join("\n");

        const result = await spawnClaude({
          prompt,
          model: "claude-haiku-4-5-20251001",
          effort: "low",
          useWorktree: false,
        });

        // Fallback on any failure: exitCode != 0, empty stdout, or result too short
        if (result.exitCode === 0 && result.stdout.trim().length > 10) {
          const text = result.stdout.trim().substring(0, LLM_OVERLAY_MAX_CHARS);
          log.info("LLM overlay generated", { agentRole, source, length: text.length });
          return text;
        }

        log.warn("LLM overlay fallback: empty or failed result", {
          agentRole,
          exitCode: result.exitCode,
        });
      } catch (err) {
        log.warn("LLM overlay fallback: exception", { agentRole, error: String(err) });
      }
    }

    // Fallback to static template (R5)
    return generateOverlayText(agentRole, failureCount, source);
  };
}

function getDeps(): Dependencies {
  if (_deps) return _deps;
  // Default production dependencies — lazy loaded
  const { isFeatureEnabled } = require("./feature-flags.ts");
  return {
    isFeatureEnabled,
    fetchSignals: buildFetchSignals,
    generateOverlayFn: buildGenerateOverlayFn(isFeatureEnabled),
  };
}

// ── Analysis Functions ───────────────────────────────────────

/**
 * Analyze a list of agent feedback signals and detect recurring failure patterns.
 * Groups failures by agentRole and source, returns patterns exceeding the threshold.
 * Aggregates signal details for LLM use.
 */
export function analyzeAgentFeedback(
  signals: AgentFeedbackSignal[],
  threshold: number = RECURRENCE_THRESHOLD,
): RecurringPattern[] {
  // Group by agentRole
  const byRole: Record<string, AgentFeedbackSignal[]> = {};
  for (const signal of signals) {
    if (!byRole[signal.agentRole]) byRole[signal.agentRole] = [];
    byRole[signal.agentRole].push(signal);
  }

  const patterns: RecurringPattern[] = [];

  for (const [role, roleSignals] of Object.entries(byRole)) {
    // Count failures for this role
    const failures = roleSignals.filter((s) => FAILURE_OUTCOMES.has(s.outcome));
    if (failures.length < threshold) continue;

    // Determine the dominant source
    const sourceCounts: Record<string, number> = {};
    for (const f of failures) {
      sourceCounts[f.source] = (sourceCounts[f.source] || 0) + 1;
    }
    const dominantSource = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])[0][0];

    // Aggregate details from failure signals (F-EC-3: use 200 chars per signal)
    const detailParts = failures
      .map((f) => f.details)
      .filter((d): d is string => Boolean(d))
      .map((d) => d.substring(0, 200));
    const aggregatedDetails = detailParts.length > 0 ? detailParts.join(" | ") : undefined;

    patterns.push({
      agentRole: role,
      failureCount: failures.length,
      source: dominantSource,
      recentOutcomes: roleSignals.map((s) => s.outcome),
      aggregatedDetails,
    });
  }

  return patterns;
}

/**
 * Generate a corrective overlay text based on the detected failure pattern.
 * Static template fallback — used when LLM mode is disabled or fails.
 */
export function generateOverlayText(
  agentRole: string,
  failureCount: number,
  source: string,
): string {
  const templates: Record<string, Record<string, string>> = {
    challenge: {
      "spec-architect": `ATTENTION : ${failureCount} specs recentes ont ete rejetees (NO-GO) par les agents adversariaux. Ameliore la precision des V-criteres, evite les formulations abstraites, et assure-toi que chaque section de la spec est actionnable et testable.`,
      default: `ATTENTION : ${failureCount} echecs recents detectes lors de la phase challenge. Revise ton approche pour tenir compte des retours des agents adversariaux.`,
    },
    review: {
      reviewer: `ATTENTION : ${failureCount} reviews recentes ont demande des changements (CHANGES_REQUESTED). Sois plus rigoureux dans la verification de conformite avec la spec et la couverture des V-criteres.`,
      default: `ATTENTION : ${failureCount} echecs recents detectes lors de la phase review. Ameliore la qualite de ton output en tenant compte des retours precedents.`,
    },
    implement: {
      default: `ATTENTION : ${failureCount} implementations recentes ont echoue. Verifie que le code compile, que les tests passent, et que les imports sont corrects avant de finaliser.`,
    },
    explore: {
      default: `ATTENTION : ${failureCount} explorations recentes ont echoue. Assure-toi que le rapport est structure et complet avant de rendre un verdict.`,
    },
    spec: {
      "spec-architect": `ATTENTION : ${failureCount} specs recentes ont ete rejetees. Revois la structure des 9 sections et assure-toi que chaque V-critere est testable.`,
      default: `ATTENTION : ${failureCount} echecs recents lors de la phase spec. Ameliore la qualite des specifications.`,
    },
    discuss: {
      default: `ATTENTION : ${failureCount} echecs recents lors de la phase discussion. Assure-toi de bien capturer les decisions et contraintes avant de passer a la specification.`,
    },
  };

  const sourceTemplates = templates[source] || templates.challenge;
  return (
    sourceTemplates[agentRole] ||
    sourceTemplates.default ||
    `ATTENTION : ${failureCount} echecs recents detectes. Ameliore la qualite de ton output.`
  );
}

// ── Orchestrator ─────────────────────────────────────────────

/**
 * Run the complete feedback loop:
 * 1. Check feature flag
 * 2. Expire old overlays
 * 3. Fetch recent signals
 * 4. Analyze for recurring patterns
 * 5. Create overlays for detected patterns (skip duplicates)
 *    — uses LLM (Haiku) when sdd_feedback_llm_overlay is enabled (R4)
 *    — falls back to static templates otherwise (R5)
 */
export async function runFeedbackLoop(): Promise<FeedbackLoopResult> {
  const deps = getDeps();

  // Gate on feature flag
  if (!deps.isFeatureEnabled("prompt_feedback_loop")) {
    return {
      skipped: true,
      overlaysCreated: 0,
      expiredCount: 0,
      patternsDetected: 0,
      purgedCount: 0,
    };
  }

  // Step 1: Expire and purge old overlays
  const expiredCount = expireOverlays();
  const purgedCount = purgeInactiveOverlays();

  // Step 2: Fetch recent signals
  let signals: AgentFeedbackSignal[];
  try {
    signals = await deps.fetchSignals();
  } catch (err) {
    log.error("Failed to fetch feedback signals", { error: String(err) });
    return { skipped: false, overlaysCreated: 0, expiredCount, patternsDetected: 0, purgedCount };
  }

  // Step 3: Analyze for recurring patterns
  const patterns = analyzeAgentFeedback(signals);

  // Step 4: Create overlays, skip duplicates
  let overlaysCreated = 0;
  for (const pattern of patterns) {
    // Check if an active overlay already exists for this role+source
    const existing = getActiveOverlays(pattern.agentRole);
    const hasSimilar = existing.some(
      (o) => o.triggerType === "alert" && o.triggerData?.source === pattern.source,
    );
    if (hasSimilar) {
      log.info("Skipping duplicate overlay", {
        agentRole: pattern.agentRole,
        source: pattern.source,
      });
      continue;
    }

    // Generate overlay text — LLM mode if enabled and details available, else template
    let overlayText: string;
    if (deps.generateOverlayFn) {
      try {
        overlayText = await deps.generateOverlayFn(
          pattern.agentRole,
          pattern.failureCount,
          pattern.source,
          pattern.aggregatedDetails,
        );
      } catch (err) {
        log.warn("generateOverlayFn failed, using template fallback", { error: String(err) });
        overlayText = generateOverlayText(pattern.agentRole, pattern.failureCount, pattern.source);
      }
    } else {
      overlayText = generateOverlayText(pattern.agentRole, pattern.failureCount, pattern.source);
    }

    addOverlay({
      agentRole: pattern.agentRole,
      overlayText,
      reason: `${pattern.failureCount} echecs recents (source: ${pattern.source})`,
      triggerType: "alert",
      triggerData: {
        source: pattern.source,
        failureCount: pattern.failureCount,
        recentOutcomes: pattern.recentOutcomes,
      },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 day TTL
    });

    overlaysCreated++;
    log.info("Overlay created from feedback", {
      agentRole: pattern.agentRole,
      source: pattern.source,
      failures: pattern.failureCount,
    });
  }

  return {
    skipped: false,
    overlaysCreated,
    expiredCount,
    patternsDetected: patterns.length,
    purgedCount,
  };
}
