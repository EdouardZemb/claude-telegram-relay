/**
 * Unit Tests — S34 FR-002: Structured Rubric Scoring
 *
 * Tests rubric dimension parsing, scoring, and critical weakness detection.
 */

import { describe, expect, it } from "bun:test";
import {
  CODE_RUBRIC_DIMENSIONS,
  formatEvaluationFeedback,
  type GateEvaluation,
  parseEvaluationOutput,
  parseRubricFromOutput,
  SPEC_RUBRIC_DIMENSIONS,
} from "../../src/gate-evaluator";

// ── Rubric Dimensions ────────────────────────────────────────

describe("rubric dimension constants", () => {
  it("has 4 code dimensions (AC-006)", () => {
    expect(CODE_RUBRIC_DIMENSIONS).toHaveLength(4);
    expect(CODE_RUBRIC_DIMENSIONS).toContain("error_handling");
    expect(CODE_RUBRIC_DIMENSIONS).toContain("test_coverage");
    expect(CODE_RUBRIC_DIMENSIONS).toContain("code_style");
    expect(CODE_RUBRIC_DIMENSIONS).toContain("spec_conformity");
  });

  it("has 4 spec/plan dimensions (AC-010)", () => {
    expect(SPEC_RUBRIC_DIMENSIONS).toHaveLength(4);
    expect(SPEC_RUBRIC_DIMENSIONS).toContain("completeness");
    expect(SPEC_RUBRIC_DIMENSIONS).toContain("traceability");
    expect(SPEC_RUBRIC_DIMENSIONS).toContain("clarity");
    expect(SPEC_RUBRIC_DIMENSIONS).toContain("feasibility");
  });
});

// ── parseRubricFromOutput ────────────────────────────────────

describe("parseRubricFromOutput", () => {
  it("parses code rubric dimensions (AC-006)", () => {
    const obj = {
      rubric: {
        error_handling: { score: 20, feedback: "Good error handling" },
        test_coverage: { score: 22, feedback: "Comprehensive tests" },
        code_style: { score: 18, feedback: "Clean style" },
        spec_conformity: { score: 15, feedback: "Mostly aligned" },
      },
    };

    const rubric = parseRubricFromOutput(obj, "implementation");
    expect(rubric).toBeDefined();
    expect(rubric).toHaveLength(4);
    expect(rubric![0].name).toBe("error_handling");
    expect(rubric![0].score).toBe(20);
    expect(rubric![0].critical).toBe(false);
  });

  it("parses spec rubric dimensions (AC-010, EC-004)", () => {
    const obj = {
      rubric: {
        completeness: { score: 25, feedback: "All FRs covered" },
        traceability: { score: 20, feedback: "Good FR to AC mapping" },
        clarity: { score: 22, feedback: "Clear language" },
        feasibility: { score: 18, feedback: "Technically sound" },
      },
    };

    const rubric = parseRubricFromOutput(obj, "spec");
    expect(rubric).toBeDefined();
    expect(rubric).toHaveLength(4);
    expect(rubric![0].name).toBe("completeness");
  });

  it("flags critical weakness when dimension < 10 (AC-009)", () => {
    const obj = {
      rubric: {
        error_handling: { score: 5, feedback: "No error handling" },
        test_coverage: { score: 20, feedback: "Good" },
        code_style: { score: 18, feedback: "Fine" },
        spec_conformity: { score: 15, feedback: "OK" },
      },
    };

    const rubric = parseRubricFromOutput(obj, "implementation");
    expect(rubric).toBeDefined();
    const critical = rubric!.find((d) => d.name === "error_handling");
    expect(critical?.critical).toBe(true);
    expect(critical?.score).toBe(5);
  });

  it("returns undefined when no rubric in output", () => {
    const rubric = parseRubricFromOutput({}, "implementation");
    expect(rubric).toBeUndefined();
  });

  it("returns undefined when rubric is not an object", () => {
    const rubric = parseRubricFromOutput({ rubric: "not an object" }, "implementation");
    expect(rubric).toBeUndefined();
  });

  it("clamps dimension scores to 0-25", () => {
    const obj = {
      rubric: {
        error_handling: { score: 30, feedback: "Over" },
        test_coverage: { score: -5, feedback: "Under" },
        code_style: { score: 25, feedback: "Max" },
        spec_conformity: { score: 0, feedback: "Min" },
      },
    };

    const rubric = parseRubricFromOutput(obj, "implementation");
    expect(rubric![0].score).toBe(25); // clamped
    expect(rubric![1].score).toBe(0); // clamped
    expect(rubric![2].score).toBe(25);
    expect(rubric![3].score).toBe(0);
  });

  it("handles partial rubric (missing dimensions)", () => {
    const obj = {
      rubric: {
        error_handling: { score: 20, feedback: "Good" },
        // missing other dimensions
      },
    };

    const rubric = parseRubricFromOutput(obj, "implementation");
    expect(rubric).toBeDefined();
    expect(rubric).toHaveLength(1);
  });
});

