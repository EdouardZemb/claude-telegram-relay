import { describe, expect, it } from "bun:test";
import {
  buildMaturationStatusBar,
  buildValidationKeyboard,
  formatRunSummary,
  parseIdeaCommand,
} from "../../src/commands/maturation.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

describe("commands/maturation", () => {
  describe("parseIdeaCommand", () => {
    it("V1: extracts description", () => {
      expect(parseIdeaCommand("/idea Export CSV des taches")).toBe("Export CSV des taches");
    });
    it("V2: returns null for empty", () => {
      expect(parseIdeaCommand("/idea")).toBeNull();
      expect(parseIdeaCommand("/idea   ")).toBeNull();
    });
    it("V3: returns null for non-idea command", () => {
      expect(parseIdeaCommand("/task something")).toBeNull();
    });
    it("V4: handles multi-word description", () => {
      expect(parseIdeaCommand("/idea Ajouter un export CSV avec filtres")).toBe(
        "Ajouter un export CSV avec filtres",
      );
    });
  });

  describe("buildValidationKeyboard", () => {
    it("V1: builds 3-button keyboard", () => {
      const kb = buildValidationKeyboard("test-id");
      const buttons = kb.inline_keyboard.flat();
      expect(buttons.length).toBe(3);
      expect(buttons[0].callback_data).toBe("mat_validate:test-id");
      expect(buttons[1].callback_data).toBe("mat_modify:test-id");
      expect(buttons[2].callback_data).toBe("mat_reject:test-id");
    });

    it("V2: uses provided runId in callback data", () => {
      const kb = buildValidationKeyboard("abc-123-xyz");
      const buttons = kb.inline_keyboard.flat();
      expect(buttons[0].callback_data).toBe("mat_validate:abc-123-xyz");
      expect(buttons[2].callback_data).toBe("mat_reject:abc-123-xyz");
    });
  });

  describe("buildMaturationStatusBar", () => {
    it("V1: shows all phases with symbols", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.steps.understand.status = "ok";
      run.steps.clarify.status = "skipped";
      run.steps.explore.status = "running";
      const bar = buildMaturationStatusBar(run);
      expect(bar).toContain("Comprehension");
      expect(bar).toContain("Exploration");
      // Check symbols are present
      expect(bar).toContain("\u25CF"); // ok
      expect(bar).toContain("\u25D4"); // running
    });

    it("V2: includes iteration count", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      run.iteration = 1;
      const bar = buildMaturationStatusBar(run);
      expect(bar).toContain("iteration 1");
    });

    it("V3: pending phases show pending symbol", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      const bar = buildMaturationStatusBar(run);
      expect(bar).toContain("\u25CB"); // pending ○
    });

    it("V4: does not include iteration count when iteration=0", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      expect(run.iteration).toBe(0);
      const bar = buildMaturationStatusBar(run);
      expect(bar).not.toContain("iteration");
    });

    it("V5: all phase labels appear in bar", () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      const bar = buildMaturationStatusBar(run);
      expect(bar).toContain("Comprehension");
      expect(bar).toContain("Clarification");
      expect(bar).toContain("Exploration");
      expect(bar).toContain("Confrontation");
      expect(bar).toContain("Synthese");
      expect(bar).toContain("Avocat du diable");
      expect(bar).toContain("Validation");
    });
  });

  describe("formatRunSummary", () => {
    it("V1: includes name and input", () => {
      const run = createEmptyRun(1, undefined, "test-idea", "Export CSV");
      const summary = formatRunSummary(run);
      expect(summary).toContain("test-idea");
      expect(summary).toContain("Export CSV");
    });

    it("V2: includes status bar", () => {
      const run = createEmptyRun(1, undefined, "test-idea", "Export CSV");
      const summary = formatRunSummary(run);
      expect(summary).toContain("Comprehension");
    });

    it("V3: shows verdict for completed phases", () => {
      const run = createEmptyRun(1, undefined, "test-idea", "Export CSV");
      run.steps.understand.status = "ok";
      run.steps.understand.verdict = "ambiguity:3";
      const summary = formatRunSummary(run);
      expect(summary).toContain("ambiguity:3");
    });

    it("V4: skips pending phases in detail section", () => {
      const run = createEmptyRun(1, undefined, "my-idea", "Some input");
      const summary = formatRunSummary(run);
      // All phases pending — should not show phase details (only status bar line)
      // The Clarification label appears in the status bar but not as a bold item
      const boldMatches = summary.match(/<b>Clarification<\/b>/g);
      expect(boldMatches).toBeNull();
    });
  });
});
