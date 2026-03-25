/**
 * @module feedback-analyzer
 * @description Analyzes agent feedback signals (NO-GO verdicts, review failures)
 * to detect recurring patterns and generate prompt overlays for SDD agents.
 * Runs as part of the heartbeat feedback loop.
 *
 * Design: pure analysis functions + a runFeedbackLoop orchestrator.
 * Dependencies are injected for testability (isFeatureEnabled, fetchSignals).
 */

import { createLogger } from "./logger.ts";
import { addOverlay, expireOverlays, getActiveOverlays } from "./prompt-overlay.ts";

const log = createLogger("feedback-analyzer");

// ── Types ────────────────────────────────────────────────────

export interface AgentFeedbackSignal {
  agentRole: string;
  outcome: "GO" | "GO_WITH_CHANGES" | "NO-GO" | "APPROVED" | "CHANGES_REQUESTED" | "FAILED";
  timestamp: string;
  source: "challenge" | "review" | "implement" | "explore";
  details?: string;
}

export interface RecurringPattern {
  agentRole: string;
  failureCount: number;
  source: string;
  recentOutcomes: string[];
}

export interface FeedbackLoopResult {
  skipped: boolean;
  overlaysCreated: number;
  expiredCount: number;
  patternsDetected: number;
}

// ── Constants ────────────────────────────────────────────────

/** Minimum failures to trigger an overlay */
const RECURRENCE_THRESHOLD = 3;

/** Failure outcomes that count toward the threshold */
const FAILURE_OUTCOMES = new Set(["NO-GO", "GO_WITH_CHANGES", "CHANGES_REQUESTED", "FAILED"]);

// ── Dependency Injection ─────────────────────────────────────

interface Dependencies {
  isFeatureEnabled: (flag: string) => boolean;
  fetchSignals: () => Promise<AgentFeedbackSignal[]>;
}

let _deps: Dependencies | null = null;

/**
 * @internal — for tests: inject dependencies.
 */
export function _setDependencies(deps: Dependencies | null): void {
  _deps = deps;
}

function getDeps(): Dependencies {
  if (_deps) return _deps;
  // Default production dependencies — lazy loaded
  const { isFeatureEnabled } = require("./feature-flags.ts");
  return {
    isFeatureEnabled,
    fetchSignals: async () => [],
  };
}

// ── Analysis Functions ───────────────────────────────────────

/**
 * Analyze a list of agent feedback signals and detect recurring failure patterns.
 * Groups failures by agentRole and source, returns patterns exceeding the threshold.
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

    patterns.push({
      agentRole: role,
      failureCount: failures.length,
      source: dominantSource,
      recentOutcomes: roleSignals.map((s) => s.outcome),
    });
  }

  return patterns;
}

/**
 * Generate a corrective overlay text based on the detected failure pattern.
 * This is a deterministic template — no LLM call needed for the initial version.
 * Future improvement: use Haiku to generate more contextual overlays.
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
 */
export async function runFeedbackLoop(): Promise<FeedbackLoopResult> {
  const deps = getDeps();

  // Gate on feature flag
  if (!deps.isFeatureEnabled("prompt_feedback_loop")) {
    return { skipped: true, overlaysCreated: 0, expiredCount: 0, patternsDetected: 0 };
  }

  // Step 1: Expire old overlays
  const expiredCount = expireOverlays();

  // Step 2: Fetch recent signals
  let signals: AgentFeedbackSignal[];
  try {
    signals = await deps.fetchSignals();
  } catch (err) {
    log.error("Failed to fetch feedback signals", { error: String(err) });
    return { skipped: false, overlaysCreated: 0, expiredCount, patternsDetected: 0 };
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

    const overlayText = generateOverlayText(
      pattern.agentRole,
      pattern.failureCount,
      pattern.source,
    );
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
  };
}
