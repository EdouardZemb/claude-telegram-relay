/**
 * Unit Tests — scripts/generate-checklist.ts (S29-T9)
 */

import { describe, it, expect } from "bun:test";
import { generateChecklist } from "../../scripts/generate-checklist";

describe("generateChecklist", () => {
  it("generates command scenarios for command-related tasks", () => {
    const checklist = generateChecklist([
      { title: "Ajouter commande /monitor" },
    ]);
    expect(checklist).toContain("/monitor");
    expect(checklist).toContain("scenario");
  });

  it("generates pipeline scenarios for agent-related tasks", () => {
    const checklist = generateChecklist([
      { title: "Nouveau agent pipeline orchestration" },
    ]);
    expect(checklist).toContain("/orchestrate");
  });

  it("generates alert scenarios for monitoring tasks", () => {
    const checklist = generateChecklist([
      { title: "Surveillance alertes monitoring" },
    ]);
    expect(checklist).toContain("/alerts");
  });

  it("generates deploy scenarios for deploy tasks", () => {
    const checklist = generateChecklist([
      { title: "Validation smoke test deploy" },
    ]);
    expect(checklist).toContain("bun run smoke");
  });

  it("generates cost scenarios for cost tasks", () => {
    const checklist = generateChecklist([
      { title: "Estimation cout sprint" },
    ]);
    expect(checklist).toContain("/estimate");
  });

  it("generates feature flag scenarios", () => {
    const checklist = generateChecklist([
      { title: "Feature flags toggle" },
    ]);
    expect(checklist).toContain("/feature");
  });

  it("generates default scenario for unmatched tasks", () => {
    const checklist = generateChecklist([
      { title: "Refactoring interne" },
    ]);
    expect(checklist).toContain("/status");
  });

  it("handles empty task list", () => {
    const checklist = generateChecklist([]);
    expect(checklist).toContain("Aucune tache");
  });

  it("generates multiple scenarios for complex tasks", () => {
    const checklist = generateChecklist([
      { title: "Deploy avec monitoring et alertes" },
    ]);
    // Should match deploy AND alert keywords
    expect(checklist).toContain("bun run smoke");
    expect(checklist).toContain("/alerts");
  });
});
