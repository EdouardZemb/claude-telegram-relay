/**
 * System Tests — Module Integrity
 *
 * Verifies that all core modules import correctly and export
 * the expected functions. Catches broken imports, missing exports,
 * and module-level initialization errors after code changes.
 *
 * S18-11: Anti-regression for the S18 cleanup sprint.
 */

import { describe, expect, it } from "bun:test";

// ── Source Module Imports ────────────────────────────────────

describe("Module Imports: Core", () => {
  it("imports tasks module", async () => {
    const mod = await import("../../src/tasks");
    expect(mod.addTask).toBeFunction();
    expect(mod.updateTaskStatus).toBeFunction();
    expect(mod.getBacklog).toBeFunction();
    expect(mod.getCurrentSprint).toBeFunction();
    expect(mod.formatBacklog).toBeFunction();
  });

  it("imports memory module", async () => {
    const mod = await import("../../src/memory");
    expect(mod.processMemoryIntents).toBeFunction();
    expect(mod.getMemoryContext).toBeFunction();
    expect(mod.getRecentMessages).toBeFunction();
  });

  it("imports projects module", async () => {
    const mod = await import("../../src/projects");
    expect(mod.createProject).toBeFunction();
    expect(mod.getProject).toBeFunction();
    expect(mod.listProjects).toBeFunction();
    expect(mod.updateProject).toBeFunction();
    expect(mod.archiveProject).toBeFunction();
    expect(mod.resolveProjectContext).toBeFunction();
    expect(mod.formatProjectList).toBeFunction();
    expect(mod.formatProjectDetail).toBeFunction();
    // getProjectById was removed in S18-01 — should NOT exist
    // biome-ignore lint/suspicious/noExplicitAny: checking removed export
    expect((mod as any).getProjectById).toBeUndefined();
  });

  it("imports notification-queue module", async () => {
    const mod = await import("../../src/notification-queue");
    expect(mod.enqueue).toBeFunction();
    expect(mod.getQueue).toBeFunction();
    expect(mod.loadQueue).toBeFunction();
    expect(mod.startQueue).toBeFunction();
  });
});

describe("Module Imports: BMad System", () => {
  it("imports gates module", async () => {
    const mod = await import("../../src/gates");
    expect(mod.checkGate1_PRD).toBeFunction();
    expect(mod.checkAllGates).toBeFunction();
    expect(mod.checkGatesWithOverrides).toBeFunction();
  });

  // bmad-agents, bmad-prompts, story-files, feedback-loop, code-review modules removed (ARCHITECTURE-V2)
});

describe("Module Imports: Workflow & Analysis", () => {
  // workflow module removed (ARCHITECTURE-V2 — metrics/retro inlined into quality.ts)

  it("imports alerts module", async () => {
    const mod = await import("../../src/alerts");
    expect(mod.runAllChecks).toBeFunction();
    expect(mod.formatAlerts).toBeFunction();
    expect(mod.checkStuckTasks).toBeFunction();
    expect(mod.checkReworkRate).toBeFunction();
    expect(mod.checkSprintPace).toBeFunction();
  });

  it("imports document-sharding module", async () => {
    const mod = await import("../../src/document-sharding");
    expect(mod.shardDocument).toBeFunction();
    expect(mod.getDocumentShards).toBeFunction();
    expect(mod.getRelevantShards).toBeFunction();
    expect(mod.buildTaskContext).toBeFunction();
    expect(mod.splitIntoSections).toBeFunction();
    expect(mod.invalidateProjectCache).toBeFunction();
    expect(mod.clearContextCache).toBeFunction();
    // shardAnalysis and shardMemoryFacts were removed in S18-01
    // biome-ignore lint/suspicious/noExplicitAny: checking removed export
    expect((mod as any).shardAnalysis).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: checking removed export
    expect((mod as any).shardMemoryFacts).toBeUndefined();
  });

  // workflow-propagation module was removed (dead code cleanup)
});

describe("Module Imports: Utilities", () => {
  it("imports transcribe module", async () => {
    const mod = await import("../../src/transcribe");
    expect(mod.transcribe).toBeFunction();
  });

  // profile-evolution module removed (ARCHITECTURE-V2 Phase 4)
});

// ── Document Sharding Functional Test ────────────────────────

describe("Document Sharding: splitIntoSections", () => {
  it("splits markdown into sections by headings", async () => {
    const { splitIntoSections } = await import("../../src/document-sharding");

    const content = [
      "# Title",
      "Preamble content",
      "",
      "## Section One",
      "Content of section one",
      "",
      "## Section Two",
      "Content of section two",
      "More content",
    ].join("\n");

    const sections = splitIntoSections(content);
    expect(sections.length).toBe(3);
    expect(sections[0].title).toBe("Title");
    expect(sections[1].title).toBe("Section One");
    expect(sections[2].title).toBe("Section Two");
  });

  it("handles document with no headings", async () => {
    const { splitIntoSections } = await import("../../src/document-sharding");

    const content = "Just plain text\nNo headings here";
    const sections = splitIntoSections(content);
    expect(sections.length).toBe(1);
    expect(sections[0].title).toBe("Preambule");
  });
});
