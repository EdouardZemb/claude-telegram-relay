import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  _setCallClaudeHookForTests,
  buildCheckpointKeyboard,
  checkMaturationCheckpoint,
  extractDecisionPoints,
  handleCheckpointResponse,
  loadGlobalDecisions,
  parseAdvisorResponse,
  saveGlobalDecision,
  startCheckpoint,
} from "../../src/maturation/checkpoint.ts";
import { _setBaseDirForTests, initRun } from "../../src/maturation/documents.ts";
import type { GlobalDecision, MaturationRun } from "../../src/maturation/types.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-checkpoint");

describe("maturation/checkpoint", () => {
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

  // ── extractDecisionPoints ────────────────────────────────────

  describe("extractDecisionPoints", () => {
    it("V1: extracts from 'Questions ouvertes' section with numbered items", () => {
      const output = `## Synthèse

Voici un résumé de la spec.

## Questions ouvertes

1. Faut-il utiliser PostgreSQL ou SQLite ?
2. Quelle stratégie de cache adopter ?
3. Comment gérer la concurrence ?

## Conclusion

Tout semble bon.`;

      const points = extractDecisionPoints(output, "synthesize");
      expect(points).toHaveLength(3);
      expect(points[0]).toContain("PostgreSQL ou SQLite");
      expect(points[1]).toContain("cache");
      expect(points[2]).toContain("concurrence");
    });

    it("V2: extracts from 'Decisions bloquantes' section", () => {
      const output = `## Résumé

Spec presque prête.

## Décisions bloquantes

1. Architecture microservices ou monolithe ?
2. Authentification JWT ou sessions ?

## Prochaines étapes

Avancer.`;

      const points = extractDecisionPoints(output, "synthesize");
      expect(points).toHaveLength(2);
      expect(points[0]).toContain("microservices");
      expect(points[1]).toContain("JWT");
    });

    it("V3: extracts showstopper from advocate output", () => {
      const output = `## Analyse

J'ai examiné la spec en détail.

## Verdict

**SHOWSTOPPER** : Faille de sécurité critique dans la gestion des tokens.

Cela doit être résolu avant tout.`;

      const points = extractDecisionPoints(output, "advocate");
      expect(points).toHaveLength(1);
      expect(points[0]).toContain("sécurité");
    });

    it("V4: empty array when no decisions in synthesize", () => {
      const output = `## Synthèse

Tout est clair, aucune ambiguïté.

## Conclusion

La spec est complète.`;

      const points = extractDecisionPoints(output, "synthesize");
      expect(points).toEqual([]);
    });

    it("V5: empty for advocate PASS verdict (no showstopper)", () => {
      const output = `## Verdict

**PASS** : Aucun problème bloquant identifié. La spec est solide.

Quelques suggestions mineures mais rien de bloquant.`;

      const points = extractDecisionPoints(output, "advocate");
      expect(points).toEqual([]);
    });
  });

  // ── parseAdvisorResponse ─────────────────────────────────────

  describe("parseAdvisorResponse", () => {
    it("V1: parses valid JSON", () => {
      const json = JSON.stringify({
        summary: "Choix d'architecture à faire",
        options: ["Option A : microservices", "Option B : monolithe"],
        recommendation: "CONTINUE",
        tags: ["architecture"],
      });

      const result = parseAdvisorResponse(json);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Choix d'architecture à faire");
      expect(result!.options).toHaveLength(2);
      expect(result!.recommendation).toBe("CONTINUE");
      expect(result!.tags).toContain("architecture");
    });

    it("V2: parses JSON in markdown code block", () => {
      const text = `Voici mon analyse :

\`\`\`json
{
  "summary": "Décision critique sur l'authentification",
  "options": ["JWT stateless", "Sessions Redis", "OAuth2 externe"],
  "recommendation": "RE-EXPLORE",
  "tags": ["sécurité", "authentification"]
}
\`\`\`

Bonne continuation !`;

      const result = parseAdvisorResponse(text);
      expect(result).not.toBeNull();
      expect(result!.recommendation).toBe("RE-EXPLORE");
      expect(result!.options).toHaveLength(3);
      expect(result!.tags).toContain("sécurité");
    });

    it("V3: returns null for invalid JSON", () => {
      const result = parseAdvisorResponse("Ceci n'est pas du JSON du tout !");
      expect(result).toBeNull();
    });

    it("V4: returns null for missing fields", () => {
      // Missing options
      const missingOptions = JSON.stringify({
        summary: "Un résumé",
        recommendation: "CONTINUE",
        tags: [],
      });
      expect(parseAdvisorResponse(missingOptions)).toBeNull();

      // Empty options array
      const emptyOptions = JSON.stringify({
        summary: "Un résumé",
        options: [],
        recommendation: "CONTINUE",
        tags: [],
      });
      expect(parseAdvisorResponse(emptyOptions)).toBeNull();

      // Invalid recommendation
      const invalidRec = JSON.stringify({
        summary: "Un résumé",
        options: ["Option A"],
        recommendation: "MAYBE",
        tags: [],
      });
      expect(parseAdvisorResponse(invalidRec)).toBeNull();

      // Missing summary
      const missingSummary = JSON.stringify({
        options: ["Option A"],
        recommendation: "CONTINUE",
        tags: [],
      });
      expect(parseAdvisorResponse(missingSummary)).toBeNull();
    });
  });

  // ── buildCheckpointKeyboard ──────────────────────────────────

  describe("buildCheckpointKeyboard", () => {
    it("V1: generates options buttons + Autre button with correct callback data", () => {
      const runId = "run-abc-123";
      const options = ["Continuer avec microservices", "Choisir le monolithe"];
      const kb = buildCheckpointKeyboard(runId, options);

      // InlineKeyboard serializes to inline_keyboard array
      const rows = kb.inline_keyboard;
      // We have 2 options (each on its own row) + 1 final row for Autre
      expect(rows).toHaveLength(3);

      // First option button
      expect(rows[0][0].text).toBe("Continuer avec microservices");
      expect(rows[0][0].callback_data).toBe(`mat_cp_opt:${runId}:0`);

      // Second option button
      expect(rows[1][0].text).toBe("Choisir le monolithe");
      expect(rows[1][0].callback_data).toBe(`mat_cp_opt:${runId}:1`);

      // Autre button
      expect(rows[2][0].text).toBe("Autre (texte libre)");
      expect(rows[2][0].callback_data).toBe(`mat_cp_other:${runId}`);
    });

    it("V2: handles 3 options (4 buttons total including Autre)", () => {
      const runId = "run-xyz-789";
      const options = ["Option A", "Option B", "Option C"];
      const kb = buildCheckpointKeyboard(runId, options);

      const rows = kb.inline_keyboard;
      // 3 options + 1 Autre = 4 rows
      expect(rows).toHaveLength(4);

      // Check all option indices
      expect(rows[0][0].callback_data).toBe(`mat_cp_opt:${runId}:0`);
      expect(rows[1][0].callback_data).toBe(`mat_cp_opt:${runId}:1`);
      expect(rows[2][0].callback_data).toBe(`mat_cp_opt:${runId}:2`);

      // Autre button last
      expect(rows[3][0].callback_data).toBe(`mat_cp_other:${runId}`);
    });

    it("V3: truncates long option labels to 40 chars", () => {
      const runId = "run-trunc";
      const longOption =
        "Ceci est une option très longue qui dépasse largement quarante caractères";
      const kb = buildCheckpointKeyboard(runId, [longOption]);

      const rows = kb.inline_keyboard;
      const label = rows[0][0].text;
      expect(label.length).toBeLessThanOrEqual(40);
      expect(label).toContain("...");
    });
  });

  // ── checkMaturationCheckpoint ────────────────────────────────

  describe("checkMaturationCheckpoint", () => {
    function makeRunWithCheckpoint(chatId: number, threadId?: number): MaturationRun {
      const run = createEmptyRun(chatId, threadId, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-1",
        source: "synthesize",
        summary: "Décision à prendre",
        options: ["Option A", "Option B"],
        recommendation: "CONTINUE",
        tags: [],
      };
      return run;
    }

    it("V1: finds run with pending checkpoint", async () => {
      const run = makeRunWithCheckpoint(42, undefined);
      await initRun(run);

      const found = await checkMaturationCheckpoint(42, undefined);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(run.id);
      expect(found!.pendingCheckpoint).not.toBeUndefined();
    });

    it("V2: null when no pending checkpoint", async () => {
      const run = createEmptyRun(42, undefined, "test", "input");
      // No pendingCheckpoint set
      await initRun(run);

      const found = await checkMaturationCheckpoint(42, undefined);
      expect(found).toBeNull();
    });

    it("V3: null for different chatId", async () => {
      const run = makeRunWithCheckpoint(42, undefined);
      await initRun(run);

      const found = await checkMaturationCheckpoint(99, undefined);
      expect(found).toBeNull();
    });
  });

  // ── handleCheckpointResponse ─────────────────────────────────

  describe("handleCheckpointResponse", () => {
    it("V1: resolves checkpoint, returns action, clears pendingCheckpoint, adds to resolvedCheckpoints", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-test-1",
        source: "synthesize",
        summary: "Choix d'architecture",
        options: ["Microservices", "Monolithe"],
        recommendation: "CONTINUE",
        tags: ["architecture"],
      };
      await initRun(run);

      const result = await handleCheckpointResponse(run, "Microservices");

      expect(result.action).toBe("CONTINUE");
      expect(run.pendingCheckpoint).toBeUndefined();
      expect(run.resolvedCheckpoints).toHaveLength(1);
      expect(run.resolvedCheckpoints![0].userChoice).toBe("Microservices");
      expect(run.resolvedCheckpoints![0].resolvedAt).not.toBeUndefined();
    });

    it("V2: returns RE-EXPLORE when checkpoint recommendation is RE-EXPLORE", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.pendingCheckpoint = {
        id: "cp-test-2",
        source: "advocate",
        summary: "Problème fondamental identifié",
        options: ["Revoir la spec", "Continuer quand même"],
        recommendation: "RE-EXPLORE",
        tags: ["blocage"],
      };
      await initRun(run);

      const result = await handleCheckpointResponse(run, "Revoir la spec");

      expect(result.action).toBe("RE-EXPLORE");
      expect(run.pendingCheckpoint).toBeUndefined();
      expect(run.resolvedCheckpoints).toHaveLength(1);
    });
  });

  // ── loadGlobalDecisions / saveGlobalDecision ─────────────────

  describe("loadGlobalDecisions / saveGlobalDecision", () => {
    function makeDecision(id: string, tags: string[] = []): GlobalDecision {
      return {
        id,
        runId: "run-1",
        runName: "test-run",
        source: "synthesize",
        summary: `Decision ${id}`,
        userChoice: "Option A",
        timestamp: new Date().toISOString(),
        tags,
      };
    }

    it("V1: saves and loads a decision", async () => {
      const decision = makeDecision("d1", ["architecture"]);
      await saveGlobalDecision(decision);

      const loaded = await loadGlobalDecisions();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("d1");
      expect(loaded[0].summary).toBe("Decision d1");
    });

    it("V2: filters by tags", async () => {
      await saveGlobalDecision(makeDecision("d1", ["architecture", "performance"]));
      await saveGlobalDecision(makeDecision("d2", ["sécurité"]));
      await saveGlobalDecision(makeDecision("d3", ["architecture"]));

      const architectureDecisions = await loadGlobalDecisions(["architecture"]);
      expect(architectureDecisions).toHaveLength(2);
      const ids = architectureDecisions.map((d) => d.id);
      expect(ids).toContain("d1");
      expect(ids).toContain("d3");
      expect(ids).not.toContain("d2");

      const securityDecisions = await loadGlobalDecisions(["sécurité"]);
      expect(securityDecisions).toHaveLength(1);
      expect(securityDecisions[0].id).toBe("d2");
    });

    it("V3: returns empty array if no file exists", async () => {
      // No decisions written
      const loaded = await loadGlobalDecisions();
      expect(loaded).toEqual([]);
    });

    it("V4: caps at 50 entries, pruning oldest on write", async () => {
      // Write 55 decisions
      for (let i = 0; i < 55; i++) {
        await saveGlobalDecision(makeDecision(`d${i}`, []));
      }

      const loaded = await loadGlobalDecisions();
      expect(loaded).toHaveLength(50);

      // The oldest (d0..d4) should have been pruned
      const ids = loaded.map((d) => d.id);
      expect(ids).not.toContain("d0");
      expect(ids).not.toContain("d4");
      // The newest should be present
      expect(ids).toContain("d54");
    });
  });

  // ── startCheckpoint integration ──────────────────────────────

  describe("startCheckpoint", () => {
    it("V1: returns null when no decision points found", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);

      const output = "Tout est clair, aucune décision bloquante.";
      const result = await startCheckpoint(run, output, "synthesize", async () => "");

      expect(result).toBeNull();
      expect(run.pendingCheckpoint).toBeUndefined();
    });

    it("V2: sets pendingCheckpoint when decisions found and advisor responds", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);

      _setCallClaudeHookForTests(async () =>
        JSON.stringify({
          summary: "Choix de base de données",
          options: ["PostgreSQL", "SQLite"],
          recommendation: "CONTINUE",
          tags: ["architecture"],
        }),
      );

      const output = `## Questions ouvertes

1. Quelle base de données utiliser ?
2. Faut-il du caching ?`;

      const result = await startCheckpoint(run, output, "synthesize", async () => "");

      expect(result).not.toBeNull();
      expect(result!.source).toBe("synthesize");
      expect(result!.summary).toBe("Choix de base de données");
      expect(run.pendingCheckpoint).not.toBeUndefined();
    });

    it("V3: falls back to awaitingFreeText when advisor parse fails", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);

      _setCallClaudeHookForTests(async () => "Je ne sais pas quoi répondre en JSON.");

      const output = `## Questions ouvertes

1. Architecture à choisir ?`;

      const result = await startCheckpoint(run, output, "synthesize", async () => "");

      expect(result).not.toBeNull();
      expect(result!.awaitingFreeText).toBe(true);
      expect(run.pendingCheckpoint).not.toBeUndefined();
    });
  });
});
