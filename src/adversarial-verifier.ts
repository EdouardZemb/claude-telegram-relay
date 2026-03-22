/**
 * @module adversarial-verifier
 * @description Clean room spec-vs-implementation drift detection, coverage scoring.
 */

/**
 * Adversarial Verifier — S24 Gated Blackboard & SDD
 *
 * Clean room verification: receives ONLY spec + implementation (not plan/tasks).
 * Detects spec drift by independently comparing requirements to final output.
 * T5: Adversarial Verifier (FR-005)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { spawnClaude } from "./agent.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("adversarial-verifier");
// ── Types ────────────────────────────────────────────────────

export interface DriftItem {
  fr_id: string;
  status: "implemented" | "missing" | "partial" | "divergent";
  details: string;
}

export interface DriftReport {
  coverage_score: number;
  drift_items: DriftItem[];
  overall_verdict: "pass" | "fail" | "warning";
}

const VERIFIER_TIMEOUT = 180_000; // 3 minutes

// ── Verifier ─────────────────────────────────────────────────

/**
 * Run the adversarial verifier.
 * Receives ONLY spec + implementation (AC-014, clean room principle).
 * Produces a DriftReport (AC-015).
 *
 * Skips on QUICK pipeline (EC-006).
 */
export async function verifySpecVsImplementation(
  spec: any,
  implementation: any,
  pipelineType?: string,
): Promise<DriftReport | null> {
  // EC-006: Skip on QUICK pipeline
  if (pipelineType === "QUICK" || pipelineType === "quick") {
    log.info("adversarial-verifier: skipping for QUICK pipeline (EC-006)");
    return null;
  }

  if (!spec || !implementation) {
    return {
      coverage_score: 0,
      drift_items: [],
      overall_verdict: "warning",
    };
  }

  const prompt = [
    "You are an ADVERSARIAL VERIFIER for a software development pipeline.",
    "Your role is to independently verify that the implementation satisfies the original specification.",
    "You have NOT seen the plan or task breakdown — only the original spec and the final implementation.",
    "",
    "ORIGINAL SPECIFICATION:",
    JSON.stringify(spec, null, 2).substring(0, 20000),
    "",
    "FINAL IMPLEMENTATION:",
    JSON.stringify(implementation, null, 2).substring(0, 20000),
    "",
    "For each Functional Requirement (FR-XXX) in the spec, verify:",
    "1. Is it fully implemented? (implemented)",
    "2. Is it missing entirely? (missing)",
    "3. Is it partially implemented? (partial)",
    "4. Is it implemented differently than specified? (divergent)",
    "",
    "Return ONLY a JSON object with this exact structure:",
    "{",
    '  "coverage_score": 0-100,',
    '  "drift_items": [{"fr_id": "FR-001", "status": "implemented|missing|partial|divergent", "details": "..."}],',
    '  "overall_verdict": "pass|fail|warning"',
    "}",
    "",
    "Coverage score: percentage of FR that are fully implemented.",
    "Verdict: pass if >= 80% coverage, warning if 50-79%, fail if < 50%.",
    "No other text. Only valid JSON.",
  ].join("\n");

  try {
    // S28: Use centralized spawnClaude with effort=medium for verifier
    const resultPromise = spawnClaude({
      prompt,
      effort: "medium",
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), VERIFIER_TIMEOUT);
    });

    const result = await Promise.race([resultPromise, timeoutPromise]);

    if (!result) {
      log.warn("adversarial-verifier: timed out");
      return {
        coverage_score: 50,
        drift_items: [],
        overall_verdict: "warning",
      };
    }

    return parseDriftReport(result.stdout);
  } catch (error) {
    log.error("adversarial-verifier error", { error: String(error) });
    return {
      coverage_score: 0,
      drift_items: [],
      overall_verdict: "warning",
    };
  }
}

/**
 * Parse the verifier output into a DriftReport.
 */
export function parseDriftReport(output: string): DriftReport {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(output);
    return normalizeDriftReport(parsed);
  } catch {
    // Try to extract JSON from the output
  }

  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeDriftReport(parsed);
    } catch {
      // Fall through
    }
  }

  return {
    coverage_score: 50,
    drift_items: [],
    overall_verdict: "warning",
  };
}

function normalizeDriftReport(obj: any): DriftReport {
  const coverage =
    typeof obj.coverage_score === "number" ? Math.min(100, Math.max(0, obj.coverage_score)) : 50;

  const driftItems: DriftItem[] = Array.isArray(obj.drift_items)
    ? obj.drift_items.map((item: any) => ({
        fr_id: String(item.fr_id || "unknown"),
        status: ["implemented", "missing", "partial", "divergent"].includes(item.status)
          ? item.status
          : "partial",
        details: String(item.details || ""),
      }))
    : [];

  const verdict = ["pass", "fail", "warning"].includes(obj.overall_verdict)
    ? obj.overall_verdict
    : coverage >= 80
      ? "pass"
      : coverage >= 50
        ? "warning"
        : "fail";

  return { coverage_score: coverage, drift_items: driftItems, overall_verdict: verdict };
}

