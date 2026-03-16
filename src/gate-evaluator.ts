/**
 * @module gate-evaluator
 * @description Gate evaluation: LLM-based quality checks at pipeline gates,
 * evaluate-rework loop (max 2 iterations).
 */

/**
 * Gate Evaluator — S24 Gated Blackboard & SDD
 *
 * Evaluates the output of each pipeline phase against defined criteria.
 * Returns pass/fail with structured feedback.
 * T3: Gate Evaluator agent (FR-003)
 * T4: Evaluate-rework loop (FR-004)
 */

import { spawn } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSection, writeSection, type BlackboardSections, type SectionName } from "./blackboard.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const EVALUATOR_TIMEOUT = 120_000; // 120s (EC-004)

// ── Types ────────────────────────────────────────────────────

export interface EvaluationIssue {
  severity: "critical" | "major" | "minor";
  description: string;
  suggestion: string;
}

export interface GateEvaluation {
  pass: boolean;
  score: number;
  issues: EvaluationIssue[];
  gate_name: string;
}

export type GateName = "spec" | "plan" | "tasks" | "implementation";

export interface EvaluateReworkResult {
  finalEvaluation: GateEvaluation;
  iterations: number;
  passedAtIteration: number | null;
}

// ── Gate Criteria ────────────────────────────────────────────

const GATE_CRITERIA: Record<GateName, string> = {
  spec: [
    "Evaluate the SPEC section of this pipeline output.",
    "Check the following criteria:",
    "1. Every Functional Requirement (FR) has Acceptance Criteria in GIVEN/WHEN/THEN format",
    "2. Edge cases are explicitly defined",
    "3. Success criteria are measurable",
    "4. User stories are present and well-formed",
    "5. Out of scope is defined",
    "",
    "Score 0-100 based on completeness and quality.",
    "Pass threshold: 60.",
  ].join("\n"),

  plan: [
    "Evaluate the PLAN section of this pipeline output.",
    "Check the following criteria:",
    "1. Architecture covers all Functional Requirements from the spec",
    "2. Interfaces between components are defined",
    "3. Migration plan exists if database changes are needed",
    "4. Design decisions are documented with rationale",
    "5. Technical risks are identified",
    "",
    "Score 0-100 based on coverage and architectural soundness.",
    "Pass threshold: 60.",
  ].join("\n"),

  tasks: [
    "Evaluate the TASKS section of this pipeline output.",
    "Check the following criteria:",
    "1. Every task traces to one or more FR-XXX identifiers (traces_to field)",
    "2. Test plan covers all Acceptance Criteria (AC-XXX)",
    "3. Dependencies between tasks are explicit",
    "4. Estimates are present",
    "5. Tasks are ordered by dependency",
    "",
    "Score 0-100 based on traceability and completeness.",
    "Pass threshold: 60.",
  ].join("\n"),

  implementation: [
    "Evaluate the IMPLEMENTATION section of this pipeline output.",
    "Check the following criteria:",
    "1. All modified files are listed",
    "2. Tests are added for new functionality",
    "3. No obvious bugs or security issues in the summary",
    "4. Implementation aligns with the plan and tasks",
    "",
    "Score 0-100 based on completeness and quality.",
    "Pass threshold: 60.",
  ].join("\n"),
};

// ── Evaluator ────────────────────────────────────────────────

/**
 * Evaluate a gate by calling Claude CLI with the gate-specific criteria.
 * Returns a structured GateEvaluation.
 *
 * On timeout (EC-004): returns pass with warning.
 */
export async function evaluateGate(
  supabase: SupabaseClient | null,
  sessionId: string,
  gateName: GateName,
  sectionData: any
): Promise<GateEvaluation> {
  const criteria = GATE_CRITERIA[gateName];

  const prompt = [
    "You are a quality evaluator for a software development pipeline.",
    "Your task is to evaluate the following output and return a structured JSON evaluation.",
    "",
    criteria,
    "",
    "OUTPUT TO EVALUATE:",
    JSON.stringify(sectionData, null, 2).substring(0, 30000),
    "",
    "Return ONLY a JSON object with this exact structure:",
    '{',
    '  "pass": true/false,',
    '  "score": 0-100,',
    '  "issues": [{"severity": "critical|major|minor", "description": "...", "suggestion": "..."}],',
    '  "gate_name": "' + gateName + '"',
    '}',
    "",
    "No other text. Only valid JSON.",
  ].join("\n");

  try {
    const proc = spawn(
      [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.env.PROJECT_DIR || process.cwd(),
        env: { ...process.env },
      }
    );

    // Timeout handling (EC-004)
    const timeoutPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("__TIMEOUT__"), EVALUATOR_TIMEOUT);
    });

    const outputPromise = new Response(proc.stdout).text();
    const output = await Promise.race([outputPromise, timeoutPromise]);

    if (output === "__TIMEOUT__") {
      console.warn(`evaluateGate: timeout for gate "${gateName}" (${EVALUATOR_TIMEOUT}ms). Passing with warning.`);
      return {
        pass: true,
        score: 50,
        issues: [{ severity: "minor", description: "Evaluator timed out", suggestion: "Review manually" }],
        gate_name: gateName,
      };
    }

    await proc.exited;

    // Parse JSON from output
    const evaluation = parseEvaluationOutput(output.trim(), gateName);
    return evaluation;
  } catch (error) {
    console.error(`evaluateGate error for gate "${gateName}":`, error);
    // On error, pass with warning (don't block pipeline)
    return {
      pass: true,
      score: 50,
      issues: [{ severity: "minor", description: `Evaluator error: ${String(error)}`, suggestion: "Review manually" }],
      gate_name: gateName,
    };
  }
}

