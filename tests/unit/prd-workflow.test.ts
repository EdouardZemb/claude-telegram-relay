import { describe, expect, it } from "bun:test";
import type { DetectedConstraint } from "../../src/conversation-session.ts";
import type { PRD } from "../../src/prd.ts";
import {
  buildLaunchConfirmation,
  buildPRCompletionKeyboard,
  buildRevisionKeyboard,
  buildTriageResponse,
  canRevise,
  chatKey,
  clearPendingDescription,
  clearPendingRevision,
  extractSessionConstraints,
  getPendingDescription,
  getPendingRevision,
  getRevisionCount,
  isPrdWorkflowEnabled,
  storePendingDescription,
  storePendingRevision,
  triageDescription,
} from "../../src/prd-workflow.ts";

// ── Helper ────────────────────────────────────────────────────

function makePRD(overrides?: Partial<PRD>): PRD {
  return {
    id: "test-prd-1234-5678-abcd",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "Test PRD",
    summary: "A test PRD",
    content: "# PRD Content",
    project: "telegram-relay",
    status: "draft",
    version: 1,
    tags: [],
    requested_by: "Edouard",
    metadata: {},
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("prd-workflow", () => {
  describe("isPrdWorkflowEnabled", () => {
    it("returns a boolean", () => {
      const result = isPrdWorkflowEnabled();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("extractSessionConstraints", () => {
    it("extracts speed constraint", () => {
      const constraints: DetectedConstraint[] = [
        { type: "speed", value: "fast", source: "test", detectedAt: Date.now() },
      ];
      const result = extractSessionConstraints(constraints);
      expect(result.speed).toBe("fast");
    });

    it("extracts multiple constraints", () => {
      const constraints: DetectedConstraint[] = [
        { type: "speed", value: "fast", source: "test", detectedAt: Date.now() },
        { type: "quality", value: "high", source: "test", detectedAt: Date.now() },
        { type: "budget", value: "low", source: "test", detectedAt: Date.now() },
        { type: "scope", value: "minimal", source: "test", detectedAt: Date.now() },
        { type: "deadline", value: "vendredi", source: "test", detectedAt: Date.now() },
      ];
      const result = extractSessionConstraints(constraints);
      expect(result.speed).toBe("fast");
      expect(result.quality).toBe("high");
      expect(result.budget).toBe("low");
      expect(result.scope).toBe("minimal");
      expect(result.deadline).toBe("vendredi");
    });

    it("returns empty object for no constraints", () => {
      const result = extractSessionConstraints([]);
      expect(result).toEqual({});
    });
  });

  describe("getRevisionCount", () => {
    it("returns 0 for PRD with no revision_count", () => {
      const prd = makePRD();
      expect(getRevisionCount(prd)).toBe(0);
    });

    it("returns the stored revision count", () => {
      const prd = makePRD({ metadata: { revision_count: 2 } });
      expect(getRevisionCount(prd)).toBe(2);
    });
  });

  describe("canRevise", () => {
    it("allows revision when count < 3", () => {
      expect(canRevise(makePRD())).toBe(true);
      expect(canRevise(makePRD({ metadata: { revision_count: 1 } }))).toBe(true);
      expect(canRevise(makePRD({ metadata: { revision_count: 2 } }))).toBe(true);
    });

    it("blocks revision at count >= 3", () => {
      expect(canRevise(makePRD({ metadata: { revision_count: 3 } }))).toBe(false);
      expect(canRevise(makePRD({ metadata: { revision_count: 5 } }))).toBe(false);
    });
  });

  describe("buildRevisionKeyboard", () => {
    it("includes revision button with counter when revisions available", () => {
      const prd = makePRD({ metadata: { revision_count: 1 } });
      const kb = buildRevisionKeyboard(prd);
      expect(kb).toBeDefined();
      // InlineKeyboard is an object with inline_keyboard property
      const raw = (kb as any).inline_keyboard;
      expect(raw).toBeDefined();
      // Should have Approuver and Revision buttons
      const allTexts = raw.flat().map((b: any) => b.text);
      expect(allTexts).toContain("Approuver");
      expect(allTexts.some((t: string) => t.includes("Revision"))).toBe(true);
      expect(allTexts.some((t: string) => t.includes("1/3"))).toBe(true);
    });

    it("excludes revision button when max reached", () => {
      const prd = makePRD({ metadata: { revision_count: 3 } });
      const kb = buildRevisionKeyboard(prd);
      const raw = (kb as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text);
      expect(allTexts.some((t: string) => t.includes("Revision"))).toBe(false);
    });
  });

  describe("buildTriageResponse", () => {
    it("returns message and keyboard", () => {
      const triage = {
        score: 0.45,
        pipeline: "LIGHT",
        pipelineExplanation:
          "Pipeline : planner -> dev -> qa (difficulte: 45%)\nComplexite moyenne.",
        label: "moyenne",
      };
      const { message, keyboard } = buildTriageResponse("ajouter un cache", triage);
      expect(message).toContain("moyenne");
      expect(message).toContain("45%");
      expect(keyboard).toBeDefined();
      const raw = (keyboard as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text);
      expect(allTexts).toContain("Creer le PRD");
      expect(allTexts).toContain("Juste une tache");
      expect(allTexts).toContain("Annuler");
    });

    it("truncates long descriptions", () => {
      const longDesc = "a".repeat(200);
      const triage = {
        score: 0.5,
        pipeline: "DEFAULT",
        pipelineExplanation: "test",
        label: "moyenne",
      };
      const { message } = buildTriageResponse(longDesc, triage);
      expect(message.length).toBeLessThan(longDesc.length + 200);
    });
  });

  describe("buildLaunchConfirmation", () => {
    it("returns message with task count and keyboard", () => {
      const { message, keyboard } = buildLaunchConfirmation(
        "prd-1234",
        "LIGHT",
        "Pipeline : planner -> dev -> qa",
        5,
      );
      expect(message).toContain("5 taches");
      expect(message).toContain("Pipeline");
      const raw = (keyboard as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text);
      expect(allTexts).toContain("Lancer l'implementation");
      expect(allTexts).toContain("Annuler");
    });
  });

  describe("buildPRCompletionKeyboard", () => {
    it("returns message and keyboard with PR URL", () => {
      const { message, keyboard } = buildPRCompletionKeyboard(
        "https://github.com/user/repo/pull/42",
        "3 gates auto-approuvees, 1 evaluee",
      );
      expect(message).toContain("Implementation terminee");
      expect(message).toContain("3 gates");
      const raw = (keyboard as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text || b.url);
      expect(allTexts).toContain("Voir la PR");
      expect(allTexts).toContain("Merger");
    });
  });

  describe("pending description store", () => {
    it("stores and retrieves description", () => {
      const key = "123:456";
      storePendingDescription(key, "test description");
      expect(getPendingDescription(key)).toBe("test description");
    });

    it("clears description", () => {
      const key = "123:789";
      storePendingDescription(key, "test");
      clearPendingDescription(key);
      expect(getPendingDescription(key)).toBeUndefined();
    });

    it("returns undefined for unknown key", () => {
      expect(getPendingDescription("unknown")).toBeUndefined();
    });
  });

  describe("pending revision store", () => {
    it("stores and retrieves revision state", () => {
      const key = "rev:123";
      storePendingRevision(key, "prd-abc", { speed: "fast" });
      const rev = getPendingRevision(key);
      expect(rev).toBeDefined();
      expect(rev!.prdId).toBe("prd-abc");
      expect(rev!.constraints?.speed).toBe("fast");
    });

    it("clears revision state", () => {
      const key = "rev:456";
      storePendingRevision(key, "prd-xyz");
      clearPendingRevision(key);
      expect(getPendingRevision(key)).toBeUndefined();
    });
  });

  describe("chatKey", () => {
    it("returns chatId for no thread", () => {
      expect(chatKey(123)).toBe("123");
    });

    it("returns chatId:threadId for thread", () => {
      expect(chatKey(123, 456)).toBe("123:456");
    });
  });

  describe("triageDescription", () => {
    it("returns a valid triage result", async () => {
      const result = await triageDescription("corriger un typo dans le README");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(["faible", "moyenne", "haute"]).toContain(result.label);
      expect(result.pipeline).toBeDefined();
      expect(result.pipelineExplanation).toBeDefined();
    });

    it("classifies short descriptions as low complexity", async () => {
      const result = await triageDescription("fix typo");
      expect(result.score).toBeLessThan(0.5);
    });

    it("classifies complex descriptions higher", async () => {
      const result = await triageDescription(
        "refactorer le systeme d'orchestration multi-agents avec un pipeline parallele " +
          "et une architecture de microservices avec migration de base de donnees et " +
          "implementation d'un protocole de securite avance avec authentification",
      );
      expect(result.score).toBeGreaterThan(0.3);
    });
  });
});