// ── parseEvaluationOutput with rubric ────────────────────────

describe("parseEvaluationOutput with rubric", () => {
  it("computes total score from rubric dimensions (AC-007)", () => {
    const output = JSON.stringify({
      pass: true,
      rubric: {
        error_handling: { score: 20, feedback: "Good" },
        test_coverage: { score: 22, feedback: "Great" },
        code_style: { score: 18, feedback: "Clean" },
        spec_conformity: { score: 15, feedback: "Aligned" },
      },
      issues: [],
      gate_name: "implementation",
    });

    const result = parseEvaluationOutput(output, "implementation");
    expect(result.score).toBe(75); // 20+22+18+15
    expect(result.rubric).toHaveLength(4);
  });

  it("includes per-dimension detail in result (AC-008)", () => {
    const output = JSON.stringify({
      pass: true,
      rubric: {
        completeness: { score: 20, feedback: "Most FRs covered" },
        traceability: { score: 15, feedback: "Some gaps" },
        clarity: { score: 25, feedback: "Very clear" },
        feasibility: { score: 20, feedback: "Achievable" },
      },
      issues: [],
      gate_name: "spec",
    });

    const result = parseEvaluationOutput(output, "spec");
    expect(result.rubric).toBeDefined();
    expect(result.rubric!.find((d) => d.name === "clarity")?.feedback).toContain("Very clear");
  });

  it("adds critical weakness issue for low dimension (AC-009)", () => {
    const output = JSON.stringify({
      pass: false,
      rubric: {
        error_handling: { score: 5, feedback: "Missing" },
        test_coverage: { score: 20, feedback: "OK" },
        code_style: { score: 18, feedback: "Fine" },
        spec_conformity: { score: 15, feedback: "OK" },
      },
      issues: [],
      gate_name: "implementation",
    });

    const result = parseEvaluationOutput(output, "implementation");
    const criticalIssue = result.issues.find(
      (i) =>
        i.description.includes("Critical weakness") && i.description.includes("error_handling"),
    );
    expect(criticalIssue).toBeDefined();
    expect(criticalIssue?.severity).toBe("critical");
  });

  it("falls back to obj.score when rubric is incomplete", () => {
    const output = JSON.stringify({
      pass: true,
      score: 72,
      rubric: {
        error_handling: { score: 20, feedback: "Good" },
        // only 1 dimension, not 4
      },
      issues: [],
      gate_name: "implementation",
    });

    const result = parseEvaluationOutput(output, "implementation");
    // With only 1 dimension, rubric.length != 4, so falls back to obj.score
    expect(result.score).toBe(72);
  });

  it("backward compatible: works without rubric", () => {
    const output = JSON.stringify({
      pass: true,
      score: 85,
      issues: [{ severity: "minor", description: "Small issue", suggestion: "Fix" }],
      gate_name: "tasks",
    });

    const result = parseEvaluationOutput(output, "tasks");
    expect(result.pass).toBe(true);
    expect(result.score).toBe(85);
    expect(result.rubric).toBeUndefined();
    expect(result.issues).toHaveLength(1);
  });
});

// ── formatEvaluationFeedback with rubric ─────────────────────

describe("formatEvaluationFeedback with rubric", () => {
  it("includes rubric breakdown in feedback", () => {
    const evaluation: GateEvaluation = {
      pass: false,
      score: 58,
      issues: [
        { severity: "major", description: "Error handling gaps", suggestion: "Add try/catch" },
      ],
      gate_name: "implementation",
      rubric: [
        { name: "error_handling", score: 8, feedback: "Missing try/catch", critical: true },
        { name: "test_coverage", score: 20, feedback: "Good", critical: false },
        { name: "code_style", score: 15, feedback: "OK", critical: false },
        { name: "spec_conformity", score: 15, feedback: "OK", critical: false },
      ],
    };

    const feedback = formatEvaluationFeedback(evaluation);
    expect(feedback).toContain("Rubric breakdown:");
    expect(feedback).toContain("error_handling: 8/25 [CRITICAL]");
    expect(feedback).toContain("test_coverage: 20/25");
    expect(feedback).toContain("Missing try/catch");
  });

  it("includes deterministic check results when present", () => {
    const evaluation: GateEvaluation = {
      pass: true,
      score: 80,
      issues: [],
      gate_name: "implementation",
      deterministicChecks: [
        { check: "tsc", passed: true, output: "", durationMs: 1500 },
        { check: "bun_test", passed: true, output: "", durationMs: 3000 },
      ],
    };

    const feedback = formatEvaluationFeedback(evaluation);
    expect(feedback).toContain("Deterministic checks:");
    expect(feedback).toContain("tsc: PASS");
    expect(feedback).toContain("bun_test: PASS");
  });
});
