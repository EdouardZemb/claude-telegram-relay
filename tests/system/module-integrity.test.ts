/**
 * System Tests — Module Integrity
 *
 * Verifies that all core modules import correctly and export
 * the expected functions. Catches broken imports, missing exports,
 * and module-level initialization errors after code changes.
 *
 * S18-11: Anti-regression for the S18 cleanup sprint.
 */

import { describe, it, expect } from "bun:test";

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
    expect((mod as any).getProjectById).toBeUndefined();
  });

  it("imports notifications module", async () => {
    const mod = await import("../../src/notifications");
    expect(mod.initNotifications).toBeFunction();
    expect(mod.notifyPRCreated).toBeFunction();
    expect(mod.notifyTaskStarted).toBeFunction();
    expect(mod.notifyTaskDone).toBeFunction();
    // notifyPRMerged and notifyDeploy were removed in S18-01
    expect((mod as any).notifyPRMerged).toBeUndefined();
    expect((mod as any).notifyDeploy).toBeUndefined();
  });
});

describe("Module Imports: BMad System", () => {
  it("imports bmad-agents module", async () => {
    const mod = await import("../../src/bmad-agents");
    expect(mod.getAgent).toBeFunction();
    expect(mod.getAgents).toBeFunction();
    expect(mod.getAgentForCommand).toBeFunction();
    expect(mod.formatAgentList).toBeFunction();
    const agents = mod.getAgents();
    expect(agents.length).toBeGreaterThanOrEqual(6);
  });

  it("imports gates module", async () => {
    const mod = await import("../../src/gates");
    expect(mod.checkGate1_PRD).toBeFunction();
    expect(mod.checkAllGates).toBeFunction();
    expect(mod.checkGatesWithOverrides).toBeFunction();
  });

  it("imports orchestrator module", async () => {
    const mod = await import("../../src/orchestrator");
    expect(mod.orchestrate).toBeFunction();
    expect(mod.formatOrchestrationResult).toBeFunction();
    expect(mod.DEFAULT_PIPELINE).toBeDefined();
    expect(mod.QUICK_PIPELINE).toBeDefined();
    expect(mod.REVIEW_PIPELINE).toBeDefined();
    // parallelReview was removed in S18-01
    expect((mod as any).parallelReview).toBeUndefined();
  });

  it("imports story-files module", async () => {
    const mod = await import("../../src/story-files");
    expect(mod.buildStoryFile).toBeFunction();
    expect(mod.formatStoryForAgent).toBeFunction();
    expect(mod.enrichTaskWithStory).toBeFunction();
    expect(mod.formatStoryPreview).toBeFunction();
  });

  it("imports feedback-loop module", async () => {
    const mod = await import("../../src/feedback-loop");
    expect(mod.processRetroFeedback).toBeFunction();
    expect(mod.loadFeedbackRules).toBeFunction();
  });

  it("imports code-review module", async () => {
    const mod = await import("../../src/code-review");
    expect(mod.saveReviewResult).toBeFunction();
    expect(mod.formatReviewResult).toBeFunction();
  });
});

describe("Module Imports: Workflow & Analysis", () => {
  it("imports workflow module", async () => {
    const mod = await import("../../src/workflow");
    expect(mod.WorkflowTracker).toBeDefined();
    expect(mod.collectSprintMetrics).toBeFunction();
    expect(mod.getSprintMetrics).toBeFunction();
    expect(mod.generateRetroData).toBeFunction();
    expect(mod.saveRetro).toBeFunction();
    expect(mod.formatMetrics).toBeFunction();
    expect(mod.formatRetro).toBeFunction();
  });

  it("imports patterns module", async () => {
    const mod = await import("../../src/patterns");
    expect(mod.analyzePatterns).toBeFunction();
    expect(mod.formatPatterns).toBeFunction();
  });

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
    expect((mod as any).shardAnalysis).toBeUndefined();
    expect((mod as any).shardMemoryFacts).toBeUndefined();
  });

  it("imports workflow-propagation module", async () => {
    const mod = await import("../../src/workflow-propagation");
    expect(mod.proposeWorkflowChange).toBeFunction();
    expect(mod.getPendingProposals).toBeFunction();
    expect(mod.extractProposalsFromRetro).toBeFunction();
    expect(mod.formatProposals).toBeFunction();
    // rejectProposal and getPromotedProposals were removed in S18-01
    expect((mod as any).rejectProposal).toBeUndefined();
    expect((mod as any).getPromotedProposals).toBeUndefined();
  });
});

describe("Module Imports: Utilities", () => {
  it("imports transcribe module", async () => {
    const mod = await import("../../src/transcribe");
    expect(mod.transcribe).toBeFunction();
  });

  it("imports prd module", async () => {
    const mod = await import("../../src/prd");
    expect(mod.generatePRD).toBeFunction();
    expect(mod.savePRD).toBeFunction();
    expect(mod.getPRDs).toBeFunction();
    expect(mod.updatePRDStatus).toBeFunction();
    expect(mod.formatPRDList).toBeFunction();
  });

  it("imports profile-evolution module", async () => {
    const mod = await import("../../src/profile-evolution");
    expect(mod.analyzeProfile).toBeFunction();
    expect(mod.proposeProfileUpdates).toBeFunction();
    expect(mod.formatProfileInsights).toBeFunction();
  });
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
