import { describe, it, expect } from "bun:test";
import { detectIntent, formatIntentSuggestion } from "../../src/intent-detection.ts";

describe("intent-detection", () => {
  describe("detectIntent", () => {
    it("detects backlog intent", () => {
      const result = detectIntent("montre moi le backlog");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/backlog");
      expect(result.detected!.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects sprint intent from natural question", () => {
      const result = detectIntent("ou en est le sprint actuel ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/sprint");
    });

    it("detects task creation intent", () => {
      const result = detectIntent("cree une tache pour refactorer le module");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/task");
    });

    it("detects metrics intent", () => {
      const result = detectIntent("quelles sont les stats du sprint ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/metrics");
    });

    it("detects help intent", () => {
      const result = detectIntent("qu'est-ce que tu peux faire ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/help");
    });

    it("detects cost intent", () => {
      const result = detectIntent("combien ca coute les tokens ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/cost");
    });

    it("detects brain/memory intent", () => {
      const result = detectIntent("fais une synthese de ta memoire");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/brain");
    });

    it("detects plan intent with arg extraction", () => {
      const result = detectIntent("planifie la feature de notifications");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/plan");
    });

    it("returns null for unrelated messages", () => {
      const result = detectIntent("bonjour comment vas-tu ?");
      expect(result.detected).toBeNull();
      expect(result.suggestion).toBeNull();
    });

    it("returns null for empty text", () => {
      const result = detectIntent("");
      expect(result.detected).toBeNull();
    });

    it("handles accented characters", () => {
      const result = detectIntent("lance une rétrospective du sprint");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("/retro");
    });

    it("confidence increases with multiple pattern matches", () => {
      // "sprint actuel" matches one pattern, should be >= 0.7
      const single = detectIntent("sprint actuel");
      expect(single.detected!.confidence).toBeGreaterThanOrEqual(0.7);

      // "comment avance le sprint en cours" matches two patterns
      const multi = detectIntent("comment avance le sprint en cours");
      expect(multi.detected!.confidence).toBeGreaterThan(single.detected!.confidence);
    });
  });

  describe("formatIntentSuggestion", () => {
    it("formats suggestion for high-confidence match", () => {
      const result = detectIntent("montre le backlog");
      const suggestion = formatIntentSuggestion(result, 0.7);
      expect(suggestion).toContain("/backlog");
    });

    it("returns null for low-confidence match", () => {
      const result = { detected: { intent: "test", command: "/test", confidence: 0.5 }, suggestion: "/test" };
      const suggestion = formatIntentSuggestion(result, 0.8);
      expect(suggestion).toBeNull();
    });

    it("returns null when no intent detected", () => {
      const result = detectIntent("random text");
      const suggestion = formatIntentSuggestion(result);
      expect(suggestion).toBeNull();
    });
  });
});
