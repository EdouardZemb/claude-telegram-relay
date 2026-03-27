import { describe, expect, it } from "bun:test";
import {
  buildPhasePrompt,
  getAgentConfig,
  MATURATION_AGENT_ROLES,
} from "../../src/maturation/agents.ts";

describe("maturation/agents", () => {
  describe("MATURATION_AGENT_ROLES", () => {
    it("V1: has 9 agent roles", () => {
      expect(Object.keys(MATURATION_AGENT_ROLES).length).toBe(9);
    });

    it("V2: each role maps to a valid agent file", () => {
      for (const [, config] of Object.entries(MATURATION_AGENT_ROLES)) {
        expect(config.agentFile).toMatch(/^maturation-.*\.md$/);
        expect(config.outputDoc).toBeTruthy();
      }
    });
  });

  describe("getAgentConfig", () => {
    it("V1: returns config for understander", () => {
      const cfg = getAgentConfig("understander");
      expect(cfg).not.toBeNull();
      expect(cfg!.agentFile).toBe("maturation-understander.md");
      expect(cfg!.outputDoc).toBe("UNDERSTANDING");
    });

    it("V2: returns null for unknown role", () => {
      expect(getAgentConfig("unknown")).toBeNull();
    });
  });

  describe("buildPhasePrompt", () => {
    it("V1: builds understand prompt with raw input", () => {
      const prompt = buildPhasePrompt("understander", {
        rawInput: "Je veux un export CSV",
        runDir: "/tmp/test-run",
        documents: {},
      });
      expect(prompt).toContain("Je veux un export CSV");
      expect(prompt).toContain("UNDERSTANDING.md");
    });

    it("V2: includes prior documents with XML tags", () => {
      const prompt = buildPhasePrompt("expander", {
        rawInput: "export CSV",
        runDir: "/tmp/test-run",
        documents: { UNDERSTANDING: "# Understanding\n\nExport tasks." },
      });
      expect(prompt).toContain('<document name="UNDERSTANDING">');
      expect(prompt).toContain("Export tasks.");
      expect(prompt).toContain("EXPAND.md");
    });

    it("V3: adds double-pass instruction for critics", () => {
      const prompt = buildPhasePrompt("tech-critic", {
        rawInput: "test",
        runDir: "/tmp",
        documents: { UNDERSTANDING: "# U", EXPAND: "# E", RESEARCH: "# R", ANALOGIES: "# A" },
      });
      expect(prompt).toContain("Double-pass required");
      expect(prompt).toContain("CRITIQUE-TECH.md");
    });

    it("V4: returns empty string for unknown role", () => {
      expect(buildPhasePrompt("unknown", { rawInput: "", runDir: "", documents: {} })).toBe("");
    });
  });
});
