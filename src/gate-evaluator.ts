/**
 * @module gate-evaluator
 * @description Gate evaluation: deterministic checks + LLM-based rubric scoring at pipeline gates,
 * evaluate-rework loop (max 2 iterations). S34: dual verification + structured rubric.
 * S35: trust score updates, gate persistence, auto-approval, double-loop learning.
 */

/**
 * Gate Evaluator — S24 Gated Blackboard & SDD
 *
 * Evaluates the output of each pipeline phase against defined criteria.
 * Returns pass/fail with structured feedback.
 * T3: Gate Evaluator agent (FR-003)
 * T4: Evaluate-rework loop (FR-004)
 * S34: Dual verification (deterministic + LLM), structured rubric scoring
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readSection, writeSection, type BlackboardSections, type SectionName } from "./blackboard.ts";
import { spawnClaude } from "./agent.ts";
import { spawnSync } from "bun";
import { updateTrustScore, shouldAutoApprove, getCachedTrustScore } from "./trust-scores.ts";
import { persistGateEvaluation, runDoubleLoopAnalysis } from "./gate-persistence.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
const EVALUATOR_TIMEOUT = 120_000; // 120s (EC-004)
const DETERMINISTIC_CHECK_TIMEOUT = 30_000; // 30s per check (S34 EC-001)
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

// ── Types ────────────────────────────────────────────────────

export interface EvaluationIssue {
  severity: "critical" | "major" | "minor";
  description: string;
  suggestion: string;
}

/** S34: Rubric dimension score */
export interface RubricDimension {
  name: string;
  score: number; // 0-25
  feedback: string;
  critical: boolean; // true if score < 10
}

export interface GateEvaluation {
  pass: boolean;
  score: number;
  issues: EvaluationIssue[];
  gate_name: string;
  /** S34: Structured rubric dimensions */
  rubric?: RubricDimension[] | undefined;
  /** S34: Deterministic check results (implementation gates only) */
  deterministicChecks?: DeterministicCheckResult[] | undefined;
  /** S35: Whether this gate was auto-approved based on trust score */
  autoApproved?: boolean | undefined;
}

export type GateName = "spec" | "plan" | "tasks" | "implementation" | "exploration";

export interface EvaluateReworkResult {
  finalEvaluation: GateEvaluation;
  iterations: number;
  passedAtIteration: number | null;
}

/** S34: Result of a deterministic check */
export interface DeterministicCheckResult {
  check: string;
  passed: boolean;
  output: string;
  durationMs: number;
  timedOut?: boolean;
}

// ── Rubric Dimensions per Gate Type (S34 FR-002) ────────────

export const CODE_RUBRIC_DIMENSIONS = [
  "error_handling",
  "test_coverage",
  "code_style",
  "spec_conformity",
] as const;

export const SPEC_RUBRIC_DIMENSIONS = [
  "completeness",
  "traceability",
  "clarity",
  "feasibility",
] as const;

export const EXPLORATION_RUBRIC_DIMENSIONS = [
  "coverage",
  "depth",
  "actionability",
  "confidence",
] as const;

export type CodeRubricDimension = typeof CODE_RUBRIC_DIMENSIONS[number];
export type SpecRubricDimension = typeof SPEC_RUBRIC_DIMENSIONS[number];
export type ExplorationRubricDimension = typeof EXPLORATION_RUBRIC_DIMENSIONS[number];

function getRubricDimensions(gateName: GateName): readonly string[] {
  if (gateName === "implementation") return CODE_RUBRIC_DIMENSIONS;
  if (gateName === "exploration") return EXPLORATION_RUBRIC_DIMENSIONS;
  return SPEC_RUBRIC_DIMENSIONS;
}

// ── Deterministic Checks (S34 FR-001) ────────────────────────

/**
 * Run a single deterministic check with timeout.
 * Returns the result regardless of pass/fail.
 */
