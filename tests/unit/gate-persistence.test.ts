/**
 * Unit Tests — src/gate-persistence.ts (S35)
 *
 * Tests for gate evaluation persistence, double-loop learning,
 * and corrective instruction generation.
 */

import { describe, expect, it } from "bun:test";
import { type DimensionWeakness, generateDoubleLoopInstruction } from "../../src/gate-persistence";

// ── generateDoubleLoopInstruction ─────────────────────────────

describe("generateDoubleLoopInstruction", () => {
  it("generates instruction for error_handling dimension", () => {
    const instruction = generateDoubleLoopInstruction("dev", "error_handling", 4);
    expect(instruction).toContain("gestion d'erreurs");
    expect(instruction).toContain("4 evaluations");
    expect(instruction).toContain("ALERTE QUALITE");
  });

  it("generates instruction for test_coverage dimension", () => {
    const instruction = generateDoubleLoopInstruction("dev", "test_coverage", 3);
    expect(instruction).toContain("couverture de tests");
    expect(instruction).toContain("3 evaluations");
  });

  it("generates instruction for code_style dimension", () => {
    const instruction = generateDoubleLoopInstruction("dev", "code_style", 5);
    expect(instruction).toContain("style de code");
  });

  it("generates instruction for spec_conformity dimension", () => {
    const instruction = generateDoubleLoopInstruction("dev", "spec_conformity", 3);
    expect(instruction).toContain("spec");
  });

  it("generates instruction for completeness dimension", () => {
    const instruction = generateDoubleLoopInstruction("pm", "completeness", 4);
    expect(instruction).toContain("completude");
  });

  it("generates instruction for traceability dimension", () => {
    const instruction = generateDoubleLoopInstruction("pm", "traceability", 3);
    expect(instruction).toContain("tracabilite");
  });

  it("generates instruction for clarity dimension", () => {
    const instruction = generateDoubleLoopInstruction("architect", "clarity", 3);
    expect(instruction).toContain("clarte");
  });

  it("generates instruction for feasibility dimension", () => {
    const instruction = generateDoubleLoopInstruction("architect", "feasibility", 5);
    expect(instruction).toContain("faisabilite");
  });

  it("generates generic instruction for unknown dimension", () => {
    const instruction = generateDoubleLoopInstruction("dev", "unknown_dim", 3);
    expect(instruction).toContain("unknown_dim");
    expect(instruction).toContain("ALERTE QUALITE");
    expect(instruction).toContain("3 evaluations");
  });

  it("includes weakness count in all instructions", () => {
    const dims = [
      "error_handling",
      "test_coverage",
      "code_style",
      "spec_conformity",
      "completeness",
      "traceability",
      "clarity",
      "feasibility",
    ];
    for (const dim of dims) {
      const instruction = generateDoubleLoopInstruction("dev", dim, 7);
      expect(instruction).toContain("7 evaluations");
    }
  });
});

// ── DimensionWeakness type ───────────────────────────────────

describe("DimensionWeakness type", () => {
  it("has the expected shape", () => {
    const weakness: DimensionWeakness = {
      agentRole: "dev",
      dimensionName: "error_handling",
      count: 3,
    };
    expect(weakness.agentRole).toBe("dev");
    expect(weakness.dimensionName).toBe("error_handling");
    expect(weakness.count).toBe(3);
  });
});