// ── P3: Conformance Check (V-criteria) ───────────────────────

/**
 * Check conformance of dev output against proto-spec V-criteria.
 * Reuses verifySpecVsImplementation logic with V-criteria instead of FR-XXX.
 *
 * V6: Produces a DriftReport with one item per V-criterion.
 * R10: Reuses adversarial-verifier logic.
 * R9: Only called if P1 produced V-criteria.
 */
export async function checkConformance(
  protoSpec: {
    objective: string;
    v_criteria: Array<{ id: string; description: string; level: string }>;
  },
  devOutput: any,
  pipelineType?: string,
): Promise<DriftReport | null> {
  // Skip on QUICK pipeline
  if (pipelineType === "QUICK" || pipelineType === "quick") {
    return null;
  }

  if (!protoSpec || !protoSpec.v_criteria || protoSpec.v_criteria.length === 0) {
    return {
      coverage_score: 0,
      drift_items: [],
      overall_verdict: "warning",
    };
  }

  if (!devOutput) {
    return {
      coverage_score: 0,
      drift_items: protoSpec.v_criteria.map((c) => ({
        fr_id: c.id,
        status: "missing" as const,
        details: `V-criterion [${c.id}] not verified: no implementation output`,
      })),
      overall_verdict: "fail",
    };
  }

  // Build spec in the format expected by the verifier, with V-criteria notation
  const specForVerifier = {
    objective: protoSpec.objective,
    requirements: protoSpec.v_criteria.map((c) => `[${c.id}] ${c.description} (${c.level})`),
  };

  const prompt = [
    "You are a CONFORMANCE CHECKER for a software development pipeline.",
    "Your role is to verify that the implementation satisfies the V-criteria from the proto-spec.",
    "",
    "PROTO-SPEC (V-CRITERIA):",
    JSON.stringify(specForVerifier, null, 2),
    "",
    "IMPLEMENTATION OUTPUT:",
    JSON.stringify(devOutput, null, 2).substring(0, 20000),
    "",
    "For each V-criterion ([V1], [V2], etc.), verify:",
    "1. Is it fully implemented? (implemented)",
    "2. Is it missing entirely? (missing)",
    "3. Is it partially implemented? (partial)",
    "4. Is it implemented differently than specified? (divergent)",
    "",
    "Return ONLY a JSON object with this exact structure:",
    "{",
    '  "coverage_score": 0-100,',
    '  "drift_items": [{"fr_id": "V1", "status": "implemented|missing|partial|divergent", "details": "..."}],',
    '  "overall_verdict": "pass|fail|warning"',
    "}",
    "",
    "Coverage score: percentage of V-criteria that are fully implemented.",
    "Verdict: pass if >= 80% coverage, warning if 50-79%, fail if < 50%.",
    "No other text. Only valid JSON.",
  ].join("\n");

  try {
    const resultPromise = spawnClaude({
      prompt,
      effort: "medium",
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), VERIFIER_TIMEOUT);
    });

    const result = await Promise.race([resultPromise, timeoutPromise]);

    if (!result) {
      log.warn("checkConformance: timed out");
      return {
        coverage_score: 50,
        drift_items: [],
        overall_verdict: "warning",
      };
    }

    return parseDriftReport(result.stdout);
  } catch (error) {
    log.error("checkConformance error", { error: String(error) });
    return {
      coverage_score: 0,
      drift_items: [],
      overall_verdict: "warning",
    };
  }
}

/**
 * Store drift report in blackboard and workflow_logs (AC-016).
 */
export async function persistDriftReport(
  supabase: SupabaseClient,
  sessionId: string,
  taskId: string | null,
  report: DriftReport,
): Promise<void> {
  // Store in workflow_logs
  const { error } = await supabase.from("workflow_logs").insert({
    task_id: taskId,
    step_from: "verification",
    step_to: "verification",
    checkpoint_mode: "strict",
    checkpoint_result: report.overall_verdict === "pass" ? "pass" : "fail",
    checkpoint_notes: `Adversarial verification: ${report.coverage_score}% coverage, ${report.drift_items.length} items`,
    metadata: {
      type: "adversarial_verification",
      session_id: sessionId,
      coverage_score: report.coverage_score,
      overall_verdict: report.overall_verdict,
      drift_items: report.drift_items,
    },
  });
  if (error) log.error("persistDriftReport error", { error: String(error) });
}

/**
 * Format drift report for Telegram display.
 */
export function formatDriftReport(report: DriftReport | null): string {
  if (!report) return "Adversarial verification: skipped (QUICK pipeline)";

  const lines: string[] = [
    "ADVERSARIAL VERIFICATION",
    `Coverage: ${report.coverage_score}%`,
    `Verdict: ${report.overall_verdict.toUpperCase()}`,
  ];

  if (report.drift_items.length > 0) {
    lines.push("");
    for (const item of report.drift_items) {
      const icon = item.status === "implemented" ? "+" : item.status === "missing" ? "!" : "~";
      lines.push(`  ${icon} ${item.fr_id}: ${item.status} — ${item.details}`);
    }
  }

  return lines.join("\n");
}
