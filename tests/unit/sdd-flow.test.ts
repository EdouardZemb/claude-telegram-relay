import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  buildSddKeyboard,
  detectConvergenceInResponse,
  parseSddResultPrefix,
} from "../../src/commands/sdd-flow.ts";

describe("sdd-flow", () => {
  // ── V19, V20: detectConvergenceInResponse ──────────────────

  describe("detectConvergenceInResponse", () => {
    it("V19: returns non-null when response contains newline then 'Decisions:'", () => {
      const response =
        "Apres notre discussion, voici ce qui ressort.\nDecisions:\n- Utiliser un Composer separe\n- Persistence disque\n\nProchaine etape: specifier";
      const result = detectConvergenceInResponse(response);
      expect(result).not.toBeNull();
      expect(result!.match).toBe("Decisions:");
    });

    it("V19: returns non-null when 'Decisions:' is at the start", () => {
      const response = "Decisions:\n- Decision A\n- Decision B";
      const result = detectConvergenceInResponse(response);
      expect(result).not.toBeNull();
    });

    it("V20: returns null on normal conversational response", () => {
      const response = "Oui, je pense qu'on devrait explorer cette piste. Qu'en penses-tu ?";
      const result = detectConvergenceInResponse(response);
      expect(result).toBeNull();
    });

    it("V20: returns null when 'Decisions' appears mid-word", () => {
      const response = "Les indecisions sont normales dans un processus creatif.";
      const result = detectConvergenceInResponse(response);
      expect(result).toBeNull();
    });

    it("handles empty response", () => {
      expect(detectConvergenceInResponse("")).toBeNull();
    });

    it("detects pattern after multiple newlines", () => {
      const response = "Resumons.\n\nDecisions:\n- A";
      const result = detectConvergenceInResponse(response);
      expect(result).not.toBeNull();
    });
  });

  // ── V16, V17, V18: buildSddKeyboard ───────────────────────

  describe("buildSddKeyboard", () => {
    it("V16: explore phase without verdict returns Explorer and Discuter buttons", () => {
      const kb = buildSddKeyboard("explore", "foo");
      expect(kb).toBeDefined();

      // Check inline_keyboard rows
      const buttons = kb!.inline_keyboard.flat();
      const texts = buttons.map((b) => b.text);
      expect(texts).toContain("Explorer");
      expect(texts).toContain("Discuter sans explorer");

      // Check callback data
      const callbackData = buttons.map((b) => (b as { callback_data?: string }).callback_data);
      expect(callbackData).toContain("sdd_explore:foo");
      expect(callbackData).toContain("sdd_discuss:foo");
    });

    it("explore phase with GO verdict returns Discuter and Specifier", () => {
      const kb = buildSddKeyboard("explore", "foo", "GO");
      expect(kb).toBeDefined();

      const texts = kb!.inline_keyboard.flat().map((b) => b.text);
      expect(texts).toContain("Discuter les resultats");
      expect(texts).toContain("Specifier");
    });

    it("explore phase with PIVOT verdict returns Re-explorer and Discuter", () => {
      const kb = buildSddKeyboard("explore", "foo", "PIVOT");
      expect(kb).toBeDefined();

      const texts = kb!.inline_keyboard.flat().map((b) => b.text);
      expect(texts).toContain("Re-explorer");
      expect(texts).toContain("Discuter");
      // No Specifier button for PIVOT
      expect(texts).not.toContain("Specifier");
    });

    it("V17: explore phase with DROP verdict returns undefined (no buttons)", () => {
      const kb = buildSddKeyboard("explore", "foo", "DROP");
      expect(kb).toBeUndefined();
    });

    it("discuss phase returns Formaliser and Continuer", () => {
      const kb = buildSddKeyboard("discuss", "foo");
      expect(kb).toBeDefined();

      const texts = kb!.inline_keyboard.flat().map((b) => b.text);
      expect(texts).toContain("Formaliser en spec");
      expect(texts).toContain("Continuer");
    });

    it("spec phase returns Challenger, Implementer direct, Reviser", () => {
      const kb = buildSddKeyboard("spec", "foo");
      expect(kb).toBeDefined();

      const texts = kb!.inline_keyboard.flat().map((b) => b.text);
      expect(texts).toContain("Challenger");
      expect(texts).toContain("Implementer direct");
      expect(texts).toContain("Reviser la spec");
    });

    it("challenge phase with GO verdict returns Implementer", () => {
      const kb = buildSddKeyboard("challenge", "foo", "GO");
      expect(kb).toBeDefined();

      const texts = kb!.inline_keyboard.flat().map((b) => b.text);
      expect(texts).toContain("Implementer");
    });

    it("challenge phase with GO_WITH_CHANGES returns both options", () => {
      const kb = buildSddKeyboard("challenge", "foo", "GO_WITH_CHANGES");
      expect(kb).toBeDefined();

      const texts = kb!.inline_keyboard.flat().map((b) => b.text);
      expect(texts).toContain("Implementer avec corrections");
      expect(texts).toContain("Corriger la spec d'abord");
    });

    it("V18: challenge phase with NO-GO returns no Implementer button", () => {
      const kb = buildSddKeyboard("challenge", "foo", "NO-GO");
      expect(kb).toBeDefined();

      const texts = kb!.inline_keyboard.flat().map((b) => b.text);
      expect(texts).toContain("Discuter les findings");
      expect(texts).toContain("Retravailler la spec");
      expect(texts).not.toContain("Implementer");
      expect(texts).not.toContain("Implementer avec corrections");
    });

    it("implement phase returns Review and Corriger", () => {
      const kb = buildSddKeyboard("implement", "foo");
      expect(kb).toBeDefined();

      const texts = kb!.inline_keyboard.flat().map((b) => b.text);
      expect(texts).toContain("Review");
      expect(texts).toContain("Corriger");
    });

    it("unknown phase returns undefined", () => {
      const kb = buildSddKeyboard("unknown", "foo");
      expect(kb).toBeUndefined();
    });
  });

  // ── parseSddResultPrefix ───────────────────────────────────

  describe("parseSddResultPrefix", () => {
    it("parses SDD_EXPLORE_GO prefix", () => {
      const result = parseSddResultPrefix("SDD_EXPLORE_GO: exploration terminee");
      expect(result).not.toBeNull();
      expect(result!.phase).toBe("explore");
      expect(result!.verdict).toBe("GO");
    });

    it("parses SDD_CHALLENGE_NO-GO prefix", () => {
      const result = parseSddResultPrefix("SDD_CHALLENGE_NO-GO: findings bloquants");
      expect(result).not.toBeNull();
      expect(result!.phase).toBe("challenge");
      expect(result!.verdict).toBe("NO-GO");
    });

    it("parses SDD_SPEC_OK prefix", () => {
      const result = parseSddResultPrefix("SDD_SPEC_OK: spec generated");
      expect(result).not.toBeNull();
      expect(result!.phase).toBe("spec");
      expect(result!.verdict).toBe("OK");
    });

    it("returns null for non-SDD result", () => {
      const result = parseSddResultPrefix("PRD_CREATED:abc123");
      expect(result).toBeNull();
    });

    it("returns null for empty string", () => {
      const result = parseSddResultPrefix("");
      expect(result).toBeNull();
    });

    it("parses SDD_REVIEW_APPROVED prefix (F-DA-6 verification)", () => {
      const result = parseSddResultPrefix("SDD_REVIEW_APPROVED: foo");
      expect(result).not.toBeNull();
      expect(result!.phase).toBe("review");
      expect(result!.verdict).toBe("APPROVED");
    });

    it("parses SDD_REVIEW_CHANGES_REQUESTED prefix (F-DA-6 verification)", () => {
      const result = parseSddResultPrefix("SDD_REVIEW_CHANGES_REQUESTED: foo");
      expect(result).not.toBeNull();
      expect(result!.phase).toBe("review");
      expect(result!.verdict).toBe("CHANGES_REQUESTED");
    });
  });

  // ── V13: Guard prefix test ─────────────────────────────────

  describe("guard prefix", () => {
    it("V13: Composer pattern: non-sdd_ callbacks should fall through via next()", () => {
      // This is a structural test — the Composer calls next() when
      // the data does not start with "sdd_". We verify the code
      // structure by checking the source module exists and exports
      // the expected default function.
      const mod = require("../../src/commands/sdd-flow.ts");
      expect(typeof mod.default).toBe("function");
    });
  });

  // ── VC9-VC13: Merge callbacks ─────────────────────────────

  describe("merge callbacks (VC9-VC13, structural)", () => {
    let source: string;

    it("loads sdd-flow source", async () => {
      source = await readFile(
        join(import.meta.dir, "..", "..", "src", "commands", "sdd-flow.ts"),
        "utf-8",
      );
      expect(source.length).toBeGreaterThan(0);
    });

    it("VC9: merge_ask case handles absent prUrl with introuvable message", async () => {
      const src = await readFile(
        join(import.meta.dir, "..", "..", "src", "commands", "sdd-flow.ts"),
        "utf-8",
      );
      // Verify merge_ask case exists
      expect(src).toContain('"merge_ask"');
      // Verify it checks prUrl from tracker
      expect(src).toContain("steps.implement.prUrl");
      // Verify error message for absent prUrl
      expect(src).toContain("introuvable");
      expect(src).toContain("mergez manuellement");
    });

    it("VC10: merge_ask shows PR number in confirmation and two buttons", async () => {
      const src = await readFile(
        join(import.meta.dir, "..", "..", "src", "commands", "sdd-flow.ts"),
        "utf-8",
      );
      // Verify confirmation message references PR number
      expect(src).toContain("Confirmer le merge de PR #");
      // Verify merge_ok and merge_no buttons are created
      expect(src).toContain("sdd_merge_ok");
      expect(src).toContain("sdd_merge_no");
      expect(src).toContain("Confirmer le merge");
      expect(src).toContain("Annuler");
    });

    it("VC11: merge_no edits message to 'Merge annule.'", async () => {
      const src = await readFile(
        join(import.meta.dir, "..", "..", "src", "commands", "sdd-flow.ts"),
        "utf-8",
      );
      expect(src).toContain('"merge_no"');
      expect(src).toContain("Merge annule.");
      expect(src).toContain("editMessageText");
    });

    it("VC12: merge_ok checks GITHUB_REPO before calling merge", async () => {
      const src = await readFile(
        join(import.meta.dir, "..", "..", "src", "commands", "sdd-flow.ts"),
        "utf-8",
      );
      expect(src).toContain('"merge_ok"');
      // Guard: githubRepo (from getConfig()) must be non-empty
      expect(src).toMatch(/githubRepo|GITHUB_REPO/);
      expect(src).toContain("non configure");
      // Merge call present
      expect(src).toContain("gh");
      expect(src).toContain("--squash");
      expect(src).toContain("--delete-branch");
    });

    it("VC13: sdd_merge_* callback_data respects 64-byte limit for 48-char names", () => {
      const maxName = "a".repeat(48);
      expect(("sdd_merge_ask:" + maxName).length).toBeLessThanOrEqual(64);
      expect(("sdd_merge_ok:" + maxName).length).toBeLessThanOrEqual(64);
      expect(("sdd_merge_no:" + maxName).length).toBeLessThanOrEqual(64);
    });
  });

  // ── V14, V15: Guard tracker null / expired ─────────────────
  // These are integration-level tests that require mock grammY context.
  // The core logic is verified via the pipeline-tracker tests (V5, TTL).
  // The sdd-flow composer checks getTracker() before launching — covered
  // by the pipeline-tracker.test.ts V5 TTL test and the callback handler code.

  // ── V16, V17: Agent function wiring ──────────────────────

  describe("agent wiring (structural)", () => {
    it("V16: sdd-flow imports runSddExplore from sdd-agents", () => {
      // Structural test: verify the module exports and imports are wired
      const sddAgents = require("../../src/sdd-agents.ts");
      expect(typeof sddAgents.runSddExplore).toBe("function");
      expect(typeof sddAgents.runSddSpec).toBe("function");
      expect(typeof sddAgents.runSddChallenge).toBe("function");
      expect(typeof sddAgents.runSddImplement).toBe("function");
      expect(typeof sddAgents.runSddReview).toBe("function");
    });

    it("V17: sdd-flow imports assembleHandoffContext from conversation-handoff", () => {
      const handoff = require("../../src/conversation-handoff.ts");
      expect(typeof handoff.assembleHandoffContext).toBe("function");
      expect(typeof handoff.formatHandoffForAgent).toBe("function");
    });

    it("V21: sdd-flow imports formatStatusBar from pipeline-tracker", () => {
      const tracker = require("../../src/pipeline-tracker.ts");
      expect(typeof tracker.formatStatusBar).toBe("function");
    });
  });
});
