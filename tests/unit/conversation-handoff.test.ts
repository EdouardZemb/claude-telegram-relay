import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  assembleHandoffContext,
  formatHandoffForAgent,
  type HandoffSummary,
} from "../../src/conversation-handoff.ts";

describe("conversation-handoff", () => {
  // ── V10: assembleHandoffContext with decisions ──────────────

  describe("assembleHandoffContext", () => {
    it("V10: extracts decisions from messages with [DECIDE] markers", () => {
      const messages = [
        "user: On devrait utiliser un Composer separe",
        "assistant: Bonne idee. [DECIDE] Utiliser un Composer sdd-flow.ts separe",
        "user: Et pour la persistence ?",
        "assistant: [DECISION] Persistence disque avec atomic write",
      ];

      const summary = assembleHandoffContext(messages, { pipelineName: "test-pipeline" });

      expect(summary.decisions.length).toBeGreaterThanOrEqual(1);
      expect(summary.objective).toBe("test pipeline");
    });

    it("V10: extracts decisions from conversational patterns", () => {
      const messages = [
        "assistant: on fait un Composer separe pour les callbacks SDD",
        "user: ok parfait",
        "assistant: on choisit la persistence disque avec atomic write",
      ];

      const summary = assembleHandoffContext(messages, { pipelineName: "refactoring-memoire" });

      expect(summary.decisions.length).toBeGreaterThanOrEqual(1);
    });

    it("V11: returns empty arrays with objective when no patterns found", () => {
      const messages = [
        "user: Salut, comment ca va ?",
        "assistant: Bien merci ! Qu'est-ce que tu veux faire aujourd'hui ?",
      ];

      const summary = assembleHandoffContext(messages, { pipelineName: "test-pipeline" });

      expect(summary.objective).toBe("test pipeline");
      expect(summary.decisions).toEqual([]);
      expect(summary.constraints).toEqual([]);
      expect(summary.filesIdentified).toEqual([]);
      expect(summary.resolvedQuestions).toEqual([]);
      expect(summary.outOfScope).toEqual([]);
    });

    it("V11: defaults objective to 'conversation' when no pipeline name", () => {
      const summary = assembleHandoffContext([]);
      expect(summary.objective).toBe("conversation");
    });

    it("extracts constraints from messages", () => {
      const messages = [
        "user: [CONTRAINTE] Ne pas importer orchestrator",
        "assistant: Contrainte : pas d'appel LLM dans le callback",
      ];

      const summary = assembleHandoffContext(messages);
      expect(summary.constraints.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts file references from messages", () => {
      const messages = [
        "user: il faut modifier src/pipeline-tracker.ts et src/commands/sdd-flow.ts",
        "assistant: on ajoutera aussi tests/unit/pipeline-tracker.test.ts",
      ];

      const summary = assembleHandoffContext(messages);
      expect(summary.filesIdentified).toContain("src/pipeline-tracker.ts");
      expect(summary.filesIdentified).toContain("src/commands/sdd-flow.ts");
      expect(summary.filesIdentified).toContain("tests/unit/pipeline-tracker.test.ts");
    });

    it("extracts resolved questions", () => {
      const messages = ["assistant: [RESOLU] Le nommage sera en kebab-case"];

      const summary = assembleHandoffContext(messages);
      expect(summary.resolvedQuestions.length).toBeGreaterThanOrEqual(1);
    });

    it("extracts out-of-scope items", () => {
      const messages = [
        "assistant: [HORS SCOPE] La modification du system prompt",
        "user: ok on exclut le refactoring de zz-messages",
      ];

      const summary = assembleHandoffContext(messages);
      expect(summary.outOfScope.length).toBeGreaterThanOrEqual(1);
    });

    it("passes through exploration and spec references", () => {
      const summary = assembleHandoffContext([], {
        explorationRef: "docs/explorations/EXPLORE-test.md",
        specRef: "docs/specs/SPEC-test.md",
      });

      expect(summary.explorationRef).toBe("docs/explorations/EXPLORE-test.md");
      expect(summary.specRef).toBe("docs/specs/SPEC-test.md");
    });

    it("deduplicates extracted items", () => {
      const messages = [
        "assistant: on fait un Composer separe",
        "user: oui on fait un Composer separe",
      ];

      const summary = assembleHandoffContext(messages);
      // Should not have duplicates
      const unique = new Set(summary.decisions.map((d) => d.toLowerCase()));
      expect(unique.size).toBe(summary.decisions.length);
    });
  });

  // ── V12: formatHandoffForAgent ─────────────────────────────

  describe("formatHandoffForAgent", () => {
    it("V12: produces string with all required sections", () => {
      const summary: HandoffSummary = {
        objective: "refactoring memoire",
        decisions: ["Composer separe", "Persistence disque"],
        constraints: ["Pas d'appel LLM"],
        filesIdentified: ["src/pipeline-tracker.ts"],
        resolvedQuestions: ["Nommage en kebab-case"],
        outOfScope: ["System prompt"],
        explorationRef: "docs/explorations/EXPLORE-test.md",
        specRef: "docs/specs/SPEC-test.md",
      };

      const text = formatHandoffForAgent(summary);

      expect(text).toContain("Objectif:");
      expect(text).toContain("Decisions:");
      expect(text).toContain("Contraintes:");
      expect(text).toContain("Hors scope:");
      expect(text).toContain("refactoring memoire");
      expect(text).toContain("Composer separe");
      expect(text).toContain("Persistence disque");
      expect(text).toContain("Pas d'appel LLM");
      expect(text).toContain("src/pipeline-tracker.ts");
      expect(text).toContain("Nommage en kebab-case");
      expect(text).toContain("System prompt");
      expect(text).toContain("EXPLORE-test.md");
      expect(text).toContain("SPEC-test.md");
    });

    it("handles empty summary gracefully", () => {
      const summary: HandoffSummary = {
        objective: "test",
        decisions: [],
        constraints: [],
        filesIdentified: [],
        resolvedQuestions: [],
        outOfScope: [],
      };

      const text = formatHandoffForAgent(summary);

      expect(text).toContain("Objectif: test");
      expect(text).toContain("aucune");
      expect(text).toContain("Reference exploration: aucune");
      expect(text).toContain("Reference spec: aucune");
    });

    it("starts with the header", () => {
      const summary: HandoffSummary = {
        objective: "test",
        decisions: [],
        constraints: [],
        filesIdentified: [],
        resolvedQuestions: [],
        outOfScope: [],
      };

      const text = formatHandoffForAgent(summary);
      expect(text).toStartWith("RESUME DES DECISIONS CONVERSATIONNELLES");
    });
  });

  // ── V21: No forbidden imports ──────────────────────────────

  describe("import constraints", () => {
    it("V21: conversation-handoff.ts does not import from forbidden modules", async () => {
      const content = await readFile(
        join(import.meta.dir, "..", "..", "src", "conversation-handoff.ts"),
        "utf-8",
      );

      expect(content).not.toContain('from "./orchestrator');
      expect(content).not.toContain("from './orchestrator");
      expect(content).not.toContain('from "./blackboard');
      expect(content).not.toContain("from './blackboard");
      expect(content).not.toContain('from "./agent-schemas');
      expect(content).not.toContain("from './agent-schemas");
      expect(content).not.toContain('from "./pipeline-state');
      expect(content).not.toContain("from './pipeline-state");
      expect(content).not.toContain('from "./conversation-session');
      expect(content).not.toContain("from './conversation-session");
    });
  });
});
