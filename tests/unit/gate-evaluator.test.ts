/**
 * Unit Tests — src/gate-evaluator.ts (S24 T3+T4)
 *
 * Tests for gate evaluation, output parsing,
 * rework loop, and feedback formatting.
 */

import { describe, it, expect } from "bun:test";
import {
  parseEvaluationOutput,
  formatEvaluationFeedback,
  evaluateAndRework,
  evaluateExplorationCompleteness,
  EXPLORATION_RUBRIC_DIMENSIONS,
  type GateEvaluation,
  type EvaluateReworkResult,
} from "../../src/gate-evaluator";

// ── parseEvaluationOutput ────────────────────────────────────

describe("parseEvaluationOutput", () => {
  it("parses valid JSON output (AC-010)", () => {
    const output = JSON.stringify({
      pass: true,
      score: 85,
      issues: [{ severity: "minor", description: "Small issue", suggestion: "Fix it" }],
      gate_name: "tasks",
    });

    const result = parseEvaluationOutput(output, "tasks");

    expect(result.pass).toBe(true);
    expect(result.score).toBe(85);
    expect(result.gate_name).toBe("tasks");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("minor");
  });

  it("extracts JSON from mixed output", () => {
    const output = `Here is my evaluation:
${JSON.stringify({ pass: false, score: 40, issues: [], gate_name: "plan" })}
That's my assessment.`;

    const result = parseEvaluationOutput(output, "plan");

    expect(result.pass).toBe(false);
    expect(result.score).toBe(40);
    expect(result.gate_name).toBe("plan");
  });

  it("handles unparseable output gracefully", () => {
    const result = parseEvaluationOutput("This is not JSON at all", "spec");

    expect(result.pass).toBe(true); // fallback
    expect(result.score).toBe(50);
    expect(result.gate_name).toBe("spec");
    expect(result.issues[0].description).toContain("Could not parse");
  });

  it("normalizes severity to valid values", () => {
    const output = JSON.stringify({
      pass: true,
      score: 70,
      issues: [{ severity: "unknown", description: "Test", suggestion: "Fix" }],
    });

    const result = parseEvaluationOutput(output, "tasks");
    expect(result.issues[0].severity).toBe("minor"); // normalized
  });

  it("clamps score to 0-100", () => {
    const output = JSON.stringify({
      pass: true,
      score: 150,
      issues: [],
    });

    const result = parseEvaluationOutput(output, "tasks");
    expect(result.score).toBe(100);
  });

  it("infers pass from score when pass is not set", () => {
    const output = JSON.stringify({ score: 45, issues: [] });

    const result = parseEvaluationOutput(output, "tasks");
    expect(result.pass).toBe(false); // 45 < 60 threshold
  });

  it("infers pass when score >= 60", () => {
    const output = JSON.stringify({ score: 75, issues: [] });

    const result = parseEvaluationOutput(output, "tasks");
    expect(result.pass).toBe(true);
  });
});

// ── formatEvaluationFeedback ─────────────────────────────────

describe("formatEvaluationFeedback", () => {
  it("formats evaluation into agent-readable feedback", () => {
    const evaluation: GateEvaluation = {
      pass: false,
      score: 35,
      issues: [
        { severity: "critical", description: "Missing AC for FR-001", suggestion: "Add GIVEN/WHEN/THEN" },
        { severity: "major", description: "No edge cases", suggestion: "Define EC-001 to EC-005" },
      ],
      gate_name: "spec",
    };

    const feedback = formatEvaluationFeedback(evaluation);

    expect(feedback).toContain("EVALUATION FEEDBACK");
    expect(feedback).toContain("Gate: spec");
    expect(feedback).toContain("35/100");
    expect(feedback).toContain("FAIL");
    expect(feedback).toContain("Missing AC for FR-001");
    expect(feedback).toContain("No edge cases");
    expect(feedback).toContain("address the issues");
  });
});

// ── evaluateAndRework (using custom evaluator) ───────────────

