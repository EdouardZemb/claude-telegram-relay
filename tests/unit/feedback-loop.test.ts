/**
 * Unit Tests — src/feedback-loop.ts
 *
 * Tests for feedback pattern extraction and prompt enrichment.
 */

import { describe, it, expect } from "bun:test";
import {
  extractFeedbackFromRetro,
  buildFeedbackContext,
  formatFeedbackRules,
  type FeedbackRule,
} from "../../src/feedback-loop";

describe("extractFeedbackFromRetro", () => {
  it("extracts test-related patterns for dev agent", () => {
    const retro = {
      sprint_id: "S15",
      what_didnt: ["Tests manquants sur les nouveaux modules"],
      patterns_detected: [],
    };

    const results = extractFeedbackFromRetro(retro);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const devRule = results.find((r) => r.agentId === "dev");
    expect(devRule).toBeDefined();
    expect(devRule!.instruction).toContain("test");
  });

  it("extracts security patterns", () => {
    const retro = {
      sprint_id: "S10",
      what_didnt: ["Vulnerabilite injection detectee"],
      patterns_detected: ["Manque de securite sur les inputs"],
    };

    const results = extractFeedbackFromRetro(retro);
    expect(results.some((r) => r.instruction.toLowerCase().includes("securite"))).toBe(true);
  });

  it("extracts scope creep patterns for PM agent", () => {
    const retro = {
      sprint_id: "S14",
      what_didnt: [],
      patterns_detected: ["Derive du perimetre sur plusieurs taches"],
    };

    const results = extractFeedbackFromRetro(retro);
    const pmRule = results.find((r) => r.agentId === "pm");
    expect(pmRule).toBeDefined();
    expect(pmRule!.instruction).toContain("perimetre");
  });

  it("extracts from proposed actions", () => {
    const retro = {
      sprint_id: "S12",
      what_didnt: [],
      patterns_detected: [],
      actions_proposed: [
        { action: "Ameliorer la couverture de tests", priority: "haute" },
      ],
    };

    const results = extractFeedbackFromRetro(retro);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.pattern.includes("couverture de tests"))).toBe(true);
  });

  it("returns empty for unrelated patterns", () => {
    const retro = {
      sprint_id: "S15",
      what_didnt: ["Le cafe etait froid"],
      patterns_detected: [],
    };

    const results = extractFeedbackFromRetro(retro);
    expect(results).toEqual([]);
  });

  it("handles empty retro", () => {
    const retro = {
      sprint_id: "S16",
      what_didnt: [],
      patterns_detected: [],
    };

    const results = extractFeedbackFromRetro(retro);
    expect(results).toEqual([]);
  });
});

describe("buildFeedbackContext", () => {
  it("returns empty string when no rules exist for agent", () => {
    const context = buildFeedbackContext("analyst");
    expect(context).toBe("");
  });
});

describe("formatFeedbackRules", () => {
  it("formats empty rules list", () => {
    const result = formatFeedbackRules([]);
    expect(result).toContain("Aucune regle");
  });

  it("formats active rules", () => {
    const rules: FeedbackRule[] = [
      {
        id: "rule-1",
        agentId: "dev",
        pattern: "Tests manquants",
        instruction: "Verifie la couverture de tests",
        occurrences: 3,
        sprints: ["S10", "S12", "S14"],
        active: true,
        createdAt: "2026-01-01",
      },
    ];

    const result = formatFeedbackRules(rules);
    expect(result).toContain("REGLES DE FEEDBACK");
    expect(result).toContain("Actives (1)");
    expect(result).toContain("dev [3x]");
    expect(result).toContain("S10, S12, S14");
  });

  it("separates active and pending rules", () => {
    const rules: FeedbackRule[] = [
      {
        id: "rule-1",
        agentId: "dev",
        pattern: "Active pattern",
        instruction: "Do this",
        occurrences: 2,
        sprints: ["S10", "S12"],
        active: true,
        createdAt: "2026-01-01",
      },
      {
        id: "rule-2",
        agentId: "qa",
        pattern: "Pending pattern",
        instruction: "Check this",
        occurrences: 1,
        sprints: ["S14"],
        active: false,
        createdAt: "2026-01-01",
      },
    ];

    const result = formatFeedbackRules(rules);
    expect(result).toContain("Actives (1)");
    expect(result).toContain("En attente (1");
  });
});
