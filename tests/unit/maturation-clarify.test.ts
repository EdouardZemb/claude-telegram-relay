import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  _setCallClaudeHookForTests,
  buildClarifierPrompt,
  checkMaturationClarify,
  handleClarifyResponse,
  parseClarifierResponse,
  startClarification,
} from "../../src/maturation/clarify.ts";
import { _setBaseDirForTests, initRun } from "../../src/maturation/documents.ts";
import {
  type ClarificationQA,
  createEmptyRun,
  type MaturationRun,
} from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-clarify");

describe("maturation/clarify", () => {
  beforeEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
    _setCallClaudeHookForTests(undefined);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    _setCallClaudeHookForTests(undefined);
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── buildClarifierPrompt ────────────────────────────────────

  describe("buildClarifierPrompt", () => {
    it("V1: includes raw input, understanding content, turn number, 'Aucune question posee encore' when no QA", () => {
      const prompt = buildClarifierPrompt(
        "Je veux un export CSV",
        "## Compréhension\nL'utilisateur veut exporter des données.",
        [],
        1,
      );

      expect(prompt).toContain("Je veux un export CSV");
      expect(prompt).toContain("## Compréhension\nL'utilisateur veut exporter des données.");
      expect(prompt).toContain("tour 1/5");
      expect(prompt).toContain("Aucune question posee encore");
    });

    it("V2: includes Q&A history formatted as Q1/R1", () => {
      const qaHistory: ClarificationQA[] = [
        {
          question: "Quel format de CSV ?",
          answer: "UTF-8 avec séparateur point-virgule",
          turn: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          question: "Quelles colonnes inclure ?",
          answer: "Toutes les colonnes visibles",
          turn: 2,
          timestamp: "2026-01-01T00:01:00.000Z",
        },
      ];

      const prompt = buildClarifierPrompt(
        "Je veux un export CSV",
        "Compréhension initiale",
        qaHistory,
        3,
      );

      expect(prompt).toContain("Q1: Quel format de CSV ?");
      expect(prompt).toContain("R1: UTF-8 avec séparateur point-virgule");
      expect(prompt).toContain("Q2: Quelles colonnes inclure ?");
      expect(prompt).toContain("R2: Toutes les colonnes visibles");
      expect(prompt).toContain("tour 3/5");
      // Should NOT contain "Aucune question posee encore"
      expect(prompt).not.toContain("Aucune question posee encore");
    });
  });

  // ── parseClarifierResponse ──────────────────────────────────

  describe("parseClarifierResponse", () => {
    it("V1: parses valid QUESTION JSON", () => {
      const json = JSON.stringify({
        status: "QUESTION",
        question: "Quel est le périmètre exact ?",
        ambiguityScore: 7,
        reasoning: "Le périmètre est flou",
      });

      const result = parseClarifierResponse(json);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("QUESTION");
      expect(result!.question).toBe("Quel est le périmètre exact ?");
      expect(result!.ambiguityScore).toBe(7);
      expect(result!.reasoning).toBe("Le périmètre est flou");
    });

    it("V2: parses valid DONE JSON", () => {
      const json = JSON.stringify({
        status: "DONE",
        question: "",
        ambiguityScore: 2,
        reasoning: "Suffisamment d'informations",
      });

      const result = parseClarifierResponse(json);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("DONE");
      expect(result!.ambiguityScore).toBe(2);
    });

    it("V3: extracts JSON from markdown code block", () => {
      const text = `Voici ma réponse :

\`\`\`json
{
  "status": "QUESTION",
  "question": "Combien d'utilisateurs ?",
  "ambiguityScore": 6,
  "reasoning": "La charge n'est pas définie"
}
\`\`\`

Bonne chance !`;

      const result = parseClarifierResponse(text);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("QUESTION");
      expect(result!.question).toBe("Combien d'utilisateurs ?");
      expect(result!.ambiguityScore).toBe(6);
    });

    it("V4: returns null for non-JSON", () => {
      const result = parseClarifierResponse("Bonjour, je ne suis pas du JSON du tout !");
      expect(result).toBeNull();
    });

    it("V5: returns null for missing required fields", () => {
      // Missing ambiguityScore
      const missingScore = JSON.stringify({
        status: "QUESTION",
        question: "Quelle est la contrainte ?",
        reasoning: "Flou",
      });
      expect(parseClarifierResponse(missingScore)).toBeNull();

      // Invalid status
      const invalidStatus = JSON.stringify({
        status: "MAYBE",
        question: "Quelle est la contrainte ?",
        ambiguityScore: 5,
        reasoning: "Flou",
      });
      expect(parseClarifierResponse(invalidStatus)).toBeNull();

      // QUESTION with empty question
      const emptyQuestion = JSON.stringify({
        status: "QUESTION",
        question: "",
        ambiguityScore: 5,
        reasoning: "Flou",
      });
      expect(parseClarifierResponse(emptyQuestion)).toBeNull();
    });
  });

  // ── checkMaturationClarify ──────────────────────────────────

  describe("checkMaturationClarify", () => {
    function makeRunWithPending(
      chatId: number,
      threadId?: number,
      phase: "clarify" | "explore" = "clarify",
      hasPending = true,
    ): MaturationRun {
      const run = createEmptyRun(chatId, threadId, "test", "input");
      run.currentPhase = phase;
      if (hasPending) {
        run.clarification = {
          questions: [],
          currentTurn: 1,
          maxTurns: 5,
          pendingQuestion: "Quel est le périmètre ?",
        };
      }
      return run;
    }

    it("V1: finds run with matching chatId and pending question", async () => {
      const run = makeRunWithPending(42, undefined);
      await initRun(run);

      const found = await checkMaturationClarify(42, undefined);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(run.id);
    });

    it("V2: returns null when no pending question", async () => {
      const run = makeRunWithPending(42, undefined, "clarify", false);
      await initRun(run);

      const found = await checkMaturationClarify(42, undefined);
      expect(found).toBeNull();
    });

    it("V3: returns null for different chatId", async () => {
      const run = makeRunWithPending(42, undefined);
      await initRun(run);

      const found = await checkMaturationClarify(99, undefined);
      expect(found).toBeNull();
    });

    it("V4: matches threadId correctly", async () => {
      const runA = makeRunWithPending(42, 10);
      const runB = makeRunWithPending(42, 20);
      await initRun(runA);
      await initRun(runB);

      const foundA = await checkMaturationClarify(42, 10);
      expect(foundA).not.toBeNull();
      expect(foundA!.id).toBe(runA.id);

      const foundB = await checkMaturationClarify(42, 20);
      expect(foundB).not.toBeNull();
      expect(foundB!.id).toBe(runB.id);

      // Non-matching threadId should return null
      const foundC = await checkMaturationClarify(42, 99);
      expect(foundC).toBeNull();
    });
  });

  // ── startClarification ──────────────────────────────────────

  describe("startClarification", () => {
    it("V1: returns question when clarifier responds QUESTION", async () => {
      const run = createEmptyRun(1, undefined, "test", "Je veux un export CSV");
      run.currentPhase = "clarify";
      await initRun(run);

      _setCallClaudeHookForTests(async () =>
        JSON.stringify({
          status: "QUESTION",
          question: "Pour quels utilisateurs ?",
          ambiguityScore: 7,
          reasoning: "Cible floue",
        }),
      );

      const result = await startClarification(run, async () => "");
      expect(result).not.toBeNull();
      expect(result!.question).toBe("Pour quels utilisateurs ?");
      expect(result!.ambiguityScore).toBe(7);
      expect(run.clarification?.pendingQuestion).toBe("Pour quels utilisateurs ?");
    });

    it("V2: returns null and skips clarify when clarifier responds DONE", async () => {
      const run = createEmptyRun(1, undefined, "test", "Export simple CSV");
      run.currentPhase = "clarify";
      await initRun(run);

      _setCallClaudeHookForTests(async () =>
        JSON.stringify({
          status: "DONE",
          question: "",
          ambiguityScore: 2,
          reasoning: "Suffisamment clair",
        }),
      );

      const result = await startClarification(run, async () => "");
      expect(result).toBeNull();
      expect(run.steps.clarify.status).toBe("skipped");
      expect(run.currentPhase).toBe("explore");
    });
  });

  // ── handleClarifyResponse ────────────────────────────────────

  describe("handleClarifyResponse", () => {
    it("V1: returns waiting with next question when more turns remain", async () => {
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      run.currentPhase = "clarify";
      run.clarification = {
        questions: [],
        currentTurn: 1,
        maxTurns: 5,
        pendingQuestion: "Pour qui ?",
      };
      await initRun(run);

      _setCallClaudeHookForTests(async () =>
        JSON.stringify({
          status: "QUESTION",
          question: "Quelle fréquence ?",
          ambiguityScore: 5,
          reasoning: "La fréquence est inconnue",
        }),
      );

      const result = await handleClarifyResponse(run, "Pour les admins", async () => "");
      expect(result.status).toBe("waiting");
      expect(result.question).toBe("Quelle fréquence ?");
      // Q&A stored
      expect(run.clarification!.questions).toHaveLength(1);
      expect(run.clarification!.questions[0].answer).toBe("Pour les admins");
    });

    it("V2: returns done with enrichedInput when clarifier responds DONE", async () => {
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      run.currentPhase = "clarify";
      run.clarification = {
        questions: [],
        currentTurn: 1,
        maxTurns: 5,
        pendingQuestion: "Pour qui ?",
      };
      await initRun(run);

      _setCallClaudeHookForTests(async () =>
        JSON.stringify({
          status: "DONE",
          question: "",
          ambiguityScore: 2,
          reasoning: "Clair maintenant",
        }),
      );

      const result = await handleClarifyResponse(run, "Pour les admins", async () => "");
      expect(result.status).toBe("done");
      expect(result.enrichedInput).toContain("Export CSV");
      expect(result.enrichedInput).toContain("Pour les admins");
      expect(run.steps.clarify.status).toBe("ok");
      expect(run.currentPhase).toBe("explore");
    });

    it("V3: finalizes after max turns even if still QUESTION", async () => {
      const run = createEmptyRun(1, undefined, "test", "Export CSV");
      run.currentPhase = "clarify";
      run.clarification = {
        questions: [],
        currentTurn: 5,
        maxTurns: 5,
        pendingQuestion: "Dernière question ?",
      };
      await initRun(run);

      _setCallClaudeHookForTests(async () =>
        JSON.stringify({
          status: "QUESTION",
          question: "Encore une question ?",
          ambiguityScore: 4,
          reasoning: "Pas encore fini",
        }),
      );

      const result = await handleClarifyResponse(run, "Réponse finale", async () => "");
      expect(result.status).toBe("done");
      expect(run.currentPhase).toBe("explore");
    });
  });
});
