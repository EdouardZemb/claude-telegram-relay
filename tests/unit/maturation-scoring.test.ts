import { describe, expect, it } from "bun:test";
import {
  evaluateGate,
  extractAmbiguityScore,
  extractMaturityScore,
  extractShowstopper,
} from "../../src/maturation/scoring.ts";

describe("maturation/scoring", () => {
  describe("extractMaturityScore", () => {
    it("V1: extracts score from markdown header format", () => {
      const text = "## Score de maturite\n\n**Score : 7/10**\n\nJustification here.";
      expect(extractMaturityScore(text)).toBe(7);
    });

    it("V2: extracts from inline format", () => {
      expect(extractMaturityScore("Score de maturite : 8.5/10")).toBe(8.5);
    });

    it("V3: returns 0 if no score found", () => {
      expect(extractMaturityScore("No score in this text")).toBe(0);
    });
  });

  describe("extractAmbiguityScore", () => {
    it("V1: extracts ambiguity score", () => {
      const text = "Ambiguite : 6/10\n\nToo vague.";
      expect(extractAmbiguityScore(text)).toBe(6);
    });

    it("V2: returns 5 as default if not found", () => {
      expect(extractAmbiguityScore("No ambiguity score")).toBe(5);
    });
  });

  describe("extractShowstopper", () => {
    it("V1: detects showstopper in output", () => {
      const text = "## Verdict\n\n**SHOWSTOPPER** : Faille de securite critique.\n\nDetails...";
      const result = extractShowstopper(text);
      expect(result).not.toBeNull();
      expect(result!.reason).toContain("Faille de securite");
    });

    it("V2: returns null when no showstopper", () => {
      const text = "## Verdict\n\n**PASS** : Aucun probleme bloquant identifie.";
      expect(extractShowstopper(text)).toBeNull();
    });
  });

  describe("evaluateGate", () => {
    it("V1: advance when score >= 7 and no showstopper", () => {
      const result = evaluateGate(8, null, 0, 2);
      expect(result.passed).toBe(true);
      expect(result.recommendation).toBe("advance");
    });

    it("V2: loop when score < 7 and iterations remain", () => {
      const result = evaluateGate(5, null, 0, 2);
      expect(result.passed).toBe(false);
      expect(result.recommendation).toBe("loop");
    });

    it("V3: human when score < 7 and max iterations reached", () => {
      const result = evaluateGate(5, null, 2, 2);
      expect(result.passed).toBe(false);
      expect(result.recommendation).toBe("human");
    });

    it("V4: human on showstopper regardless of score", () => {
      const result = evaluateGate(9, { reason: "Critical flaw" }, 0, 2);
      expect(result.passed).toBe(false);
      expect(result.recommendation).toBe("human");
      expect(result.issues).toContain("Critical flaw");
    });
  });
});
