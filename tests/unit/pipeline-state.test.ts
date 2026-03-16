import { describe, it, expect, beforeEach } from "bun:test";
import {
  createPipelineRun,
  savePipelineStep,
  updatePipelineStatus,
  loadPipelineState,
  findLatestPipelineRun,
  buildResumeContext,
  _clearMemoryStore,
  type StepSnapshot,
  type PipelineState,
} from "../../src/pipeline-state.ts";
import type { AgentMessage } from "../../src/agent-schemas.ts";

// All tests use in-memory mode (supabase = null)

describe("pipeline-state", () => {
  beforeEach(() => {
    _clearMemoryStore();
  });

  describe("createPipelineRun", () => {
    it("creates a new pipeline run in memory", async () => {
      const sessionId = await createPipelineRun(
        null,
        "task-1",
        "session-1",
        "DEFAULT",
        ["analyst", "pm", "dev"]
      );
      expect(sessionId).toBe("session-1");

      const state = await loadPipelineState(null, "session-1");
      expect(state).not.toBeNull();
      expect(state!.status).toBe("running");
      expect(state!.pipelineAgents).toEqual(["analyst", "pm", "dev"]);
      expect(state!.currentStep).toBe(0);
    });

    it("stores blackboard ID when provided", async () => {
      await createPipelineRun(null, "task-1", "session-2", "DEFAULT", ["dev"], "bb-123");
      const state = await loadPipelineState(null, "session-2");
      expect(state!.blackboardId).toBe("bb-123");
    });
  });

  describe("savePipelineStep", () => {
    it("increments step and appends results", async () => {
      await createPipelineRun(null, "task-1", "session-3", "DEFAULT", ["analyst", "pm", "dev"]);

      const step: StepSnapshot = {
        agentId: "analyst",
        success: true,
        durationMs: 5000,
        completedAt: new Date().toISOString(),
      };
      const message: AgentMessage = {
        agentId: "analyst",
        agentName: "Mary",
        success: true,
        structured: null,
        rawOutput: "Analysis done",
        durationMs: 5000,
      };

      await savePipelineStep(null, "session-3", step, message);

      const state = await loadPipelineState(null, "session-3");
      expect(state!.currentStep).toBe(1);
      expect(state!.stepsCompleted).toHaveLength(1);
      expect(state!.stepsCompleted[0].agentId).toBe("analyst");
      expect(state!.stepsResults).toHaveLength(1);
    });

    it("accumulates multiple steps", async () => {
      await createPipelineRun(null, "task-1", "session-4", "DEFAULT", ["analyst", "pm", "dev"]);

      for (const agentId of ["analyst", "pm"] as const) {
        await savePipelineStep(null, "session-4", {
          agentId,
          success: true,
          durationMs: 3000,
          completedAt: new Date().toISOString(),
        }, {
          agentId,
          agentName: agentId,
          success: true,
          structured: null,
          rawOutput: `${agentId} output`,
          durationMs: 3000,
        });
      }

      const state = await loadPipelineState(null, "session-4");
      expect(state!.currentStep).toBe(2);
      expect(state!.stepsCompleted).toHaveLength(2);
      expect(state!.stepsResults).toHaveLength(2);
    });
  });

  describe("updatePipelineStatus", () => {
    it("updates status to failed with error", async () => {
      await createPipelineRun(null, "task-1", "session-5", "DEFAULT", ["dev"]);
      await updatePipelineStatus(null, "session-5", "failed", "Agent crashed");

      const state = await loadPipelineState(null, "session-5");
      expect(state!.status).toBe("failed");
      expect(state!.error).toBe("Agent crashed");
    });

    it("updates status to completed", async () => {
      await createPipelineRun(null, "task-1", "session-6", "DEFAULT", ["dev"]);
      await updatePipelineStatus(null, "session-6", "completed");

      const state = await loadPipelineState(null, "session-6");
      expect(state!.status).toBe("completed");
    });
  });

  describe("loadPipelineState", () => {
    it("returns null for unknown session", async () => {
      const state = await loadPipelineState(null, "nonexistent");
      expect(state).toBeNull();
    });
  });

  describe("findLatestPipelineRun", () => {
    it("finds failed pipeline for a task", async () => {
      await createPipelineRun(null, "task-2", "session-7", "DEFAULT", ["dev"]);
      await updatePipelineStatus(null, "session-7", "failed");

      const found = await findLatestPipelineRun(null, "task-2");
      expect(found).toBe("session-7");
    });

    it("ignores completed pipelines", async () => {
      await createPipelineRun(null, "task-3", "session-8", "DEFAULT", ["dev"]);
      await updatePipelineStatus(null, "session-8", "completed");

      const found = await findLatestPipelineRun(null, "task-3");
      expect(found).toBeNull();
    });

    it("returns null when no matching task", async () => {
      const found = await findLatestPipelineRun(null, "nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("buildResumeContext", () => {
    it("calculates remaining agents from current step", () => {
      const state: PipelineState = {
        sessionId: "session-9",
        taskId: "task-4",
        pipelineType: "DEFAULT",
        pipelineAgents: ["analyst", "pm", "architect", "dev", "qa"],
        currentStep: 2,
        stepsCompleted: [
          { agentId: "analyst", success: true, durationMs: 5000, completedAt: "2026-01-01" },
          { agentId: "pm", success: true, durationMs: 4000, completedAt: "2026-01-01" },
        ],
        stepsResults: [
          { agentId: "analyst", agentName: "Mary", success: true, structured: null, rawOutput: "out1", durationMs: 5000 },
          { agentId: "pm", agentName: "John", success: true, structured: null, rawOutput: "out2", durationMs: 4000 },
        ],
        status: "failed",
      };

      const ctx = buildResumeContext(state);
      expect(ctx.resumeFromStep).toBe(2);
      expect(ctx.previousMessages).toHaveLength(2);
      expect(ctx.remainingAgents).toEqual(["architect", "dev", "qa"]);
    });

    it("handles empty pipeline (no steps completed)", () => {
      const state: PipelineState = {
        sessionId: "session-10",
        taskId: "task-5",
        pipelineType: "QUICK",
        pipelineAgents: ["dev", "qa"],
        currentStep: 0,
        stepsCompleted: [],
        stepsResults: [],
        status: "failed",
      };

      const ctx = buildResumeContext(state);
      expect(ctx.resumeFromStep).toBe(0);
      expect(ctx.previousMessages).toHaveLength(0);
      expect(ctx.remainingAgents).toEqual(["dev", "qa"]);
    });
  });
});
