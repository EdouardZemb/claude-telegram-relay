import { describe, expect, it } from "bun:test";
import {
  ALL_MATURATION_PHASES,
  createEmptyRun,
  MATURATION_DOC_TYPES,
  PHASE_LABELS,
  toMaturationName,
} from "../../src/maturation/types.ts";

describe("maturation/types", () => {
  describe("ALL_MATURATION_PHASES", () => {
    it("V1: has 7 phases in correct order", () => {
      expect(ALL_MATURATION_PHASES).toEqual([
        "understand",
        "clarify",
        "explore",
        "confront",
        "synthesize",
        "advocate",
        "validate",
      ]);
    });
  });

  describe("MATURATION_DOC_TYPES", () => {
    it("V1: has 9 document types", () => {
      expect(MATURATION_DOC_TYPES.length).toBe(9);
      expect(MATURATION_DOC_TYPES).toContain("UNDERSTANDING");
      expect(MATURATION_DOC_TYPES).toContain("SPEC-UNIFIEE");
      expect(MATURATION_DOC_TYPES).toContain("DEVILS-ADVOCATE");
    });
  });

  describe("PHASE_LABELS", () => {
    it("V1: maps all phases to French labels", () => {
      expect(PHASE_LABELS.understand).toBe("Comprehension");
      expect(PHASE_LABELS.validate).toBe("Validation");
      expect(Object.keys(PHASE_LABELS).length).toBe(7);
    });
  });

  describe("toMaturationName", () => {
    it("V1: converts description to kebab-case", () => {
      expect(toMaturationName("Refactoring memoire")).toBe("refactoring-memoire");
    });

    it("V2: handles diacritics", () => {
      expect(toMaturationName("Ameliorer l'experience utilisateur")).toBe(
        "ameliorer-l-experience-utilisateur",
      );
    });

    it("V3: truncates to 48 chars at word boundary", () => {
      const long =
        "this is a very long description that should be truncated at a word boundary somewhere";
      const result = toMaturationName(long);
      expect(result.length).toBeLessThanOrEqual(48);
      expect(result).not.toEndWith("-");
    });

    it("V4: handles empty input with fallback", () => {
      const result = toMaturationName("");
      expect(result).toMatch(/^maturation-\d{8}-\d{4,5}$/);
    });
  });

  describe("createEmptyRun", () => {
    it("V1: creates run with all phases pending", () => {
      const run = createEmptyRun(123, undefined, "test-idea", "raw input text");
      expect(run.chatId).toBe(123);
      expect(run.name).toBe("test-idea");
      expect(run.rawInput).toBe("raw input text");
      expect(run.currentPhase).toBe("understand");
      expect(run.iteration).toBe(0);
      expect(run.maxIterations).toBe(2);
      expect(Object.keys(run.steps).length).toBe(7);
      for (const phase of ALL_MATURATION_PHASES) {
        expect(run.steps[phase].status).toBe("pending");
        expect(run.steps[phase].documents).toEqual([]);
      }
    });

    it("V2: generates UUID id", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      expect(run.id).toMatch(/^[a-f0-9-]{36}$/);
    });

    it("V3: sets createdAt and updatedAt to ISO string", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      expect(() => new Date(run.createdAt)).not.toThrow();
      expect(run.updatedAt).toBe(run.createdAt);
    });
  });

  describe("ClarificationState", () => {
    it("V1: createEmptyRun has no clarification by default", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      expect(run.clarification).toBeUndefined();
    });
  });
});
