import { describe, it, expect } from "bun:test";
import { detectIntent, detectIntentWithLLM, formatIntentSuggestion } from "../../src/intent-detection.ts";

describe("intent-detection", () => {
  describe("detectIntent", () => {
    it("detects backlog intent", () => {
      const result = detectIntent("montre moi le backlog");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("backlog");
      expect(result.detected!.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result.detected!.source).toBe("regex");
    });

    it("detects sprint intent from natural question", () => {
      const result = detectIntent("ou en est le sprint actuel ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("sprint");
    });

    it("detects task creation intent", () => {
      const result = detectIntent("cree une tache pour refactorer le module");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("task");
    });

    it("detects metrics intent", () => {
      const result = detectIntent("quelles sont les stats du sprint ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("metrics");
    });

    it("detects help intent", () => {
      const result = detectIntent("qu'est-ce que tu peux faire ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("help");
    });

    it("detects cost intent", () => {
      const result = detectIntent("combien ca coute les tokens ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("cost");
    });

    it("detects brain/memory intent", () => {
      const result = detectIntent("fais une synthese de ta memoire");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("brain");
    });

    it("detects plan intent with arg extraction", () => {
      const result = detectIntent("planifie la feature de notifications");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("plan");
    });

    it("detects exec intent", () => {
      const result = detectIntent("execute la tache");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("exec");
    });

    it("detects done intent", () => {
      const result = detectIntent("termine la tache");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("done");
    });

    it("detects start intent", () => {
      const result = detectIntent("demarre la tache");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("start");
    });

    it("detects monitor intent", () => {
      const result = detectIntent("montre le monitoring");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("monitor");
    });

    it("detects rollback intent", () => {
      const result = detectIntent("fais un rollback");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("rollback");
    });

    it("resolves action from registry", () => {
      const result = detectIntent("montre le backlog");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.action).toBeDefined();
      expect(result.detected!.action!.risk).toBe("low");
      expect(result.detected!.action!.module).toBe("tasks");
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
      expect(result.detected!.command).toBe("retro");
    });

    it("confidence increases with multiple pattern matches", () => {
      const single = detectIntent("sprint actuel");
      expect(single.detected!.confidence).toBeGreaterThanOrEqual(0.7);

      const multi = detectIntent("comment avance le sprint en cours");
      expect(multi.detected!.confidence).toBeGreaterThan(single.detected!.confidence);
    });

    it("suggestion includes slash prefix", () => {
      const result = detectIntent("montre le backlog");
      expect(result.suggestion).toBe("/backlog");
    });

    it("suggestion includes args when extracted", () => {
      const result = detectIntent("planifie la migration database");
      expect(result.suggestion).toContain("/plan");
      expect(result.suggestion).toContain("migration database");
    });
  });

  describe("detectIntentWithLLM", () => {
    it("returns regex result when confidence >= 0.9", async () => {
      // Matches all 3 patterns: "qu'est-ce qu'il reste dans le backlog" + "montre le backlog" + "quoi faire"
      const result = await detectIntentWithLLM("qu'est-ce qu'il reste dans le backlog, montre le backlog, quoi faire", {
        callLLM: async () => '{"command": "help", "args": "", "confidence": 0.95}',
      });
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("backlog");
      expect(result.detected!.source).toBe("regex");
    });

    it("uses LLM when regex returns null", async () => {
      const result = await detectIntentWithLLM("donne moi un apercu de la situation", {
        callLLM: async () => '{"command": "sprint", "args": "", "confidence": 0.85}',
      });
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("sprint");
      expect(result.detected!.source).toBe("llm");
    });

    it("returns null when LLM confidence is too low", async () => {
      const result = await detectIntentWithLLM("il fait beau aujourd'hui", {
        callLLM: async () => '{"command": null, "args": "", "confidence": 0}',
      });
      expect(result.detected).toBeNull();
    });

    it("handles LLM timeout gracefully", async () => {
      const result = await detectIntentWithLLM("montre les alertes", {
        callLLM: async () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)),
        timeoutMs: 50,
      });
      // Should fall back to regex result
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("alerts");
      expect(result.detected!.source).toBe("regex");
    });

    it("handles LLM returning invalid JSON", async () => {
      const result = await detectIntentWithLLM("bonjour", {
        callLLM: async () => "I cannot parse this request",
      });
      expect(result.detected).toBeNull();
    });

    it("caps LLM confidence at 0.92", async () => {
      const result = await detectIntentWithLLM("fais un export complet", {
        callLLM: async () => '{"command": "export", "args": "", "confidence": 0.99}',
      });
      expect(result.detected).not.toBeNull();
      expect(result.detected!.confidence).toBeLessThanOrEqual(0.92);
    });

    it("rejects LLM result for unknown command", async () => {
      const result = await detectIntentWithLLM("fais quelque chose", {
        callLLM: async () => '{"command": "unknown_cmd", "args": "", "confidence": 0.9}',
      });
      expect(result.detected).toBeNull();
    });
  });

  describe("formatIntentSuggestion", () => {
    it("formats suggestion for high-confidence match", () => {
      const result = detectIntent("montre le backlog");
      const suggestion = formatIntentSuggestion(result, 0.7);
      expect(suggestion).toContain("/backlog");
    });

    it("returns null for low-confidence match", () => {
      const result = { detected: { intent: "test", command: "test", confidence: 0.5, source: "regex" as const }, suggestion: "/test" };
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