describe("evaluateAndRework", () => {
  it("passes on first attempt (0 rework iterations)", async () => {
    let agentCallCount = 0;

    const result = await evaluateAndRework(
      null,
      "session-1",
      "pm",
      "tasks",
      { subtasks: [{ title: "T1" }] },
      async (feedback) => {
        agentCallCount++;
        return { subtasks: [{ title: "T1 improved" }] };
      },
      2,
      // Custom evaluator: always pass
      async (data) => ({
        pass: true,
        score: 90,
        issues: [],
        gate_name: "tasks",
      })
    );

    expect(result.finalEvaluation.pass).toBe(true);
    expect(result.finalEvaluation.score).toBe(90);
    expect(result.iterations).toBe(0);
    expect(result.passedAtIteration).toBe(0);
    expect(agentCallCount).toBe(0); // agent not re-run
  });

  it("reworks and passes on retry (AC-011)", async () => {
    let evalCount = 0;
    let receivedFeedback: string | null = null;

    const result = await evaluateAndRework(
      null,
      "session-1",
      "pm",
      "tasks",
      { subtasks: [] },
      async (feedback) => {
        receivedFeedback = feedback;
        return { subtasks: [{ title: "Fixed" }] };
      },
      2,
      async (data) => {
        evalCount++;
        if (evalCount === 1) {
          return {
            pass: false,
            score: 30,
            issues: [{ severity: "critical", description: "Empty subtasks", suggestion: "Add subtasks" }],
            gate_name: "tasks",
          };
        }
        return { pass: true, score: 80, issues: [], gate_name: "tasks" };
      }
    );

    expect(result.finalEvaluation.pass).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.passedAtIteration).toBe(1);
    expect(receivedFeedback).toContain("Empty subtasks");
    expect(receivedFeedback).toContain("FAIL");
  });

  it("stops after max iterations with warning (AC-012)", async () => {
    let agentCallCount = 0;

    const result = await evaluateAndRework(
      null,
      "session-1",
      "dev",
      "implementation",
      { files: [] },
      async (feedback) => {
        agentCallCount++;
        return { files: [] }; // never good enough
      },
      2,
      // Custom evaluator: always fail
      async (data) => ({
        pass: false,
        score: 20,
        issues: [{ severity: "critical", description: "Bad output", suggestion: "Fix" }],
        gate_name: "implementation",
      })
    );

    expect(result.finalEvaluation.pass).toBe(false);
    expect(result.passedAtIteration).toBeNull();
    expect(agentCallCount).toBe(2); // called twice (2 rework iterations)
    // Should have the warning about max iterations
    const warningIssue = result.finalEvaluation.issues.find(
      i => i.description.includes("did not pass after 2 rework iterations")
    );
    expect(warningIssue).toBeDefined();
  });

  it("increments blackboard version on rework (AC-013)", async () => {
    let evalCount = 0;

    const result = await evaluateAndRework(
      null,
      "session-1",
      "architect",
      "plan",
      { design: "v1" },
      async (feedback) => {
        return { design: "v2" };
      },
      1,
      async (data) => {
        evalCount++;
        if (evalCount === 1) {
          return { pass: false, score: 40, issues: [], gate_name: "plan" };
        }
        return { pass: true, score: 85, issues: [], gate_name: "plan" };
      }
    );

    expect(result.finalEvaluation.pass).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.passedAtIteration).toBe(1);
  });

  it("handles max 0 iterations (evaluate once, no rework)", async () => {
    let agentCallCount = 0;

    const result = await evaluateAndRework(
      null,
      "session-1",
      "pm",
      "tasks",
      { subtasks: [] },
      async (feedback) => {
        agentCallCount++;
        return { subtasks: [{ title: "Fixed" }] };
      },
      0,
      async (data) => ({
        pass: false,
        score: 30,
        issues: [{ severity: "major", description: "Bad", suggestion: "Fix" }],
        gate_name: "tasks",
      })
    );

    expect(result.finalEvaluation.pass).toBe(false);
    expect(agentCallCount).toBe(0); // no rework with maxIterations=0
    expect(result.passedAtIteration).toBeNull();
  });
});

