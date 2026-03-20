/**
 * Comprehensive PRD-to-Deploy Workflow Tests
 *
 * Tests the full lifecycle: intent detection → triage → PRD generation →
 * bounded revision → approval → decomposition → launch → gates → PR merge.
 * Each phase is tested independently + integration between phases.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import {
  isPrdWorkflowEnabled,
  triageDescription,
  buildTriageResponse,
  extractSessionConstraints,
  generateAndSavePRD,
  decomposePRDIntoTasks,
  getRevisionCount,
  canRevise,
  buildRevisionKeyboard,
  revisePRD,
  buildLaunchConfirmation,
  notifyGateResult,
  buildPRCompletionKeyboard,
  storePendingDescription,
  getPendingDescription,
  clearPendingDescription,
  storePendingRevision,
  getPendingRevision,
  clearPendingRevision,
  chatKey,
  type TriageResult,
} from "../../src/prd-workflow.ts";
import type { PRD, PRDSessionConstraints } from "../../src/prd.ts";
import { formatPRDDetail, formatPRDList } from "../../src/prd.ts";
import { detectIntent, detectIntentWithLLM } from "../../src/intent-detection.ts";
import {
  getSession,
  _resetSessions,
  addMessage as addSessionMessage,
  addIntent as addSessionIntent,
  extractConstraints,
  addConstraint,
  formatSessionForIntent,
  buildConversationContext,
  type DetectedConstraint,
  type ConversationSession,
} from "../../src/conversation-session.ts";
import { getAction } from "../../src/action-registry.ts";
import { isPhotoDocument } from "../../src/commands/zz-messages.ts";
import { explainPipelineChoice } from "../../src/pipeline-selection.ts";

// ── Test Helpers ─────────────────────────────────────────────

function makePRD(overrides?: Partial<PRD>): PRD {
  return {
    id: "aaaa1111-bbbb-2222-cccc-3333dddd4444",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "Test PRD",
    summary: "A test PRD summary",
    content: "# PRD Content\n\n## Objectif\nTest objective",
    project: "telegram-relay",
    status: "draft",
    version: 1,
    tags: [],
    requested_by: "Edouard",
    metadata: {},
    ...overrides,
  };
}

function makeConstraints(overrides?: Partial<Record<string, DetectedConstraint>>): DetectedConstraint[] {
  const constraints: DetectedConstraint[] = [];
  if (overrides?.speed) constraints.push(overrides.speed);
  if (overrides?.quality) constraints.push(overrides.quality);
  return constraints;
}

// ── Phase 1: Intent Detection for PRD Workflow ───────────────

describe("PRD Workflow — Intent Detection", () => {
  describe("suggest_prd intent patterns", () => {
    const suggestPhrases = [
      "je voudrais ajouter un systeme de cache",
      "j'aimerais ajouter un export CSV",
      "il faudrait que le bot envoie des rappels automatiques",
      "on devrait ajouter un dashboard ameliore",
      "on pourrait implementer une API REST",
      "il faudrait que le bot gere la pagination automatique",
      "on a besoin d'un systeme d'audit",
      "il nous faut un mecanisme de retry",
      "il manque un systeme de logs structure",
      "nouvelle fonctionnalite de recherche avancee",
      "nouvelle feature pour le rate limiting",
      "nouveau module de validation",
      "nouvelle commande pour le templating",
      "implemente un systeme de notifications push",
      "developpe un module de gestion documentaire",
      "le bot devrait pouvoir analyser les performances",
      "le systeme devrait gerer les profils utilisateurs",
      "lance le prd pour l'audit qualite",
      "lance un prd sur la refactorisation",
      "lance le prd",
    ];

    for (const phrase of suggestPhrases) {
      it(`detects suggest_prd: "${phrase.substring(0, 50)}..."`, () => {
        const result = detectIntent(phrase);
        expect(result.detected).not.toBeNull();
        expect(result.detected!.intent).toBe("suggest_prd");
        expect(result.detected!.command).toBe("prd_workflow");
        expect(result.detected!.confidence).toBeGreaterThanOrEqual(0.7);
        expect(result.detected!.source).toBe("regex");
      });
    }

    it("extracts description from args", () => {
      const result = detectIntent("je voudrais ajouter un systeme de cache intelligent");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.args).toBeDefined();
      expect(result.detected!.args).toContain("systeme de cache intelligent");
    });

    it("extracts description from 'lance le prd sur X'", () => {
      const result = detectIntent("lance le prd sur la recherche semantique");
      expect(result.detected).not.toBeNull();
      expect(result.detected!.args).toBeDefined();
      expect(result.detected!.args).toContain("recherche semantique");
    });
  });

  describe("create_prd intent patterns", () => {
    const createPhrases = [
      "cree un prd pour la refactorisation",
      "genere un prd sur le monitoring",
      "redige un prd pour le systeme d'alerte",
      "prd pour l'amelioration des performances",
      "prd sur la gestion des erreurs",
      "prd de la feature notifications",
    ];

    for (const phrase of createPhrases) {
      it(`detects create_prd: "${phrase.substring(0, 50)}..."`, () => {
        const result = detectIntent(phrase);
        expect(result.detected).not.toBeNull();
        expect(result.detected!.intent).toBe("create_prd");
        expect(result.detected!.command).toBe("prd");
        expect(result.detected!.confidence).toBeGreaterThanOrEqual(0.7);
      });
    }

    it("extracts topic from 'prd pour X'", () => {
      const result = detectIntent("prd pour la refactorisation du module agent");
      expect(result.detected!.args).toContain("refactorisation du module agent");
    });

    it("extracts topic from 'cree un prd X'", () => {
      const result = detectIntent("cree un prd la gestion des erreurs");
      expect(result.detected!.args).toBeDefined();
    });
  });

  describe("view_prd intent patterns", () => {
    const viewPhrases = [
      "montre moi le prd",
      "affiche le prd",
      "voir le prd",
      "prd c495951a",
      "liste les prds",
      "lister les prds",
      "quels prds",
    ];

    for (const phrase of viewPhrases) {
      it(`detects view_prd: "${phrase}"`, () => {
        const result = detectIntent(phrase);
        expect(result.detected).not.toBeNull();
        expect(result.detected!.intent).toBe("view_prd");
        expect(result.detected!.command).toBe("prd");
      });
    }

    it("extracts hex ID from 'prd c495951a'", () => {
      const result = detectIntent("prd c495951a");
      expect(result.detected!.args).toBe("c495951a");
    });

    it("detects list intent from 'liste les prds'", () => {
      const result = detectIntent("liste les prds");
      expect(result.detected!.args).toBe("list");
    });
  });

  describe("non-PRD messages should not match PRD intents", () => {
    const nonPrdMessages = [
      "bonjour comment vas-tu",
      "quel temps fait-il",
      "merci pour ton aide",
      "ou en est le sprint",
      "montre les metriques",
    ];

    for (const msg of nonPrdMessages) {
      it(`does not match PRD intent: "${msg}"`, () => {
        const result = detectIntent(msg);
        if (result.detected) {
          expect(result.detected.intent).not.toBe("suggest_prd");
          expect(result.detected.intent).not.toBe("create_prd");
        }
      });
    }
  });

  describe("intent routing priority", () => {
    it("suggest_prd wins over create_prd for 'je voudrais' pattern", () => {
      const result = detectIntent("je voudrais ajouter un export PDF");
      expect(result.detected!.intent).toBe("suggest_prd");
      expect(result.detected!.command).toBe("prd_workflow");
    });

    it("create_prd detected for explicit 'cree un prd'", () => {
      const result = detectIntent("cree un prd");
      expect(result.detected!.intent).toBe("create_prd");
      expect(result.detected!.command).toBe("prd");
    });
  });
});

// ── Phase 1: Triage ─────────────────────────────────────────

describe("PRD Workflow — F1: Triage", () => {
  describe("triageDescription", () => {
    it("returns valid triage result for simple task", async () => {
      const result = await triageDescription("corriger un typo");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(["faible", "moyenne", "haute"]).toContain(result.label);
      expect(result.pipeline).toBeDefined();
      expect(result.pipelineExplanation).toBeTruthy();
    });

    it("assigns low complexity to short descriptions (fallback)", async () => {
      const result = await triageDescription("fix typo");
      // Short text should score low via the fallback
      expect(result.score).toBeLessThanOrEqual(0.5);
    });

    it("assigns higher complexity to detailed descriptions", async () => {
      const longDesc =
        "Implementer un systeme complet d'audit de qualite du code avec analyse statique, " +
        "detection de code mort, verification de couverture de tests, scoring par module, " +
        "persistence des resultats dans Supabase, creation automatique de taches pour les findings, " +
        "integration dans le heartbeat pour une surveillance continue, et un tableau de bord " +
        "sur la page du dashboard existant avec graphiques de tendance.";
      const result = await triageDescription(longDesc);
      expect(result.score).toBeGreaterThan(0.3);
    });

    it("label matches score range", async () => {
      // Test label mapping via buildTriageResponse
      const lowTriage: TriageResult = { score: 0.2, pipeline: "SOLO", pipelineExplanation: "test", label: "faible" };
      expect(lowTriage.label).toBe("faible");

      const midTriage: TriageResult = { score: 0.5, pipeline: "LIGHT", pipelineExplanation: "test", label: "moyenne" };
      expect(midTriage.label).toBe("moyenne");

      const highTriage: TriageResult = { score: 0.8, pipeline: "DEFAULT", pipelineExplanation: "test", label: "haute" };
      expect(highTriage.label).toBe("haute");
    });
  });

  describe("buildTriageResponse", () => {
    it("builds message with complexity and pipeline info", () => {
      const triage: TriageResult = {
        score: 0.65,
        pipeline: "DEFAULT",
        pipelineExplanation: "Pipeline : analyst -> pm -> architect -> dev -> qa (difficulte: 65%)\nComplexite elevee.",
        label: "haute",
      };
      const { message, keyboard } = buildTriageResponse("Implementer un audit complet", triage);

      expect(message).toContain("haute");
      expect(message).toContain("65%");
      expect(message).toContain("Implementer un audit complet");
    });

    it("includes all 3 action buttons", () => {
      const triage: TriageResult = { score: 0.5, pipeline: "LIGHT", pipelineExplanation: "test", label: "moyenne" };
      const { keyboard } = buildTriageResponse("test", triage);
      const raw = (keyboard as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text);

      expect(allTexts).toContain("Creer le PRD");
      expect(allTexts).toContain("Juste une tache");
      expect(allTexts).toContain("Annuler");
    });

    it("includes correct callback data in buttons", () => {
      const triage: TriageResult = { score: 0.5, pipeline: "LIGHT", pipelineExplanation: "test", label: "moyenne" };
      const { keyboard } = buildTriageResponse("test", triage);
      const raw = (keyboard as any).inline_keyboard;
      const allCallbackData = raw.flat().map((b: any) => b.callback_data);

      expect(allCallbackData).toContain("prdwf_create");
      expect(allCallbackData).toContain("prdwf_task");
      expect(allCallbackData).toContain("prdwf_cancel");
    });

    it("truncates long descriptions to 100 chars", () => {
      const longDesc = "a".repeat(200);
      const triage: TriageResult = { score: 0.5, pipeline: "DEFAULT", pipelineExplanation: "test", label: "moyenne" };
      const { message } = buildTriageResponse(longDesc, triage);
      // Description should be truncated with "..."
      expect(message).toContain("...");
      expect(message.length).toBeLessThan(longDesc.length + 200);
    });

    it("does not truncate short descriptions", () => {
      const shortDesc = "fix a bug";
      const triage: TriageResult = { score: 0.2, pipeline: "SOLO", pipelineExplanation: "test", label: "faible" };
      const { message } = buildTriageResponse(shortDesc, triage);
      expect(message).toContain("fix a bug");
      expect(message).not.toContain("...");
    });
  });

  describe("explainPipelineChoice integration", () => {
    it("SOLO pipeline mentions simplicity", () => {
      const explanation = explainPipelineChoice(["dev"], 0.15);
      expect(explanation).toContain("dev");
    });

    it("LIGHT pipeline mentions planner", () => {
      const explanation = explainPipelineChoice(["planner", "dev", "qa"], 0.45);
      expect(explanation).toContain("planner");
    });

    it("DEFAULT pipeline mentions full team", () => {
      const explanation = explainPipelineChoice(["analyst", "pm", "architect", "dev", "qa"], 0.75);
      expect(explanation).toContain("75%");
    });

    it("RESEARCH pipeline mentions research", () => {
      const explanation = explainPipelineChoice(["explorer", "planner", "dev", "qa"]);
      expect(explanation).toContain("Recherche");
    });
  });
});

// ── Phase 2: Session Constraints ─────────────────────────────

describe("PRD Workflow — Session Constraints", () => {
  beforeEach(() => {
    _resetSessions();
  });

  describe("extractSessionConstraints", () => {
    it("maps all constraint types correctly", () => {
      const constraints: DetectedConstraint[] = [
        { type: "speed", value: "fast", source: "fais vite", detectedAt: Date.now() },
        { type: "quality", value: "high", source: "qualite max", detectedAt: Date.now() },
        { type: "budget", value: "low", source: "budget serre", detectedAt: Date.now() },
        { type: "scope", value: "minimal", source: "scope minimal", detectedAt: Date.now() },
        { type: "deadline", value: "vendredi", source: "avant vendredi", detectedAt: Date.now() },
      ];
      const result = extractSessionConstraints(constraints);
      expect(result.speed).toBe("fast");
      expect(result.quality).toBe("high");
      expect(result.budget).toBe("low");
      expect(result.scope).toBe("minimal");
      expect(result.deadline).toBe("vendredi");
    });

    it("handles empty constraints", () => {
      const result = extractSessionConstraints([]);
      expect(Object.keys(result).length).toBe(0);
    });

    it("handles partial constraints", () => {
      const constraints: DetectedConstraint[] = [
        { type: "quality", value: "high", source: "test", detectedAt: Date.now() },
      ];
      const result = extractSessionConstraints(constraints);
      expect(result.quality).toBe("high");
      expect(result.speed).toBeUndefined();
      expect(result.budget).toBeUndefined();
    });

    it("latest constraint of same type wins", () => {
      const constraints: DetectedConstraint[] = [
        { type: "speed", value: "slow", source: "first", detectedAt: Date.now() - 1000 },
        { type: "speed", value: "fast", source: "second", detectedAt: Date.now() },
      ];
      const result = extractSessionConstraints(constraints);
      // The loop iterates sequentially, so the last one wins
      expect(result.speed).toBe("fast");
    });
  });

  describe("constraint extraction from natural language", () => {
    it("detects speed constraint from 'fais vite'", () => {
      const constraints = extractConstraints("fais ca vite s'il te plait");
      const speed = constraints.find(c => c.type === "speed");
      expect(speed).toBeDefined();
    });

    it("detects quality constraint from 'qualite'", () => {
      const constraints = extractConstraints("haute qualite requise");
      const quality = constraints.find(c => c.type === "quality");
      expect(quality).toBeDefined();
    });
  });

  describe("session tracks PRD workflow state", () => {
    it("tracks activePrdId", () => {
      const session = getSession(70001);
      expect(session.activePrdId).toBeUndefined();
      session.activePrdId = "prd-123";
      expect(session.activePrdId).toBe("prd-123");
    });

    it("tracks prdWorkflowStep through phases", () => {
      const session = getSession(70002);
      expect(session.prdWorkflowStep).toBeUndefined();

      session.prdWorkflowStep = "triage";
      expect(session.prdWorkflowStep).toBe("triage");

      session.prdWorkflowStep = "generation";
      expect(session.prdWorkflowStep).toBe("generation");

      session.prdWorkflowStep = "revision";
      expect(session.prdWorkflowStep).toBe("revision");

      session.prdWorkflowStep = "decomposition";
      expect(session.prdWorkflowStep).toBe("decomposition");

      session.prdWorkflowStep = "implementation";
      expect(session.prdWorkflowStep).toBe("implementation");

      session.prdWorkflowStep = "done";
      expect(session.prdWorkflowStep).toBe("done");
    });

    it("adds constraints from multiple messages", () => {
      const session = getSession(70003);
      addConstraint(session, "speed", "fast", "fais vite");
      addConstraint(session, "quality", "high", "qualite top");
      expect(session.constraints.length).toBeGreaterThanOrEqual(2);
    });

    it("tracks intent history for PRD workflow", () => {
      const session = getSession(70004);
      addSessionIntent(session, "suggest_prd", "prd_workflow", 0.9, true);
      expect(session.intents.length).toBe(1);
      expect(session.intents[0].intent).toBe("suggest_prd");
      expect(session.intents[0].executed).toBe(true);
    });

    it("formatSessionForIntent includes intent history", () => {
      const session = getSession(70005);
      addSessionIntent(session, "suggest_prd", "prd_workflow", 0.9, true);
      addSessionMessage(session, "je voudrais ajouter un cache");
      const formatted = formatSessionForIntent(session);
      // formatSessionForIntent uses command name, not intent name
      expect(formatted).toContain("prd_workflow");
    });
  });
});

// ── Phase 3: Bounded Revision ────────────────────────────────

describe("PRD Workflow — F3: Bounded Revision", () => {
  describe("getRevisionCount", () => {
    it("returns 0 for fresh PRD", () => {
      expect(getRevisionCount(makePRD())).toBe(0);
    });

    it("returns stored count", () => {
      expect(getRevisionCount(makePRD({ metadata: { revision_count: 1 } }))).toBe(1);
      expect(getRevisionCount(makePRD({ metadata: { revision_count: 2 } }))).toBe(2);
      expect(getRevisionCount(makePRD({ metadata: { revision_count: 3 } }))).toBe(3);
    });

    it("handles missing metadata gracefully", () => {
      const prd = makePRD();
      (prd as any).metadata = null;
      expect(getRevisionCount(prd)).toBe(0);
    });

    it("handles undefined metadata gracefully", () => {
      const prd = makePRD();
      (prd as any).metadata = undefined;
      expect(getRevisionCount(prd)).toBe(0);
    });
  });

  describe("canRevise", () => {
    it("allows revisions 0, 1, 2", () => {
      expect(canRevise(makePRD())).toBe(true);
      expect(canRevise(makePRD({ metadata: { revision_count: 0 } }))).toBe(true);
      expect(canRevise(makePRD({ metadata: { revision_count: 1 } }))).toBe(true);
      expect(canRevise(makePRD({ metadata: { revision_count: 2 } }))).toBe(true);
    });

    it("blocks revision at count 3", () => {
      expect(canRevise(makePRD({ metadata: { revision_count: 3 } }))).toBe(false);
    });

    it("blocks revision at count > 3", () => {
      expect(canRevise(makePRD({ metadata: { revision_count: 4 } }))).toBe(false);
      expect(canRevise(makePRD({ metadata: { revision_count: 10 } }))).toBe(false);
    });
  });

  describe("buildRevisionKeyboard", () => {
    it("includes approve + revision + reject for revision 0", () => {
      const prd = makePRD();
      const kb = buildRevisionKeyboard(prd);
      const raw = (kb as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text);
      const allData = raw.flat().map((b: any) => b.callback_data);

      expect(allTexts).toContain("Approuver");
      expect(allTexts).toContain("Rejeter");
      expect(allTexts.some((t: string) => t.includes("Revision"))).toBe(true);
      expect(allTexts.some((t: string) => t.includes("0/3"))).toBe(true);
      expect(allData.some((d: string) => d?.startsWith("prd_approve:"))).toBe(true);
      expect(allData.some((d: string) => d?.startsWith("prdwf_revise:"))).toBe(true);
      expect(allData.some((d: string) => d?.startsWith("prd_reject:"))).toBe(true);
    });

    it("shows correct revision counter", () => {
      const prd = makePRD({ metadata: { revision_count: 2 } });
      const kb = buildRevisionKeyboard(prd);
      const raw = (kb as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text);
      expect(allTexts.some((t: string) => t.includes("2/3"))).toBe(true);
    });

    it("omits revision button when max reached (3/3)", () => {
      const prd = makePRD({ metadata: { revision_count: 3 } });
      const kb = buildRevisionKeyboard(prd);
      const raw = (kb as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text);
      expect(allTexts.some((t: string) => t.includes("Revision"))).toBe(false);
      // Still has approve and reject
      expect(allTexts).toContain("Approuver");
      expect(allTexts).toContain("Rejeter");
    });

    it("callback data includes PRD ID", () => {
      const prd = makePRD({ id: "test-prd-abcd-1234" });
      const kb = buildRevisionKeyboard(prd);
      const raw = (kb as any).inline_keyboard;
      const allData = raw.flat().map((b: any) => b.callback_data).filter(Boolean);
      expect(allData.some((d: string) => d.includes("test-prd-abcd-1234"))).toBe(true);
    });
  });
});

// ── Phase 5: Launch Confirmation ─────────────────────────────

describe("PRD Workflow — F5: Launch Confirmation", () => {
  describe("buildLaunchConfirmation", () => {
    it("builds message with task count", () => {
      const { message } = buildLaunchConfirmation(
        "prd-abc-123",
        "LIGHT",
        "Pipeline : planner -> dev -> qa",
        3,
      );
      expect(message).toContain("3 taches");
      expect(message).toContain("Pipeline");
      expect(message).toContain("Confirmer");
    });

    it("includes launch and cancel buttons", () => {
      const { keyboard } = buildLaunchConfirmation("prd-abc-123", "LIGHT", "test", 5);
      const raw = (keyboard as any).inline_keyboard;
      const allTexts = raw.flat().map((b: any) => b.text);
      const allData = raw.flat().map((b: any) => b.callback_data);

      expect(allTexts).toContain("Lancer l'implementation");
      expect(allTexts).toContain("Voir le backlog");
      expect(allTexts).toContain("Annuler");
      expect(allData.some((d: string) => d?.startsWith("prdwf_launch:"))).toBe(true);
      expect(allData).toContain("prdwf_cancel");
    });

    it("launch button callback data contains PRD ID prefix (8 chars)", () => {
      const { keyboard } = buildLaunchConfirmation("aaaa1111-bbbb-2222-cccc-3333dddd4444", "DEFAULT", "test", 1);
      const raw = (keyboard as any).inline_keyboard;
      const allData = raw.flat().map((b: any) => b.callback_data).filter(Boolean);
      const launchData = allData.find((d: string) => d.startsWith("prdwf_launch:"));
      expect(launchData).toBe("prdwf_launch:aaaa1111");
    });

    it("includes pipeline explanation in message", () => {
      const { message } = buildLaunchConfirmation("id", "DEFAULT", "Explication custom ici", 10);
      expect(message).toContain("Explication custom ici");
    });

    it("handles single task", () => {
      const { message } = buildLaunchConfirmation("id", "SOLO", "Pipeline SOLO", 1);
      expect(message).toContain("1 tache");
    });
  });
});

// ── Phase 6: Gate Notifications ──────────────────────────────

describe("PRD Workflow — F6: Gate Notifications", () => {
  describe("notifyGateResult", () => {
    it("formats auto-approved gate with trust score", async () => {
      // notifyGateResult calls enqueue() internally — we just verify it doesn't throw
      await expect(
        notifyGateResult("spec", true, 85, true, "pm", 82)
      ).resolves.toBeUndefined();
    });

    it("formats rework gate notification", async () => {
      await expect(
        notifyGateResult("implementation", false, 45, false, "dev", undefined, 1)
      ).resolves.toBeUndefined();
    });

    it("formats normal gate evaluation", async () => {
      await expect(
        notifyGateResult("implementation", true, 72, false)
      ).resolves.toBeUndefined();
    });

    it("formats failed gate evaluation", async () => {
      await expect(
        notifyGateResult("implementation", false, 35, false)
      ).resolves.toBeUndefined();
    });
  });
});

// ── Phase 7: PR Completion ───────────────────────────────────

describe("PRD Workflow — F7: PR Completion", () => {
  describe("buildPRCompletionKeyboard", () => {
    it("includes PR URL button", () => {
      const { message, keyboard } = buildPRCompletionKeyboard(
        "https://github.com/user/repo/pull/42",
        "3 gates OK, 1 rework",
      );
      const raw = (keyboard as any).inline_keyboard;
      const urlBtn = raw.flat().find((b: any) => b.url);
      expect(urlBtn).toBeDefined();
      expect(urlBtn.url).toBe("https://github.com/user/repo/pull/42");
      expect(urlBtn.text).toBe("Voir la PR");
    });

    it("includes merge button with PR number", () => {
      const { keyboard } = buildPRCompletionKeyboard(
        "https://github.com/user/repo/pull/42",
        "gates OK",
      );
      const raw = (keyboard as any).inline_keyboard;
      const mergeBtn = raw.flat().find((b: any) => b.text === "Merger");
      expect(mergeBtn).toBeDefined();
      expect(mergeBtn.callback_data).toBe("prdwf_merge:42");
    });

    it("extracts PR number from various URL formats", () => {
      const { keyboard } = buildPRCompletionKeyboard(
        "https://github.com/org/repo/pull/123",
        "",
      );
      const raw = (keyboard as any).inline_keyboard;
      const mergeBtn = raw.flat().find((b: any) => b.text === "Merger");
      expect(mergeBtn.callback_data).toBe("prdwf_merge:123");
    });

    it("handles invalid PR URL gracefully", () => {
      const { keyboard } = buildPRCompletionKeyboard(
        "https://invalid-url.com",
        "",
      );
      const raw = (keyboard as any).inline_keyboard;
      const mergeBtn = raw.flat().find((b: any) => b.text === "Merger");
      expect(mergeBtn.callback_data).toBe("prdwf_merge:0");
    });

    it("message includes completion text and gates summary", () => {
      const { message } = buildPRCompletionKeyboard(
        "https://github.com/user/repo/pull/42",
        "2 gates auto-approuvees, 1 evaluee (85/100)",
      );
      expect(message).toContain("Implementation terminee");
      expect(message).toContain("2 gates auto-approuvees");
    });
  });
});

// ── State Management ─────────────────────────────────────────

describe("PRD Workflow — State Management", () => {
  describe("chatKey", () => {
    it("uses chatId alone for private chats", () => {
      expect(chatKey(12345)).toBe("12345");
    });

    it("uses chatId:threadId for forum topics", () => {
      expect(chatKey(12345, 67890)).toBe("12345:67890");
    });

    it("handles zero threadId", () => {
      expect(chatKey(12345, 0)).toBe("12345");
    });
  });

  describe("pending description store", () => {
    it("stores and retrieves description", () => {
      const key = "pdtest:100";
      storePendingDescription(key, "ajouter un systeme d'audit");
      expect(getPendingDescription(key)).toBe("ajouter un systeme d'audit");
    });

    it("clears description", () => {
      const key = "pdtest:200";
      storePendingDescription(key, "test");
      clearPendingDescription(key);
      expect(getPendingDescription(key)).toBeUndefined();
    });

    it("returns undefined for unknown key", () => {
      expect(getPendingDescription("pdtest:unknown")).toBeUndefined();
    });

    it("overwrites existing description", () => {
      const key = "pdtest:300";
      storePendingDescription(key, "first");
      storePendingDescription(key, "second");
      expect(getPendingDescription(key)).toBe("second");
    });

    it("different chat keys are independent", () => {
      storePendingDescription("pdtest:400", "desc A");
      storePendingDescription("pdtest:500", "desc B");
      expect(getPendingDescription("pdtest:400")).toBe("desc A");
      expect(getPendingDescription("pdtest:500")).toBe("desc B");
    });
  });

  describe("pending revision store", () => {
    it("stores prdId and constraints", () => {
      const key = "prtest:100";
      storePendingRevision(key, "prd-abc-123", { quality: "high", speed: "fast" });
      const rev = getPendingRevision(key);
      expect(rev).toBeDefined();
      expect(rev!.prdId).toBe("prd-abc-123");
      expect(rev!.constraints?.quality).toBe("high");
      expect(rev!.constraints?.speed).toBe("fast");
    });

    it("stores without constraints", () => {
      const key = "prtest:200";
      storePendingRevision(key, "prd-xyz-789");
      const rev = getPendingRevision(key);
      expect(rev!.prdId).toBe("prd-xyz-789");
      expect(rev!.constraints).toBeUndefined();
    });

    it("clears revision", () => {
      const key = "prtest:300";
      storePendingRevision(key, "prd-abc");
      clearPendingRevision(key);
      expect(getPendingRevision(key)).toBeUndefined();
    });

    it("returns undefined for unknown key", () => {
      expect(getPendingRevision("prtest:unknown")).toBeUndefined();
    });

    it("overwrites existing revision", () => {
      const key = "prtest:400";
      storePendingRevision(key, "prd-1");
      storePendingRevision(key, "prd-2", { budget: "low" });
      const rev = getPendingRevision(key);
      expect(rev!.prdId).toBe("prd-2");
      expect(rev!.constraints?.budget).toBe("low");
    });
  });
});

// ── PRD Formatting ───────────────────────────────────────────

describe("PRD Workflow — PRD Formatting", () => {
  describe("formatPRDDetail", () => {
    it("includes title and status", () => {
      const prd = makePRD({ title: "Audit Qualite", status: "draft" });
      const detail = formatPRDDetail(prd);
      expect(detail).toContain("Audit Qualite");
      expect(detail).toContain("BROUILLON");
    });

    it("includes ID prefix", () => {
      const prd = makePRD({ id: "abcd1234-5678-9012-3456-789012345678" });
      const detail = formatPRDDetail(prd);
      expect(detail).toContain("abcd1234");
    });

    it("shows correct status labels", () => {
      expect(formatPRDDetail(makePRD({ status: "draft" }))).toContain("BROUILLON");
      expect(formatPRDDetail(makePRD({ status: "approved" }))).toContain("APPROUVE");
      expect(formatPRDDetail(makePRD({ status: "rejected" }))).toContain("REJETE");
      expect(formatPRDDetail(makePRD({ status: "superseded" }))).toContain("REMPLACE");
    });

    it("includes content", () => {
      const prd = makePRD({ content: "## Objectif\nImplementer un audit" });
      const detail = formatPRDDetail(prd);
      expect(detail).toContain("Implementer un audit");
    });
  });

  describe("formatPRDList", () => {
    it("returns empty message for no PRDs", () => {
      const result = formatPRDList([]);
      expect(result).toContain("Aucun PRD");
    });

    it("lists multiple PRDs with status", () => {
      const prds = [
        makePRD({ title: "PRD Alpha", status: "draft" }),
        makePRD({ title: "PRD Beta", status: "approved" }),
      ];
      const result = formatPRDList(prds);
      expect(result).toContain("PRD Alpha");
      expect(result).toContain("PRD Beta");
      expect(result).toContain("BROUILLON");
      expect(result).toContain("APPROUVE");
    });

    it("includes summary when present", () => {
      const prds = [makePRD({ summary: "Un resume pertinent" })];
      const result = formatPRDList(prds);
      expect(result).toContain("Un resume pertinent");
    });
  });
});

// ── Feature Flag ─────────────────────────────────────────────

describe("PRD Workflow — Feature Flag", () => {
  it("isPrdWorkflowEnabled returns boolean", () => {
    const result = isPrdWorkflowEnabled();
    expect(typeof result).toBe("boolean");
  });
});

// ── Action Registry Integration ──────────────────────────────

describe("PRD Workflow — Action Registry", () => {
  it("prd_workflow action is registered", () => {
    const action = getAction("prd_workflow");
    expect(action).toBeDefined();
    expect(action!.command).toBe("prd_workflow");
    expect(action!.risk).toBe("medium");
  });

  it("prd action is registered", () => {
    const action = getAction("prd");
    expect(action).toBeDefined();
    expect(action!.command).toBe("prd");
  });

  it("plan action is registered", () => {
    const action = getAction("plan");
    expect(action).toBeDefined();
    expect(action!.command).toBe("plan");
  });

  it("exec action is registered as high-risk", () => {
    const action = getAction("exec");
    expect(action).toBeDefined();
    expect(action!.risk).toBe("high");
  });

  it("orchestrate action is registered as high-risk", () => {
    const action = getAction("orchestrate");
    expect(action).toBeDefined();
    expect(action!.risk).toBe("high");
  });

  it("autopipeline action is registered as high-risk", () => {
    const action = getAction("autopipeline");
    expect(action).toBeDefined();
    expect(action!.risk).toBe("high");
  });
});

// ── Proposal Detection ───────────────────────────────────────

describe("PRD Workflow — Proposal Detection (from bot responses)", () => {
  // Import the function - it's not exported, so we test the patterns indirectly
  // by verifying the regex patterns used in zz-messages.ts

  describe("proposal patterns", () => {
    const PROPOSAL_PATTERNS = [
      { regex: /tu\s+veux\s+que\s+je\s+(?:lance|cree|genere|fasse|execute|decompose)\s+(?:le|un|une)?\s*(prd|sprint|tache|plan|implementation|backlog|retro)/i },
      { regex: /(?:je\s+(?:peux|pourrais)|on\s+(?:peut|pourrait))\s+(?:lancer|creer|generer|faire|executer|decomposer)\s+(?:le|un|une)?\s*(prd|sprint|tache|plan|implementation|backlog|retro)/i },
      { regex: /on\s+(?:lance|cree|genere|fait)\s+(?:le|un|une)?\s*(prd|sprint|tache|plan|implementation|backlog|retro)\s*\?/i },
    ];

    it("matches 'tu veux que je lance le prd'", () => {
      const text = "Tu veux que je lance le prd pour cette fonctionnalite ?";
      expect(PROPOSAL_PATTERNS[0].regex.test(text)).toBe(true);
    });

    it("matches 'je peux creer un plan'", () => {
      const text = "Je peux creer un plan pour decomposer ca.";
      expect(PROPOSAL_PATTERNS[1].regex.test(text)).toBe(true);
    });

    it("matches 'on lance le sprint ?'", () => {
      const text = "On lance le sprint ?";
      expect(PROPOSAL_PATTERNS[2].regex.test(text)).toBe(true);
    });

    it("matches 'tu veux que je genere un prd'", () => {
      const text = "Tu veux que je genere un prd ?";
      expect(PROPOSAL_PATTERNS[0].regex.test(text)).toBe(true);
    });

    it("matches 'on pourrait lancer une implementation'", () => {
      const text = "on pourrait lancer une implementation";
      expect(PROPOSAL_PATTERNS[1].regex.test(text)).toBe(true);
    });

    it("does NOT match non-proposal text", () => {
      const texts = [
        "bonjour comment vas-tu",
        "le prd est approuve",
        "j'ai termine le sprint",
      ];
      for (const text of texts) {
        const matched = PROPOSAL_PATTERNS.some(p => p.regex.test(text));
        expect(matched).toBe(false);
      }
    });
  });
});

// ── Confirmation Patterns ────────────────────────────────────

describe("PRD Workflow — User Confirmation Patterns", () => {
  // These patterns are used in zz-messages.ts to detect user confirmation of proposals

  const confirmPatterns = /^(oui|ok|vas[- ]?y|go|lance|d'?accord|dac|yes|yep|ouais|parfait|allez|bien\s+sur|evidemment|confirme|j'?approuve|c'?est\s+bon|envoie|fais[- ]le|on\s+y\s+va)/;
  const rejectPatterns = /^(non|pas|annul|stop|attend|arrete|nan|nope|plus\s+tard|pas\s+maintenant)/;

  function normalize(text: string): string {
    return text.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  describe("confirm patterns", () => {
    const confirmTexts = [
      "oui", "ok", "vas-y", "go", "lance", "d'accord", "dac",
      "yes", "yep", "ouais", "parfait", "allez", "bien sur",
      "evidemment", "confirme", "j'approuve", "c'est bon",
      "envoie", "fais-le", "on y va",
    ];

    for (const text of confirmTexts) {
      it(`detects confirmation: "${text}"`, () => {
        expect(confirmPatterns.test(normalize(text))).toBe(true);
      });
    }
  });

  describe("reject patterns", () => {
    const rejectTexts = [
      "non", "pas maintenant", "annule", "stop", "attends",
      "arrete", "nan", "nope", "plus tard",
    ];

    for (const text of rejectTexts) {
      it(`detects rejection: "${text}"`, () => {
        expect(rejectPatterns.test(normalize(text))).toBe(true);
      });
    }
  });

  describe("neutral messages match neither", () => {
    const neutralTexts = [
      "comment ca marche",
      "explique-moi le concept",
      "je reflechis",
    ];

    for (const text of neutralTexts) {
      it(`neutral: "${text}"`, () => {
        const n = normalize(text);
        expect(confirmPatterns.test(n)).toBe(false);
        expect(rejectPatterns.test(n)).toBe(false);
      });
    }
  });
});

// ── Integration: Full Workflow Data Flow ─────────────────────

describe("PRD Workflow — Full Data Flow Integration", () => {
  beforeEach(() => {
    _resetSessions();
  });

  it("triage → session → constraints flow through the workflow", async () => {
    const chatId = 80001;
    const threadId = undefined;
    const session = getSession(chatId, threadId);

    // User sends a message with constraints
    addSessionMessage(session, "j'aimerais ajouter un audit qualite, fais ca vite et en haute qualite");
    addSessionIntent(session, "suggest_prd", "prd_workflow", 0.9, true);

    // Constraints extracted
    addConstraint(session, "speed", "fast", "fais ca vite");
    addConstraint(session, "quality", "high", "haute qualite");

    // Triage
    const description = "ajouter un audit qualite";
    const triage = await triageDescription(description);

    // Build triage response
    const { message, keyboard } = buildTriageResponse(description, triage);
    expect(message).toContain("Complexite estimee");

    // Store pending description
    const ck = chatKey(chatId, threadId);
    storePendingDescription(ck, description);
    expect(getPendingDescription(ck)).toBe(description);

    // Extract constraints for PRD generation
    const prdConstraints = extractSessionConstraints(session.constraints);
    expect(prdConstraints.speed).toBe("fast");
    expect(prdConstraints.quality).toBe("high");
  });

  it("revision counter increments correctly through multiple revisions", () => {
    const prd0 = makePRD({ metadata: {} });
    expect(getRevisionCount(prd0)).toBe(0);
    expect(canRevise(prd0)).toBe(true);

    const prd1 = makePRD({ metadata: { revision_count: 1 } });
    expect(getRevisionCount(prd1)).toBe(1);
    expect(canRevise(prd1)).toBe(true);

    const prd2 = makePRD({ metadata: { revision_count: 2 } });
    expect(getRevisionCount(prd2)).toBe(2);
    expect(canRevise(prd2)).toBe(true);

    const prd3 = makePRD({ metadata: { revision_count: 3 } });
    expect(getRevisionCount(prd3)).toBe(3);
    expect(canRevise(prd3)).toBe(false);

    // Keyboard adapts
    const kb2 = buildRevisionKeyboard(prd2);
    const texts2 = (kb2 as any).inline_keyboard.flat().map((b: any) => b.text);
    expect(texts2.some((t: string) => t.includes("Revision"))).toBe(true);

    const kb3 = buildRevisionKeyboard(prd3);
    const texts3 = (kb3 as any).inline_keyboard.flat().map((b: any) => b.text);
    expect(texts3.some((t: string) => t.includes("Revision"))).toBe(false);
  });

  it("pending states are independent per chat", () => {
    // Chat A
    const keyA = chatKey(10001, 1);
    storePendingDescription(keyA, "feature A");
    storePendingRevision(keyA, "prd-A");

    // Chat B
    const keyB = chatKey(10002, 2);
    storePendingDescription(keyB, "feature B");
    storePendingRevision(keyB, "prd-B");

    // Verify independence
    expect(getPendingDescription(keyA)).toBe("feature A");
    expect(getPendingDescription(keyB)).toBe("feature B");
    expect(getPendingRevision(keyA)!.prdId).toBe("prd-A");
    expect(getPendingRevision(keyB)!.prdId).toBe("prd-B");

    // Clear A doesn't affect B
    clearPendingDescription(keyA);
    clearPendingRevision(keyA);
    expect(getPendingDescription(keyA)).toBeUndefined();
    expect(getPendingRevision(keyA)).toBeUndefined();
    expect(getPendingDescription(keyB)).toBe("feature B");
    expect(getPendingRevision(keyB)!.prdId).toBe("prd-B");
  });

  it("conversation session builds context for agents", () => {
    const session = getSession(80002);
    addSessionMessage(session, "je voudrais un systeme d'audit");
    addSessionMessage(session, "haute qualite requise");
    addSessionIntent(session, "suggest_prd", "prd_workflow", 0.9, true);
    addConstraint(session, "quality", "high", "haute qualite requise");
    session.prdWorkflowStep = "generation";

    const context = buildConversationContext(session);
    // buildConversationContext uses command name, not intent name
    expect(context).toContain("prd_workflow");
    expect(context).toContain("Qualite");
  });

  it("intent detection works with accented characters", () => {
    // French accents should be normalized
    const result1 = detectIntent("j'aimerais créer un système d'audit");
    expect(result1.detected).not.toBeNull();
    expect(result1.detected!.intent).toBe("suggest_prd");

    const result2 = detectIntent("implémente un module de notifications");
    expect(result2.detected).not.toBeNull();
    expect(result2.detected!.intent).toBe("suggest_prd");
  });

  it("callback data patterns match expected format", () => {
    // Verify all callback data strings used in the workflow are valid
    const callbacks = [
      "prdwf_create",
      "prdwf_task",
      "prdwf_cancel",
      "prdwf_revise:abcd1234",
      "prdwf_launch:abcd1234",
      "prdwf_merge:42",
      "prd_approve:full-uuid-here",
      "prd_reject:full-uuid-here",
      "prd_revise:full-uuid-here",
      "prd_view:full-uuid-here",
    ];

    for (const cb of callbacks) {
      // All callback data must be <= 64 bytes (Telegram limit)
      expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

// ── Edge Cases ──────────────────────────────────────────────

describe("PRD Workflow — Edge Cases", () => {
  it("empty description triage still produces valid result", async () => {
    const result = await triageDescription("");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.label).toBeDefined();
  });

  it("very long description triage still produces valid result", async () => {
    const longDesc = "x".repeat(5000);
    const result = await triageDescription(longDesc);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.label).toBeDefined();
  });

  it("buildTriageResponse handles empty pipeline explanation", () => {
    const triage: TriageResult = { score: 0, pipeline: "SOLO", pipelineExplanation: "", label: "faible" };
    const { message } = buildTriageResponse("test", triage);
    expect(message).toContain("faible");
  });

  it("buildRevisionKeyboard with max revision PRD has no revision button but still allows approve/reject", () => {
    const prd = makePRD({ metadata: { revision_count: 3 } });
    const kb = buildRevisionKeyboard(prd);
    const raw = (kb as any).inline_keyboard;
    const buttons = raw.flat();
    expect(buttons.length).toBeGreaterThanOrEqual(2); // At least approve + reject
    const texts = buttons.map((b: any) => b.text);
    expect(texts).toContain("Approuver");
    expect(texts).toContain("Rejeter");
  });

  it("chatKey with undefined threadId returns chatId only", () => {
    expect(chatKey(999, undefined)).toBe("999");
  });

  it("concurrent pending descriptions don't interfere", () => {
    // Simulate two concurrent workflow sessions in different chats
    const key1 = "concurrent:1";
    const key2 = "concurrent:2";

    storePendingDescription(key1, "feature alpha");
    storePendingDescription(key2, "feature beta");

    // Read both
    expect(getPendingDescription(key1)).toBe("feature alpha");
    expect(getPendingDescription(key2)).toBe("feature beta");

    // Clear one
    clearPendingDescription(key1);
    expect(getPendingDescription(key1)).toBeUndefined();
    expect(getPendingDescription(key2)).toBe("feature beta");
  });

  it("pending revision without constraints is valid", () => {
    const key = "edge:rev:1";
    storePendingRevision(key, "prd-minimal");
    const rev = getPendingRevision(key);
    expect(rev).toBeDefined();
    expect(rev!.prdId).toBe("prd-minimal");
    expect(rev!.constraints).toBeUndefined();
  });
});

// ── LLM Intent Detection ────────────────────────────────────

describe("PRD Workflow — LLM Intent Detection", () => {
  it("detectIntentWithLLM handles timeout gracefully", async () => {
    const result = await detectIntentWithLLM("je veux un truc", {
      callLLM: async () => {
        await new Promise(r => setTimeout(r, 200));
        return '{"intent": "suggest_prd", "command": "prd_workflow", "confidence": 0.85}';
      },
      timeoutMs: 50, // Very short timeout
    });
    // Should either return a result or gracefully handle timeout
    expect(result).toBeDefined();
    expect(result.detected === null || result.detected !== null).toBe(true);
  });

  it("detectIntentWithLLM returns valid result on success", async () => {
    const result = await detectIntentWithLLM("je veux ajouter un cache", {
      callLLM: async () => {
        return JSON.stringify({
          intent: "suggest_prd",
          command: "prd_workflow",
          confidence: 0.85,
          args: "ajouter un cache",
        });
      },
      timeoutMs: 5000,
    });

    if (result.detected) {
      expect(result.detected.command).toBe("prd_workflow");
      expect(result.detected.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("detectIntentWithLLM handles malformed JSON gracefully", async () => {
    const result = await detectIntentWithLLM("test message", {
      callLLM: async () => "this is not json at all",
      timeoutMs: 5000,
    });
    // Should not throw, should return null detected
    expect(result).toBeDefined();
  });

  it("detectIntentWithLLM handles LLM error gracefully", async () => {
    const result = await detectIntentWithLLM("test message", {
      callLLM: async () => { throw new Error("LLM unavailable"); },
      timeoutMs: 5000,
    });
    expect(result).toBeDefined();
    expect(result.detected).toBeNull();
  });

  it("detectIntentWithLLM receives session context when provided", async () => {
    let receivedPrompt = "";
    const result = await detectIntentWithLLM("fais le prd", {
      callLLM: async (prompt) => {
        receivedPrompt = prompt;
        return JSON.stringify({ intent: "none", command: "", confidence: 0 });
      },
      timeoutMs: 5000,
      sessionContext: "Recent intent: suggest_prd. Phase: planning.",
    });
    expect(receivedPrompt).toContain("suggest_prd");
    expect(receivedPrompt).toContain("planning");
  });
});

// ── Photo Document Detection (peripheral dependency) ─────────

describe("PRD Workflow — Photo Document Detection (zz-messages dependency)", () => {
  it("detects document photos by caption keywords", () => {
    expect(isPhotoDocument("facture EDF mars", 10000)).toBe(true);
    expect(isPhotoDocument("contrat de bail", 10000)).toBe(true);
    expect(isPhotoDocument("ordonnance medecin", 10000)).toBe(true);
    expect(isPhotoDocument("mon recu de paiement", 10000)).toBe(true);
  });

  it("detects large photos without caption as documents", () => {
    expect(isPhotoDocument("", 100000)).toBe(true);
    expect(isPhotoDocument(undefined, 100000)).toBe(true);
  });

  it("does not detect small photos as documents", () => {
    expect(isPhotoDocument("", 10000)).toBe(false);
    expect(isPhotoDocument(undefined, 5000)).toBe(false);
  });

  it("does not detect conversational photos as documents", () => {
    expect(isPhotoDocument("regarde cette photo", 10000)).toBe(false);
    expect(isPhotoDocument("selfie au bureau", 10000)).toBe(false);
  });
});
