/**
 * Adversarial Code Review System
 *
 * Automated code review that runs post-implementation, before merge.
 * Uses BMad QA/Dev agents to find issues. Minimum 3 findings required.
 *
 * S15-07: Adversarial code review
 * S15-08: Gate integration pre-merge
 */

import { spawn, spawnSync } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildFullAgentPrompt } from "./bmad-prompts.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const GITHUB_REPO = process.env.GITHUB_REPO || "EdouardZemb/claude-telegram-relay";

// ── Types ────────────────────────────────────────────────────

export type FindingSeverity = "critical" | "important" | "minor" | "suggestion";

export interface ReviewFinding {
  severity: FindingSeverity;
  category: string;
  file: string;
  line?: number;
  description: string;
  suggestion: string;
}

export interface CodeReviewResult {
  success: boolean;
  findings: ReviewFinding[];
  summary: string;
  score: number; // 0-100
  passesGate: boolean;
  rawOutput: string;
}

// ── Code Review ──────────────────────────────────────────────

/**
 * Run an adversarial code review on the diff of a branch.
 * Gets the diff from git, sends it to Claude with a review agent persona.
 */
export async function runCodeReview(
  branchName: string,
  taskTitle: string,
  onProgress?: (msg: string) => Promise<void>
): Promise<CodeReviewResult> {
  // Get the diff between master and the branch
  const diffResult = spawnSync(
    ["git", "diff", "master...HEAD", "--stat"],
    { cwd: PROJECT_DIR }
  );
  const diffStat = new TextDecoder().decode(diffResult.stdout).trim();

  const fullDiffResult = spawnSync(
    ["git", "diff", "master...HEAD"],
    { cwd: PROJECT_DIR }
  );
  const fullDiff = new TextDecoder().decode(fullDiffResult.stdout).trim();

  if (!fullDiff) {
    return {
      success: true,
      findings: [],
      summary: "Aucun changement a reviewer.",
      score: 100,
      passesGate: true,
      rawOutput: "",
    };
  }

  // Truncate diff if too large (keep most relevant parts)
  const maxDiffLength = 50000;
  const truncatedDiff = fullDiff.length > maxDiffLength
    ? fullDiff.substring(0, maxDiffLength) + "\n\n[... DIFF TRONQUE ...]"
    : fullDiff;

  if (onProgress) {
    await onProgress("Code review en cours (agent adversarial)...");
  }

  // Build review prompt using the dev agent in review mode
  const reviewPrompt = buildFullAgentPrompt("dev", {
    command: "review",
    taskTitle,
  });

  const prompt = [
    reviewPrompt,
    "",
    "---",
    "",
    "FICHIERS MODIFIES:",
    diffStat,
    "",
    "DIFF COMPLET:",
    "```diff",
    truncatedDiff,
    "```",
    "",
    "INSTRUCTIONS REVIEW ADVERSARIALE:",
    "Tu dois trouver MINIMUM 3 findings. Meme si le code est bon, il y a toujours des ameliorations possibles.",
    "",
    "Reponds UNIQUEMENT au format JSON:",
    '{',
    '  "findings": [',
    '    {',
    '      "severity": "critical|important|minor|suggestion",',
    '      "category": "security|performance|maintainability|testing|correctness|style",',
    '      "file": "path/to/file.ts",',
    '      "line": 42,',
    '      "description": "Ce que tu as trouve",',
    '      "suggestion": "Comment le corriger"',
    '    }',
    '  ],',
    '  "summary": "Resume en 2-3 phrases",',
    '  "score": 75',
    '}',
    "",
    "Score: 0-100 (100 = parfait, <50 = bloque le merge)",
    "JSON:",
  ].join("\n");

  try {
    const proc = spawn(
      [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"],
      { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR, env: { ...process.env } }
    );

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Parse JSON from output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        success: false,
        findings: [],
        summary: "Impossible de parser la review.",
        score: 0,
        passesGate: false,
        rawOutput: output,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const findings = (parsed.findings || []) as ReviewFinding[];
    const score = parsed.score || 0;

    return {
      success: true,
      findings,
      summary: parsed.summary || "",
      score,
      passesGate: score >= 50 && !findings.some((f) => f.severity === "critical"),
      rawOutput: output,
    };
  } catch (error) {
    return {
      success: false,
      findings: [],
      summary: `Erreur review: ${error}`,
      score: 0,
      passesGate: false,
      rawOutput: String(error),
    };
  }
}

/**
 * Save review results to Supabase for tracking.
 */
export async function saveReviewResult(
  supabase: SupabaseClient,
  taskId: string,
  branchName: string,
  result: CodeReviewResult
): Promise<void> {
  await supabase.from("workflow_logs").insert({
    task_id: taskId,
    step: "code_review",
    from_step: "execution",
    to_step: "review",
    metadata: {
      branch: branchName,
      score: result.score,
      findings_count: result.findings.length,
      critical_count: result.findings.filter((f) => f.severity === "critical").length,
      passes_gate: result.passesGate,
      summary: result.summary,
    },
  });
}

// ── Formatting ───────────────────────────────────────────────

const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  critical: "CRITIQUE",
  important: "IMPORTANT",
  minor: "MINEUR",
  suggestion: "SUGGESTION",
};

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  important: 1,
  minor: 2,
  suggestion: 3,
};

export function formatReviewResult(result: CodeReviewResult): string {
  const lines: string[] = [];

  // Header with score
  const scoreBar = "=".repeat(Math.round(result.score / 5)) + "-".repeat(20 - Math.round(result.score / 5));
  lines.push(`CODE REVIEW  [${scoreBar}] ${result.score}/100`);
  lines.push(result.passesGate ? "Gate: PASSE" : "Gate: BLOQUEE");
  lines.push("");

  if (result.summary) {
    lines.push(result.summary);
    lines.push("");
  }

  if (result.findings.length === 0) {
    lines.push("Aucun finding.");
    return lines.join("\n");
  }

  // Sort by severity
  const sorted = [...result.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );

  lines.push(`${result.findings.length} findings:`);
  lines.push("");

  for (const finding of sorted) {
    const severity = SEVERITY_LABELS[finding.severity];
    const location = finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file;
    lines.push(`[${severity}] ${finding.category} — ${location}`);
    lines.push(`  ${finding.description}`);
    lines.push(`  -> ${finding.suggestion}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}
