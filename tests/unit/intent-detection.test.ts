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

    it("detects explore intent from natural question", () => {
      const result = detectIntent("comment fonctionne le pipeline");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("explore");
    });

    it("detects explore intent with 'explore' verb", () => {
      const result = detectIntent("explore le module orchestrator");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("explore");
      expect(result.detected!.args).toContain("orchestrator");
    });

    it("detects explore intent for impact queries", () => {
      const result = detectIntent("impact de modifier memory");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("explore");
      expect(result.detected!.args).toContain("memory");
    });

    it("detects explore intent for dependency queries", () => {
      const result = detectIntent("qui utilise le module tasks");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("explore");
    });

    it("detects explore intent for complexity queries", () => {
      const result = detectIntent("complexite du module orchestrator");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("explore");
      expect(result.detected!.args).toContain("orchestrator");
    });

    it("detects explore intent for 'c'est quoi' queries", () => {
      const result = detectIntent("c'est quoi le blackboard");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("explore");
    });

    it("extracts topic from explore intent", () => {
      const result = detectIntent("explore comment fonctionne le relay");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("explore");
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

    // ── Document search intent patterns ──
    it("detects document search from 'trouve mon'", () => {
      const result = detectIntent("trouve mon contrat d'assurance");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("docs");
      expect(result.detected!.args).toContain("search");
      expect(result.detected!.args).toContain("contrat");
    });

    it("detects document search from 'retrouve ma'", () => {
      const result = detectIntent("retrouve ma facture EDF");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("docs");
      expect(result.detected!.args).toContain("search");
      expect(result.detected!.args).toContain("facture");
    });

    it("detects document search from 'ou est'", () => {
      const result = detectIntent("ou est ma facture de mars ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("docs");
      expect(result.detected!.args).toContain("search");
      expect(result.detected!.args).toContain("facture");
    });

    it("detects document search from 'cherche une facture'", () => {
      const result = detectIntent("cherche une facture de mars");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("docs");
      expect(result.detected!.args).toContain("search");
    });

    it("detects document search from 'montre-moi mes'", () => {
      const result = detectIntent("montre-moi mes documents");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("docs");
      expect(result.detected!.args).toContain("search");
    });

    it("detects document search from 'j'ai un document de'", () => {
      const result = detectIntent("j'ai un document de mars a retrouver");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("docs");
      expect(result.detected!.args).toContain("search");
    });

    it("detects document search from 'ma facture de'", () => {
      const result = detectIntent("ma facture de janvier");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("docs");
      expect(result.detected!.args).toContain("search");
      expect(result.detected!.args).toContain("facture");
    });

    it("extracts search term for document intent", () => {
      const result = detectIntent("trouve mes releves bancaires");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("docs");
      expect(result.detected!.args).toBe("search releves bancaires");
    });

    it("document suggestion routes to /docs search", () => {
      const result = detectIntent("ou est mon contrat");
      expect(result.suggestion).toContain("/docs");
      expect(result.suggestion).toContain("search");
    });

    it("does not match document intent for code exploration", () => {
      // "cherche dans le code" should match explore, not docs
      const result = detectIntent("cherche dans le code le bug");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).not.toBe("docs");
    });

    // ── Resume pipeline intent patterns ──
    it("detects resume intent from 'relance le workflow'", () => {
      const result = detectIntent("relance le workflow");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("orchestrate");
      expect(result.detected!.intent).toBe("resume_pipeline");
      expect(result.detected!.args).toBe("--resume");
    });

    it("detects resume intent from 'reprendre le pipeline'", () => {
      const result = detectIntent("reprendre le pipeline");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("orchestrate");
      expect(result.detected!.args).toBe("--resume");
    });

    it("detects resume intent from 'relancer le workflow depuis l'etape ou ca a plante'", () => {
      const result = detectIntent("relancer le workflow depuis l'etape ou ca a plante");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("orchestrate");
      expect(result.detected!.args).toBe("--resume");
    });

    it("detects resume intent from 'reprends depuis l'echec'", () => {
      const result = detectIntent("reprends depuis l'echec");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("orchestrate");
      expect(result.detected!.args).toBe("--resume");
    });

    it("detects resume intent from 'resume le dernier pipeline'", () => {
      const result = detectIntent("resume le dernier pipeline");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("orchestrate");
      expect(result.detected!.args).toBe("--resume");
    });

    // ── Job status intent patterns (S46) ──
    it("detects jobs intent from 'jobs'", () => {
      const result = detectIntent("montre les jobs");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("jobs");
    });

    it("detects jobs intent from 'ou en est'", () => {
      const result = detectIntent("ou en est le job ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("jobs");
    });

    it("detects jobs intent from 'c'est fini'", () => {
      const result = detectIntent("c'est fini ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("jobs");
    });

    it("detects jobs intent from 'qu'est-ce qui tourne'", () => {
      const result = detectIntent("qu'est-ce qui tourne ?");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("jobs");
    });

    it("detects jobs intent from 'statut des jobs'", () => {
      const result = detectIntent("statut des jobs");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.command).toBe("jobs");
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