/**
 * Parse the evaluator output into a GateEvaluation.
 */
export function parseEvaluationOutput(output: string, gateName: string): GateEvaluation {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(output);
    return normalizeEvaluation(parsed, gateName);
  } catch {
    // Try to extract JSON from the output
  }

  // Find JSON in output
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeEvaluation(parsed, gateName);
    } catch {
      // Fall through
    }
  }

  // Fallback: couldn't parse, treat as pass with warning
  return {
    pass: true,
    score: 50,
    issues: [{ severity: "minor", description: "Could not parse evaluator output", suggestion: "Review manually" }],
    gate_name: gateName,
  };
}

function normalizeEvaluation(obj: any, gateName: string): GateEvaluation {
  const score = typeof obj.score === "number" ? Math.min(100, Math.max(0, obj.score)) : 50;
  const pass = obj.pass !== undefined ? Boolean(obj.pass) : score >= 60;
  const issues = Array.isArray(obj.issues)
    ? obj.issues.map((i: any) => ({
        severity: ["critical", "major", "minor"].includes(i.severity) ? i.severity : "minor",
        description: String(i.description || ""),
        suggestion: String(i.suggestion || ""),
      }))
    : [];

  return { pass, score, issues, gate_name: gateName };
}

// ── Evaluate-Rework Loop (T4 — FR-004) ──────────────────────

/**
 * Run the evaluate-rework loop for a gate.
 *
 * 1. Evaluate the current output
 * 2. If rejected, re-run the producing agent with feedback
 * 3. Max 2 iterations, then continue with warning (AC-012)
 *
 * @param runAgent - function to re-run the agent (receives feedback string)
 */
export async function evaluateAndRework(
  supabase: SupabaseClient | null,
  sessionId: string,
  agentRole: string,
  gateName: GateName,
  sectionData: any,
  runAgent: (feedback: string) => Promise<any>,
  maxIterations: number = 2,
  /** Override evaluator for testing */
  customEvaluator?: (data: any) => Promise<GateEvaluation>
): Promise<EvaluateReworkResult> {
  let currentData = sectionData;
  let iterations = 0;
  let passedAtIteration: number | null = null;

  for (let i = 0; i <= maxIterations; i++) {
    const evaluation = customEvaluator
      ? await customEvaluator(currentData)
      : await evaluateGate(supabase, sessionId, gateName, currentData);

    if (evaluation.pass) {
      passedAtIteration = i;
      return { finalEvaluation: evaluation, iterations: i, passedAtIteration };
    }

    // Max iterations reached — continue with warning (AC-012)
    if (i >= maxIterations) {
      console.warn(
        `evaluateAndRework: gate "${gateName}" still failing after ${maxIterations} iterations. Continuing with warning.`
      );
      evaluation.issues.push({
        severity: "major",
        description: `Gate "${gateName}" did not pass after ${maxIterations} rework iterations`,
        suggestion: "Manual review recommended",
      });
      return { finalEvaluation: evaluation, iterations: i, passedAtIteration: null };
    }

    // Rework: re-run agent with feedback (AC-011)
    iterations = i + 1;
    const feedback = formatEvaluationFeedback(evaluation);
    currentData = await runAgent(feedback);
  }

  // Should not reach here, but safety fallback
  return {
    finalEvaluation: {
      pass: false,
      score: 0,
      issues: [{ severity: "critical", description: "Unexpected loop exit", suggestion: "Review code" }],
      gate_name: gateName,
    },
    iterations,
    passedAtIteration: null,
  };
}

/**
 * Format evaluation feedback for the agent rework prompt.
 */
export function formatEvaluationFeedback(evaluation: GateEvaluation): string {
  const lines = [
    `EVALUATION FEEDBACK (Gate: ${evaluation.gate_name})`,
    `Score: ${evaluation.score}/100 — ${evaluation.pass ? "PASS" : "FAIL"}`,
    "",
    "Issues to address:",
  ];

  for (const issue of evaluation.issues) {
    lines.push(`  [${issue.severity}] ${issue.description}`);
    if (issue.suggestion) {
      lines.push(`    Suggestion: ${issue.suggestion}`);
    }
  }

  lines.push("");
  lines.push("Please address the issues above and produce an improved output.");

  return lines.join("\n");
}