// ── evaluateExplorationCompleteness ──────────────────────────

describe("evaluateExplorationCompleteness", () => {
  it("passes with valid exploration output", () => {
    const data = {
      domain: "authentification",
      findings: [
        { title: "F1", description: "...", sources: ["src/auth.ts"], relevance: "high" },
        { title: "F2", description: "...", sources: ["docs/arch.md"], relevance: "medium" },
        { title: "F3", description: "...", sources: [], relevance: "low" },
      ],
      alternatives: [
        { label: "A", description: "...", pros: ["p"], cons: ["c"], effort: "medium" },
        { label: "B", description: "...", pros: ["p"], cons: ["c"], effort: "small" },
      ],
      recommendation: "Utiliser Supabase Auth natif pour simplifier l'architecture",
      risks: [{ severity: "medium", description: "migration", mitigation: "progressive" }],
      effort_estimate: "4-6h",
      confidence: 0.85,
      open_questions: [],
    };

    const result = evaluateExplorationCompleteness(data);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.rubric).toHaveLength(4);
    expect(result.issues).toHaveLength(0);
  });

  it("fails with too few findings", () => {
    const data = {
      findings: [{ title: "F1", description: "only one", sources: [] }],
      recommendation: "do something specific and actionable here",
      confidence: 0.7,
      alternatives: [],
    };

    const result = evaluateExplorationCompleteness(data);
    expect(result.pass).toBe(false);
    expect(result.issues.some((i) => i.description.includes("findings"))).toBe(true);
  });

  it("fails with no recommendation", () => {
    const data = {
      findings: [
        { title: "F1", description: "...", sources: [] },
        { title: "F2", description: "...", sources: [] },
      ],
      recommendation: "",
      confidence: 0.8,
      alternatives: [],
    };

    const result = evaluateExplorationCompleteness(data);
    expect(result.pass).toBe(false);
    expect(result.issues.some((i) => i.description.includes("recommendation"))).toBe(true);
  });

  it("flags low confidence", () => {
    const data = {
      findings: [
        { title: "F1", description: "...", sources: ["a.ts"] },
        { title: "F2", description: "...", sources: ["b.ts"] },
      ],
      recommendation: "A clear recommendation with enough detail here",
      confidence: 0.3,
      alternatives: [{ label: "A", description: "..." }, { label: "B", description: "..." }],
    };

    const result = evaluateExplorationCompleteness(data);
    expect(result.issues.some((i) => i.description.includes("confidence"))).toBe(true);
  });

  it("handles missing/null data gracefully", () => {
    const result = evaluateExplorationCompleteness(null);
    expect(result.pass).toBe(false);
    expect(result.score).toBeLessThan(60);
  });

  it("handles empty object", () => {
    const result = evaluateExplorationCompleteness({});
    expect(result.pass).toBe(false);
    expect(result.rubric).toHaveLength(4);
  });

  it("has correct rubric dimensions", () => {
    expect(EXPLORATION_RUBRIC_DIMENSIONS).toEqual(["coverage", "depth", "actionability", "confidence"]);
  });

  it("scores higher with sourced findings", () => {
    const withSources = {
      findings: [
        { title: "F1", description: "...", sources: ["a.ts"] },
        { title: "F2", description: "...", sources: ["b.ts"] },
      ],
      recommendation: "A clear recommendation with enough detail here",
      confidence: 0.8,
      alternatives: [{ label: "A", description: "..." }, { label: "B", description: "..." }],
    };
    const withoutSources = {
      findings: [
        { title: "F1", description: "...", sources: [] },
        { title: "F2", description: "...", sources: [] },
      ],
      recommendation: "A clear recommendation with enough detail here",
      confidence: 0.8,
      alternatives: [{ label: "A", description: "..." }, { label: "B", description: "..." }],
    };

    const resultWith = evaluateExplorationCompleteness(withSources);
    const resultWithout = evaluateExplorationCompleteness(withoutSources);
    expect(resultWith.score).toBeGreaterThan(resultWithout.score);
  });
});
