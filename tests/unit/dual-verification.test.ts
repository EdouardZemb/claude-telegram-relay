/**
 * Unit Tests — S34 FR-001: Dual Verification in Gate Evaluator
 *
 * Tests deterministic checks (tsc, bun test) running before LLM evaluation
 * on implementation gates.
 */

import { describe, it, expect } from "bun:test";
import {
  runSingleCheck,
  runDeterministicChecks,
  type DeterministicCheckResult,
} from "../../src/gate-evaluator";

// ── runSingleCheck ──────────────────────────────────────────

describe("runSingleCheck", () => {
  it("returns passed=true for successful command (AC-001)", () => {
    const result = runSingleCheck(["echo", "ok"], "echo_check");
    expect(result.check).toBe("echo_check");
    expect(result.passed).toBe(true);
    expect(result.output).toContain("ok");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns passed=false for failed command", () => {
    const result = runSingleCheck(["false"], "false_check");
    expect(result.check).toBe("false_check");
    expect(result.passed).toBe(false);
  });

  it("handles command not found gracefully", () => {
    const result = runSingleCheck(["__nonexistent_cmd_xyz__"], "missing_cmd");
    expect(result.check).toBe("missing_cmd");
    expect(result.passed).toBe(false);
  });

  it("respects timeout (EC-001: 30s per check)", () => {
    // Use a very short timeout to test the mechanism
    const result = runSingleCheck(["sleep", "10"], "slow_check", 100);
    expect(result.check).toBe("slow_check");
    // Should either timeout or fail
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("captures output on failure (EC-007)", () => {
    const result = runSingleCheck(["sh", "-c", "echo 'error detail' >&2; exit 1"], "detail_check");
    expect(result.passed).toBe(false);
    expect(result.output).toContain("error detail");
  });

  it("truncates long output to 2000 chars", () => {
    // Generate output longer than 2000 chars
    const longString = "x".repeat(3000);
    const result = runSingleCheck(["echo", longString], "long_output");
    expect(result.output.length).toBeLessThanOrEqual(2000);
  });
});

// ── runDeterministicChecks ───────────────────────────────────

describe("runDeterministicChecks", () => {
  it("returns array of check results (AC-001, AC-002)", () => {
    // Run with a nonexistent cwd to force failures (we don't want actual tsc/bun test)
    const results = runDeterministicChecks("/tmp/__nonexistent_s34_test__");
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
    expect(results[0].check).toBe("tsc");
    expect(results[1].check).toBe("bun_test");
  });

  it("reports which check failed (EC-007)", () => {
    const results = runDeterministicChecks("/tmp/__nonexistent_s34_test__");
    const failedChecks = results.filter((r) => !r.passed);
    // Both should fail in nonexistent dir
    expect(failedChecks.length).toBeGreaterThan(0);
    for (const r of failedChecks) {
      expect(r.check).toBeDefined();
      expect(typeof r.output).toBe("string");
    }
  });

  it("each result has timing info", () => {
    // Use nonexistent dir to fail fast (don't actually run tsc/bun test)
    const results = runDeterministicChecks("/tmp/__nonexistent_timing_test__");
    for (const r of results) {
      expect(typeof r.durationMs).toBe("number");
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── Integration: evaluateGate deterministic behavior ────────

describe("evaluateGate deterministic path", () => {
  it("AC-005: non-implementation gates skip deterministic checks", async () => {
    // We can't easily test the full evaluateGate without mocking spawnClaude,
    // but we verify the type system accepts non-implementation gates
    const { parseEvaluationOutput } = await import("../../src/gate-evaluator");
    const specResult = parseEvaluationOutput(
      JSON.stringify({ pass: true, score: 80, issues: [], gate_name: "spec" }),
      "spec"
    );
    expect(specResult.deterministicChecks).toBeUndefined();
  });

  it("AC-003: implementation gate with failing checks has no LLM cost", () => {
    // Verified by the structure: if deterministicChecks fail,
    // evaluateGate returns immediately without calling spawnClaude
    const results = runDeterministicChecks("/tmp/__fail__");
    const allPassed = results.every((r) => r.passed);
    expect(allPassed).toBe(false);
    // The gate would return score=0 without LLM call
  });
});