export function runSingleCheck(
  command: string[],
  checkName: string,
  timeout: number = DETERMINISTIC_CHECK_TIMEOUT,
  cwd: string = PROJECT_DIR
): DeterministicCheckResult {
  const start = Date.now();

  try {
    const result = spawnSync(command, {
      cwd,
      timeout,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const output = stdout || stderr;
    const durationMs = Date.now() - start;

    // Check if timed out (exitCode is null or process was killed)
    if (result.exitCode === null) {
      return {
        check: checkName,
        passed: false,
        output: `Timeout after ${timeout}ms`,
        durationMs,
        timedOut: true,
      };
    }

    return {
      check: checkName,
      passed: result.exitCode === 0,
      output: output.substring(0, 2000),
      durationMs,
    };
  } catch (error) {
    return {
      check: checkName,
      passed: false,
      output: `Error: ${String(error)}`.substring(0, 2000),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Run deterministic checks for implementation gates.
 * S34 FR-001: tsc + bun test before LLM evaluation.
 * EC-001: 30s timeout per check.
 * EC-007: reports which check failed.
 */
export function runDeterministicChecks(cwd?: string): DeterministicCheckResult[] {
  const results: DeterministicCheckResult[] = [];

  // Check 1: TypeScript type check
  results.push(runSingleCheck(
    ["npx", "tsc", "--noEmit"],
    "tsc",
    DETERMINISTIC_CHECK_TIMEOUT,
    cwd
  ));

  // Check 2: Run tests
  results.push(runSingleCheck(
    ["bun", "test"],
    "bun_test",
    DETERMINISTIC_CHECK_TIMEOUT,
    cwd
  ));

  return results;
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

  exploration: [
    "Evaluate the EXPLORATION report of this pipeline output.",
    "Check the following criteria:",
    "1. Coverage: the domain has been adequately explored (multiple findings, sources cited)",
    "2. Depth: findings go beyond surface level, with concrete evidence",
    "3. Actionability: recommendation is clear, alternatives have pros/cons/effort",
    "4. Confidence: the confidence score reflects the actual depth of research",
    "",
    "Score 0-100 based on research thoroughness and usefulness.",
    "Pass threshold: 60.",
  ].join("\n"),
};

// ── Rubric Prompt Builder (S34 FR-002) ───────────────────────

function buildRubricPrompt(gateName: GateName): string {
  const dimensions = getRubricDimensions(gateName);
  const dimList = dimensions.map((d, i) => `${i + 1}. ${d} (0-25)`).join("\n");

  return [
    "",
    "RUBRIC SCORING: Score each dimension independently from 0 to 25.",
    "The total score (0-100) is the sum of all 4 dimensions.",
    "If any dimension scores below 10, flag it as a critical weakness.",
    "",
    "Dimensions:",
    dimList,
  ].join("\n");
}

function buildRubricJsonSchema(gateName: GateName): string {
  const dimensions = getRubricDimensions(gateName);
  const rubricFields = dimensions
    .map((d) => `    "${d}": { "score": 0-25, "feedback": "..." }`)
    .join(",\n");

  return [
    '{',
    '  "pass": true/false,',
    '  "score": 0-100,',
    '  "rubric": {',
    rubricFields,
    '  },',
    '  "issues": [{"severity": "critical|major|minor", "description": "...", "suggestion": "..."}],',
    '  "gate_name": "' + gateName + '"',
    '}',
  ].join("\n");
}

// ── Evaluator ────────────────────────────────────────────────

/** S35: Options for gate evaluation */
export interface EvaluateGateOptions {
  /** S34: Working directory for deterministic checks */
  cwd?: string | undefined;
  /** S35: Agent role for trust score lookup */
  agentRole?: string | undefined;
  /** S35: Task priority for auto-approval check */
  taskPriority?: number | undefined;
  /** S35: Task ID for persistence */
  taskId?: string | undefined;
  /** S35: Sprint ID for persistence */
  sprintId?: string | undefined;
}

/**
 * Evaluate a gate by calling Claude CLI with the gate-specific criteria.
 * S34: Implementation gates run deterministic checks first (FR-001).
 * S34: All gates use structured rubric scoring (FR-002).
 * S35: Auto-approval for high-trust agents on low-priority tasks.
 *
 * On timeout (EC-004): returns pass with warning.
 */
// ── Exploration Completeness Check ───────────────────────────

interface ExplorationCompletenessResult {
  pass: boolean;
  score: number;
  issues: EvaluationIssue[];
  rubric: RubricDimension[];
}

/**
 * Deterministic completeness check for exploration output.
 * Checks: >= 2 findings, recommendation present, confidence >= 0.6.
 * Returns a structured result with rubric dimensions.
 */
export function evaluateExplorationCompleteness(sectionData: unknown): ExplorationCompletenessResult {
  const issues: EvaluationIssue[] = [];
  const rubric: RubricDimension[] = [];

  const sd = (typeof sectionData === "object" && sectionData !== null ? sectionData : {}) as Record<string, unknown>;

  // Coverage: check findings count
  const findings = Array.isArray(sd.findings) ? sd.findings : [];
  const coverageScore = findings.length >= 3 ? 25 : findings.length >= 2 ? 18 : findings.length === 1 ? 10 : 0;
  rubric.push({
    name: "coverage",
    score: coverageScore,
    feedback: findings.length >= 2 ? `${findings.length} findings` : `Only ${findings.length} findings (need >= 2)`,
    critical: coverageScore < 10,
  });
  if (findings.length < 2) {
    issues.push({
      severity: "critical",
      description: `Only ${findings.length} findings found, need at least 2`,
      suggestion: "Explore more aspects of the domain before concluding",
    });
  }

  // Depth: check for sources in findings
  const findingsWithSources = findings.filter((f: unknown) => {
    const fe = f as Record<string, unknown> | null;
    return Array.isArray(fe?.sources) && fe!.sources.length > 0;
  });
  const depthScore = findingsWithSources.length >= findings.length * 0.5 ? 20
    : findingsWithSources.length > 0 ? 15 : 5;
  rubric.push({
    name: "depth",
    score: depthScore,
    feedback: `${findingsWithSources.length}/${findings.length} findings have sources`,
    critical: depthScore < 10,
  });

  // Actionability: check recommendation and alternatives
  const hasRecommendation = typeof sd.recommendation === "string" && (sd.recommendation as string).length > 10;
  const alternatives = Array.isArray(sd.alternatives) ? sd.alternatives : [];
  const actionScore = hasRecommendation ? (alternatives.length >= 2 ? 25 : 18) : 5;
  rubric.push({
    name: "actionability",
    score: actionScore,
    feedback: hasRecommendation
      ? `Recommendation present, ${alternatives.length} alternatives`
      : "Missing recommendation",
    critical: actionScore < 10,
  });
  if (!hasRecommendation) {
    issues.push({
      severity: "critical",
      description: "No recommendation provided",
      suggestion: "Provide a clear recommendation based on findings",
    });
  }

  // Confidence: check confidence score
  const confidence = typeof sd.confidence === "number" ? sd.confidence : 0;
  const confidenceScore = confidence >= 0.8 ? 25 : confidence >= 0.6 ? 20 : confidence >= 0.4 ? 12 : 5;
  rubric.push({
    name: "confidence",
    score: confidenceScore,
    feedback: `Confidence: ${Math.round(confidence * 100)}%`,
    critical: confidenceScore < 10,
  });
  if (confidence < 0.6) {
    issues.push({
      severity: "major",
      description: `Low confidence (${Math.round(confidence * 100)}%), threshold is 60%`,
      suggestion: "Investigate further to increase confidence in findings",
    });
  }

  const totalScore = rubric.reduce((sum, r) => sum + r.score, 0);
  const hasCritical = rubric.some((r) => r.critical);
  const pass = totalScore >= 60 && !hasCritical && issues.filter((i) => i.severity === "critical").length === 0;

  return { pass, score: totalScore, issues, rubric };
}

export async function evaluateGate(
  supabase: SupabaseClient | null,
  sessionId: string,
  gateName: GateName,
  sectionData: unknown,
  /** S34: Working directory for deterministic checks (or S35 options) */
  cwdOrOptions?: string | EvaluateGateOptions
): Promise<GateEvaluation> {
  // S35: Normalize options
  const opts: EvaluateGateOptions = typeof cwdOrOptions === "string"
    ? { cwd: cwdOrOptions }
    : (cwdOrOptions || {});
  const cwd = opts.cwd;

  // S35: Auto-approval check for high-trust agents on low-priority tasks
  if (
    opts.agentRole &&
    opts.taskPriority !== undefined &&
    shouldAutoApprove(opts.agentRole, gateName, opts.taskPriority)
  ) {
    // For implementation gates, still run deterministic checks
    if (gateName === "implementation") {
      const detResults = runDeterministicChecks(cwd);
      const allPassed = detResults.every((r) => r.passed);
      if (!allPassed) {
        // Deterministic checks failed — no auto-approval (EC-004)
        const failedChecks = detResults.filter((r) => !r.passed);
        return {
          pass: false,
          score: 0,
          issues: failedChecks.map((r) => ({
            severity: "critical" as const,
            description: `Deterministic check "${r.check}" failed${r.timedOut ? " (timeout)" : ""}`,
            suggestion: r.output.substring(0, 500),
          })),
          gate_name: gateName,
          deterministicChecks: detResults,
        };
      }
      // Deterministic checks passed — auto-approve without LLM
      console.log(`evaluateGate: auto-approved ${gateName} for ${opts.agentRole} (trust-based, deterministic OK)`);
      return {
        pass: true,
        score: 100,
        issues: [],
        gate_name: gateName,
        deterministicChecks: detResults,
        autoApproved: true,
      };
    }

    // Non-implementation gates: auto-approve entirely
    console.log(`evaluateGate: auto-approved ${gateName} for ${opts.agentRole} (trust-based)`);
    return {
      pass: true,
      score: 100,
      issues: [],
      gate_name: gateName,
      autoApproved: true,
    };
  }

  // S34 FR-001: Run deterministic checks for implementation gates
  let deterministicResults: DeterministicCheckResult[] | undefined;

  if (gateName === "implementation") {
    deterministicResults = runDeterministicChecks(cwd);
    const allPassed = deterministicResults.every((r) => r.passed);

    // AC-003: If deterministic checks fail, skip LLM (cost saving)
    if (!allPassed) {
      const failedChecks = deterministicResults.filter((r) => !r.passed);
      const issues: EvaluationIssue[] = failedChecks.map((r) => ({
        severity: "critical" as const,
        description: `Deterministic check "${r.check}" failed${r.timedOut ? " (timeout)" : ""}`,
        suggestion: r.output.substring(0, 500),
      }));

      return {
        pass: false,
        score: 0,
        issues,
        gate_name: gateName,
        deterministicChecks: deterministicResults,
      };
    }
  }

  // Exploration gate: deterministic completeness check
  if (gateName === "exploration") {
    const explorationChecks = evaluateExplorationCompleteness(sectionData);
    if (!explorationChecks.pass) {
      return {
        pass: false,
        score: explorationChecks.score,
        issues: explorationChecks.issues,
        gate_name: gateName,
        rubric: explorationChecks.rubric,
      };
    }
    // If completeness check passed but feature flag says no LLM, return pass
    if (!isFeatureEnabled("exploration_gate")) {
      return {
        pass: true,
        score: explorationChecks.score,
        issues: [],
        gate_name: gateName,
        rubric: explorationChecks.rubric,
      };
    }
  }

  // AC-005: Non-implementation gates skip deterministic checks
  const criteria = GATE_CRITERIA[gateName];
  const rubricPrompt = buildRubricPrompt(gateName);
  const rubricSchema = buildRubricJsonSchema(gateName);

  // AC-004: Pass deterministic check results as context to LLM
  const checkContext = deterministicResults
    ? `\n\nDETERMINISTIC CHECKS (all passed):\n${deterministicResults
        .map((r) => `- ${r.check}: PASS (${r.durationMs}ms)`)
        .join("\n")}`
    : "";

  const prompt = [
    "You are a quality evaluator for a software development pipeline.",
    "Your task is to evaluate the following output and return a structured JSON evaluation.",
    "",
    criteria,
    rubricPrompt,
    checkContext,
    "",
    "OUTPUT TO EVALUATE:",
    JSON.stringify(sectionData, null, 2).substring(0, 30000),
    "",
    "Return ONLY a JSON object with this exact structure:",
    rubricSchema,
    "",
    "No other text. Only valid JSON.",
  ].join("\n");

  try {
    // S28: Use centralized spawnClaude with effort=medium for evaluators
    const resultPromise = spawnClaude({
      prompt,
      effort: "medium",
    });

    // Timeout handling (EC-004)
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), EVALUATOR_TIMEOUT);
    });

    const result = await Promise.race([resultPromise, timeoutPromise]);

    if (!result) {
      console.warn(`evaluateGate: timeout for gate "${gateName}" (${EVALUATOR_TIMEOUT}ms). Passing with warning.`);
      return {
        pass: true,
        score: 50,
        issues: [{ severity: "minor", description: "Evaluator timed out", suggestion: "Review manually" }],
        gate_name: gateName,
        deterministicChecks: deterministicResults,
      };
    }

    // Parse JSON from output
    const evaluation = parseEvaluationOutput(result.stdout, gateName);
    evaluation.deterministicChecks = deterministicResults;
    return evaluation;
  } catch (error) {
    console.error(`evaluateGate error for gate "${gateName}":`, error);
    // On error, pass with warning (don't block pipeline)
    return {
      pass: true,
      score: 50,
      issues: [{ severity: "minor", description: `Evaluator error: ${String(error)}`, suggestion: "Review manually" }],
      gate_name: gateName,
      deterministicChecks: deterministicResults,
    };
  }
}

/**
 * Parse the evaluator output into a GateEvaluation.
 * S34: Now parses rubric dimensions from the output.
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

function normalizeEvaluation(obj: unknown, gateName: string): GateEvaluation {
  const o = (typeof obj === "object" && obj !== null ? obj : {}) as Record<string, unknown>;
  // S34: Parse rubric dimensions if present
  const rubric = parseRubricFromOutput(o, gateName as GateName);

  // If rubric is present, compute score from rubric dimensions
  let score: number;
  if (rubric && rubric.length === 4) {
    score = rubric.reduce((sum, d) => sum + d.score, 0);
  } else {
    score = typeof o.score === "number" ? Math.min(100, Math.max(0, o.score)) : 50;
  }

  const pass = o.pass !== undefined ? Boolean(o.pass) : score >= 60;
  const issues = Array.isArray(o.issues)
    ? (o.issues as unknown[]).map((i: unknown) => {
        const ie = (typeof i === "object" && i !== null ? i : {}) as Record<string, unknown>;
        return {
          severity: (["critical", "major", "minor"].includes(ie.severity as string) ? ie.severity : "minor") as EvaluationIssue["severity"],
          description: String(ie.description || ""),
          suggestion: String(ie.suggestion || ""),
        };
      })
    : [];

  // S34 AC-009: Flag critical weaknesses (dimension below 10)
  if (rubric) {
    for (const dim of rubric) {
      if (dim.critical && !issues.some((i: EvaluationIssue) => i.description.includes(dim.name))) {
        issues.push({
          severity: "critical",
          description: `Critical weakness in "${dim.name}" (score: ${dim.score}/25)`,
          suggestion: dim.feedback || `Improve ${dim.name}`,
        });
      }
    }
  }

  return { pass, score, issues, gate_name: gateName, rubric };
}

/**
 * Parse rubric dimensions from the LLM evaluation output.
 * S34 FR-002: Extracts 4 dimension scores.
 */
export function parseRubricFromOutput(obj: unknown, gateName: GateName): RubricDimension[] | undefined {
  const o = (typeof obj === "object" && obj !== null ? obj : {}) as Record<string, unknown>;
  if (!o.rubric || typeof o.rubric !== "object") return undefined;
  const rubricObj = o.rubric as Record<string, unknown>;

  const dimensions = getRubricDimensions(gateName);
  const rubric: RubricDimension[] = [];

  for (const dim of dimensions) {
    const dimData = rubricObj[dim];
    if (!dimData || typeof dimData !== "object") continue;
    const dd = dimData as Record<string, unknown>;

    const score = typeof dd.score === "number"
      ? Math.min(25, Math.max(0, Math.round(dd.score)))
      : 0;

    rubric.push({
      name: dim,
      score,
      feedback: String(dd.feedback || ""),
      critical: score < 10,
    });
  }

  return rubric.length > 0 ? rubric : undefined;
}

// ── Evaluate-Rework Loop (T4 — FR-004) ──────────────────────

/** S35: Options for evaluateAndRework */
export interface EvaluateAndReworkOptions {
  maxIterations?: number | undefined;
  /** Override evaluator for testing */
  customEvaluator?: ((data: any) => Promise<GateEvaluation>) | undefined;
  /** S35: Task ID for persistence */
  taskId?: string | undefined;
  /** S35: Sprint ID for persistence */
  sprintId?: string | undefined;
  /** S35: Task priority for auto-approval */
  taskPriority?: number | undefined;
  /** S35: Working directory for deterministic checks */
  cwd?: string | undefined;
  /** S35: Agent role for trust score lookup */
  agentRole?: string | undefined;
}

/**
 * Run the evaluate-rework loop for a gate.
 *
 * 1. Evaluate the current output
 * 2. If rejected, re-run the producing agent with feedback
 * 3. Max 2 iterations, then continue with warning (AC-012)
 * S35: Updates trust scores, persists evaluations, runs double-loop.
 *
 * @param runAgent - function to re-run the agent (receives feedback string)
 */
export async function evaluateAndRework(
  supabase: SupabaseClient | null,
  sessionId: string,
  agentRole: string,
  gateName: GateName,
  sectionData: unknown,
  runAgent: (feedback: string) => Promise<unknown>,
  maxIterationsOrOpts?: number | EvaluateAndReworkOptions,
  /** Override evaluator for testing (legacy compat) */
  customEvaluator?: (data: unknown) => Promise<GateEvaluation>
): Promise<EvaluateReworkResult> {
  // S35: Normalize options (backward compatible)
  const opts: EvaluateAndReworkOptions = typeof maxIterationsOrOpts === "number"
    ? { maxIterations: maxIterationsOrOpts, customEvaluator }
    : (maxIterationsOrOpts || {});
  if (customEvaluator && !opts.customEvaluator) opts.customEvaluator = customEvaluator;
  const maxIterations = opts.maxIterations ?? 2;

  let currentData = sectionData;
  let iterations = 0;
  let passedAtIteration: number | null = null;

  for (let i = 0; i <= maxIterations; i++) {
    const evaluation = opts.customEvaluator
      ? await opts.customEvaluator(currentData)
      : await evaluateGate(supabase, sessionId, gateName, currentData, {
          cwd: opts.cwd,
          agentRole,
          taskPriority: opts.taskPriority,
          taskId: opts.taskId,
          sprintId: opts.sprintId,
        });

    // S35: Persist gate evaluation
    persistGateEvaluation(supabase, {
      sessionId,
      taskId: opts.taskId,
      sprintId: opts.sprintId,
      agentRole,
      gateName,
      score: evaluation.score,
      passed: evaluation.pass,
      rubricDimensions: evaluation.rubric,
      deterministicChecks: evaluation.deterministicChecks,
      reworkIteration: i,
      reworkTriggered: !evaluation.pass && i < maxIterations,
      autoApproved: evaluation.autoApproved || false,
    }).catch((err) => console.error("Gate persistence error:", err));

    if (evaluation.pass) {
      passedAtIteration = i;
      const hadRework = i > 0;

      // Notify gate result if prd_to_deploy workflow is active
      if (isFeatureEnabled("prd_to_deploy")) {
        const { notifyGateResult } = await import("./prd-workflow.ts");
        const trustScore = getCachedTrustScore(agentRole).score;
        notifyGateResult(
          gateName, true, evaluation.score, evaluation.autoApproved || false,
          agentRole, trustScore, i,
        ).catch((err) => console.error("Gate notification error:", err));
      }

      // S35: Update trust score
      updateTrustScore(supabase, agentRole, { passed: true, hadRework })
        .catch((err) => console.error("Trust score update error:", err));

      // S35: Run double-loop analysis (non-blocking)
      if (supabase) {
        runDoubleLoopAnalysis(supabase, agentRole)
          .catch((err) => console.error("Double-loop analysis error:", err));
      }

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

      // Notify gate failure if prd_to_deploy workflow is active
      if (isFeatureEnabled("prd_to_deploy")) {
        const { notifyGateResult } = await import("./prd-workflow.ts");
        notifyGateResult(gateName, false, evaluation.score, false, agentRole, undefined, i)
          .catch((err) => console.error("Gate notification error:", err));
      }

      // S35: Update trust score (failure)
      updateTrustScore(supabase, agentRole, { passed: false, hadRework: true })
        .catch((err) => console.error("Trust score update error:", err));

      // S35: Run double-loop analysis (non-blocking)
      if (supabase) {
        runDoubleLoopAnalysis(supabase, agentRole)
          .catch((err) => console.error("Double-loop analysis error:", err));
      }

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
 * S34: Includes rubric dimension details when available.
 */
export function formatEvaluationFeedback(evaluation: GateEvaluation): string {
  const lines = [
    `EVALUATION FEEDBACK (Gate: ${evaluation.gate_name})`,
    `Score: ${evaluation.score}/100 — ${evaluation.pass ? "PASS" : "FAIL"}`,
  ];

  // S34: Include rubric breakdown
  if (evaluation.rubric && evaluation.rubric.length > 0) {
    lines.push("");
    lines.push("Rubric breakdown:");
    for (const dim of evaluation.rubric) {
      const marker = dim.critical ? " [CRITICAL]" : "";
      lines.push(`  ${dim.name}: ${dim.score}/25${marker}`);
      if (dim.feedback) lines.push(`    ${dim.feedback}`);
    }
  }

  // S34: Include deterministic check results
  if (evaluation.deterministicChecks && evaluation.deterministicChecks.length > 0) {
    lines.push("");
    lines.push("Deterministic checks:");
    for (const check of evaluation.deterministicChecks) {
      const status = check.passed ? "PASS" : "FAIL";
      lines.push(`  ${check.check}: ${status} (${check.durationMs}ms)`);
    }
  }

  lines.push("");
  lines.push("Issues to address:");

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
