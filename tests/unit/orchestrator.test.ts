/**
 * Unit Tests — src/orchestrator.ts
 *
 * Tests for the multi-agent orchestration framework.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_PIPELINE,
  QUICK_PIPELINE,
  REVIEW_PIPELINE,
  formatOrchestrationResult,
  type AgentRole,
  type OrchestratedResult,
  type AgentStepResult,
} from "../../src/orchestrator";

describe("Pipeline Definitions", () => {
  it("DEFAULT_PIPELINE includes all main agents in order", () => {
    expect(DEFAULT_PIPELINE).toEqual(["analyst", "pm", "architect", "dev", "qa"]);
  });

  it("QUICK_PIPELINE has dev and qa only", () => {
    expect(QUICK_PIPELINE).toEqual(["dev", "qa"]);
  });

  it("REVIEW_PIPELINE has qa and architect", () => {
    expect(REVIEW_PIPELINE).toEqual(["qa", "architect"]);
  });

  it("all pipelines contain valid agent roles", () => {
    const validRoles: AgentRole[] = ["analyst", "pm", "architect", "dev", "qa", "sm"];
    for (const pipeline of [DEFAULT_PIPELINE, QUICK_PIPELINE, REVIEW_PIPELINE]) {
      for (const role of pipeline) {
        expect(validRoles).toContain(role);
      }
    }
  });
});

describe("formatOrchestrationResult", () => {
  function makeStep(
    agentId: AgentRole,
    agentName: string,
    success: boolean,
    output: string = "test output",
    durationMs: number = 5000
  ): AgentStepResult {
    return { agentId, agentName, success, output, durationMs };
  }

  it("formats a successful orchestration", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [
        makeStep("dev", "Amelia", true, "Code implemented"),
        makeStep("qa", "Quinn", true, "All tests pass"),
      ],
      totalDurationMs: 10000,
      summary: "All agents succeeded",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("ORCHESTRATION OK");
    expect(formatted).toContain("Amelia");
    expect(formatted).toContain("Quinn");
    expect(formatted).toContain("10s");
  });

  it("formats a failed orchestration", () => {
    const result: OrchestratedResult = {
      success: false,
      steps: [
        makeStep("dev", "Amelia", true, "Code done"),
        makeStep("qa", "Quinn", false, "", 3000),
      ],
      totalDurationMs: 8000,
      summary: "QA failed",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("ORCHESTRATION ATTENTION");
    expect(formatted).toContain("echec");
  });

  it("includes last successful agent output in result", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [
        makeStep("analyst", "Mary", true, "Analysis complete: good feasibility"),
        makeStep("dev", "Amelia", true, "Implemented feature XYZ"),
      ],
      totalDurationMs: 20000,
      summary: "Done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("Implemented feature XYZ");
  });

  it("truncates very long output", () => {
    const longOutput = "x".repeat(5000);
    const result: OrchestratedResult = {
      success: true,
      steps: [makeStep("dev", "Amelia", true, longOutput)],
      totalDurationMs: 5000,
      summary: "Done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("...");
    expect(formatted.length).toBeLessThan(5500);
  });

  it("handles empty steps array", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [],
      totalDurationMs: 0,
      summary: "Nothing to do",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("ORCHESTRATION OK");
    expect(formatted).toContain("0s");
  });

  it("shows duration per agent", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [
        makeStep("analyst", "Mary", true, "Done", 15000),
        makeStep("pm", "John", true, "Done", 30000),
        makeStep("dev", "Amelia", true, "Done", 120000),
      ],
      totalDurationMs: 165000,
      summary: "All done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("15s");
    expect(formatted).toContain("30s");
    expect(formatted).toContain("120s");
  });
});
