/**
 * Unit Tests — src/workflow.ts
 *
 * Tests for workflow config loading, query helpers,
 * WorkflowTracker, metrics collection, retro generation, and formatting.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";

// We need to set PROJECT_DIR before importing workflow so it loads the test config
process.env.PROJECT_DIR = import.meta.dir + "/../fixtures/..";

import {
  loadWorkflowConfig,
  reloadWorkflowConfig,
  getStep,
  getStepIds,
  getValidTransitions,
  canTransition,
  getCheckpointConfig,
  WorkflowTracker,
  collectSprintMetrics,
  getSprintMetrics,
  getAllSprintMetrics,
  formatMetrics,
  formatMetricsComparison,
  generateRetroData,
  saveRetro,
  acceptRetroActions,
  getRetro,
  formatRetro,
} from "../../src/workflow";

// ── Config Loading ───────────────────────────────────────────

describe("Workflow Config Loading", () => {
  beforeEach(() => {
    reloadWorkflowConfig();
  });

  it("loads the workflow config from YAML", () => {
    const config = loadWorkflowConfig();
    expect(config).toBeDefined();
    expect(config.version).toBe(1);
    expect(config.steps.length).toBeGreaterThan(0);
    expect(config.transitions.length).toBeGreaterThan(0);
  });

  it("has all required step fields", () => {
    const config = loadWorkflowConfig();
    for (const step of config.steps) {
      expect(step.id).toBeDefined();
      expect(step.label).toBeDefined();
      expect(step.description).toBeDefined();
      expect(step.checkpoint).toBeDefined();
      expect(step.checkpoint.mode).toBeDefined();
    }
  });

  it("has checkpoint_modes defined", () => {
    const config = loadWorkflowConfig();
    expect(config.checkpoint_modes).toBeDefined();
    expect(config.checkpoint_modes.off).toBeDefined();
    expect(config.checkpoint_modes.light).toBeDefined();
    expect(config.checkpoint_modes.strict).toBeDefined();
  });
});

// ── Query Helpers ────────────────────────────────────────────

describe("Workflow Query Helpers", () => {
  beforeEach(() => {
    reloadWorkflowConfig();
  });

  it("getStep returns the correct step", () => {
    const step = getStep("request");
    expect(step).toBeDefined();
    expect(step!.id).toBe("request");
    expect(step!.label).toBe("Demande");
  });

  it("getStep returns undefined for unknown step", () => {
    const step = getStep("nonexistent");
    expect(step).toBeUndefined();
  });

  it("getStepIds returns all step IDs", () => {
    const ids = getStepIds();
    expect(ids).toContain("request");
    expect(ids).toContain("execution");
    expect(ids).toContain("closure");
  });

  it("getValidTransitions returns correct transitions from request", () => {
    const transitions = getValidTransitions("request");
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.some((t) => t.to === "decomposition")).toBe(true);
  });

  it("getValidTransitions returns empty for closure (no outgoing)", () => {
    const transitions = getValidTransitions("closure");
    expect(transitions.length).toBe(0);
  });

  it("canTransition validates allowed transitions", () => {
    expect(canTransition("request", "decomposition")).toBe(true);
    expect(canTransition("execution", "review")).toBe(true);
    expect(canTransition("review", "closure")).toBe(true);
  });

  it("canTransition rejects invalid transitions", () => {
    expect(canTransition("request", "closure")).toBe(false);
    expect(canTransition("closure", "request")).toBe(false);
    expect(canTransition("request", "review")).toBe(false);
  });

  it("getCheckpointConfig returns correct config", () => {
    const checkpoint = getCheckpointConfig("execution");
    expect(checkpoint.enabled).toBe(true);
    expect(checkpoint.mode).toBe("strict");
  });

  it("getCheckpointConfig returns off for disabled steps", () => {
    const checkpoint = getCheckpointConfig("request");
    expect(checkpoint.enabled).toBe(false);
    expect(checkpoint.mode).toBe("off");
  });

  it("getCheckpointConfig returns default for unknown step", () => {
    const checkpoint = getCheckpointConfig("nonexistent");
    expect(checkpoint.enabled).toBe(false);
    expect(checkpoint.mode).toBe("off");
  });
});

// ── WorkflowTracker ──────────────────────────────────────────

describe("WorkflowTracker", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    reloadWorkflowConfig();
  });

  it("starts at the default step (request)", () => {
    const tracker = new WorkflowTracker(supabase);
    expect(tracker.getCurrentStep()).toBe("request");
  });

  it("starts at a custom step", () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "execution" });
    expect(tracker.getCurrentStep()).toBe("execution");
  });

  it("transitions and logs to workflow_logs", async () => {
    const tracker = new WorkflowTracker(supabase, {
      taskId: "task-1",
      sprintId: "S12",
    });

    const result = await tracker.transition("decomposition", {
      agent_notes: "Plan created",
    });

    expect(result).toBe(true);
    expect(tracker.getCurrentStep()).toBe("decomposition");

    const logs = supabase._getTable("workflow_logs");
    expect(logs.length).toBe(1);
    expect(logs[0].step_from).toBe("request");
    expect(logs[0].step_to).toBe("decomposition");
    expect(logs[0].task_id).toBe("task-1");
    expect(logs[0].sprint_id).toBe("S12");
    expect(logs[0].agent_notes).toBe("Plan created");
  });

  it("records duration between transitions", async () => {
    const tracker = new WorkflowTracker(supabase);

    // Small delay to have non-zero duration
    await new Promise((r) => setTimeout(r, 50));
    await tracker.transition("decomposition");

    const logs = supabase._getTable("workflow_logs");
    expect(logs[0].duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it("logs checkpoint results", async () => {
    const tracker = new WorkflowTracker(supabase, {
      taskId: "task-1",
      startStep: "execution",
    });

    await tracker.logCheckpoint("pass", "All tests green");

    const logs = supabase._getTable("workflow_logs");
    expect(logs.length).toBe(1);
    expect(logs[0].step_from).toBe("execution");
    expect(logs[0].step_to).toBe("execution"); // checkpoint stays on same step
    expect(logs[0].checkpoint_result).toBe("pass");
    expect(logs[0].checkpoint_notes).toBe("All tests green");
  });

  it("tracks rework flag", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "review" });

    await tracker.transition("execution", {
      had_rework: true,
      checkpoint_result: "fail",
      checkpoint_notes: "Tests failing",
    });

    const logs = supabase._getTable("workflow_logs");
    expect(logs[0].had_rework).toBe(true);
    expect(logs[0].checkpoint_result).toBe("fail");
  });

  it("supports multiple transitions in sequence", async () => {
    const tracker = new WorkflowTracker(supabase, { sprintId: "S12" });

    await tracker.transition("decomposition");
    await tracker.transition("execution");
    await tracker.transition("review");
    await tracker.transition("closure");

    expect(tracker.getCurrentStep()).toBe("closure");

    const logs = supabase._getTable("workflow_logs");
    expect(logs.length).toBe(4);
    expect(logs[0].step_from).toBe("request");
    expect(logs[3].step_to).toBe("closure");
  });
});

// ── Metrics ──────────────────────────────────────────────────

describe("Sprint Metrics", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    supabase = createMockSupabase({
      tasks: [
        { id: "t1", status: "done", sprint: "S11", created_at: yesterday.toISOString(), completed_at: now.toISOString() },
        { id: "t2", status: "done", sprint: "S11", created_at: yesterday.toISOString(), completed_at: now.toISOString() },
        { id: "t3", status: "in_progress", sprint: "S11", created_at: yesterday.toISOString(), completed_at: null },
      ],
      workflow_logs: [
        { task_id: "t1", sprint_id: "S11", step_from: "execution", step_to: "review", had_rework: false, checkpoint_result: "pass" },
        { task_id: "t2", sprint_id: "S11", step_from: "execution", step_to: "review", had_rework: true, checkpoint_result: "corrected" },
      ],
      sprint_metrics: [],
    });
  });

  it("collectSprintMetrics calculates correct stats", async () => {
    const result = await collectSprintMetrics(supabase, "S11");
    expect(result).toBe(true);

    const metrics = supabase._getTable("sprint_metrics");
    expect(metrics.length).toBe(1);
    expect(metrics[0].sprint_id).toBe("S11");
    expect(metrics[0].tasks_planned).toBe(3);
    expect(metrics[0].tasks_completed).toBe(2);
  });

  it("getSprintMetrics retrieves stored metrics", async () => {
    await collectSprintMetrics(supabase, "S11");
    const metrics = await getSprintMetrics(supabase, "S11");
    expect(metrics).not.toBeNull();
    expect(metrics.sprint_id).toBe("S11");
  });

  it("getSprintMetrics returns null for unknown sprint", async () => {
    const metrics = await getSprintMetrics(supabase, "S99");
    expect(metrics).toBeNull();
  });

  it("getAllSprintMetrics returns all metrics ordered", async () => {
    await collectSprintMetrics(supabase, "S11");
    const all = await getAllSprintMetrics(supabase);
    expect(all.length).toBeGreaterThan(0);
  });

  it("collectSprintMetrics handles empty sprint", async () => {
    supabase._reset();
    const result = await collectSprintMetrics(supabase, "S99");
    expect(result).toBe(true);

    const metrics = supabase._getTable("sprint_metrics");
    expect(metrics[0].tasks_planned).toBe(0);
    expect(metrics[0].tasks_completed).toBe(0);
  });
});

// ── Formatting ───────────────────────────────────────────────

describe("Metrics Formatting", () => {
  it("formatMetrics produces readable output", () => {
    const result = formatMetrics({
      sprint_id: "S11",
      tasks_planned: 13,
      tasks_completed: 12,
      completion_rate: 92,
      avg_delivery_hours: 2.5,
      first_pass_rate: 85.5,
      rework_count: 2,
      incidents_count: 0,
      sprint_ended_at: "2026-02-10T18:00:00Z",
    });

    expect(result).toContain("S11");
    expect(result).toContain("12/13");
    expect(result).toContain("2.5h");
    expect(result).toContain("85.5%");
    expect(result).toContain("2");
  });

  it("formatMetrics handles null values", () => {
    const result = formatMetrics({
      sprint_id: "S12",
      tasks_planned: 0,
      tasks_completed: 0,
      completion_rate: 0,
      avg_delivery_hours: null,
      first_pass_rate: null,
      rework_count: 0,
      incidents_count: 0,
      sprint_ended_at: null,
    });

    expect(result).toContain("S12");
    expect(result).toContain("0/0");
    expect(result).not.toContain("null");
  });

  it("formatMetrics returns message for null input", () => {
    expect(formatMetrics(null)).toContain("Pas de metriques");
  });

  it("formatMetricsComparison shows multiple sprints", () => {
    const result = formatMetricsComparison([
      { sprint_id: "S10", tasks_planned: 16, tasks_completed: 15, completion_rate: 94 },
      { sprint_id: "S11", tasks_planned: 13, tasks_completed: 13, completion_rate: 100 },
    ]);

    expect(result).toContain("S10");
    expect(result).toContain("S11");
    expect(result).toContain("94%");
    expect(result).toContain("100%");
  });

  it("formatMetricsComparison handles empty list", () => {
    expect(formatMetricsComparison([])).toContain("Pas de metriques");
  });
});

// ── Retro ────────────────────────────────────────────────────

describe("Retrospective", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S11", tasks_planned: 13, tasks_completed: 12 },
      ],
      workflow_logs: [
        { sprint_id: "S11", step_from: "request", step_to: "decomposition", duration_seconds: 120, had_rework: false, checkpoint_result: "skipped" },
        { sprint_id: "S11", step_from: "decomposition", step_to: "execution", duration_seconds: 300, had_rework: false, checkpoint_result: "pass" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", duration_seconds: 3600, had_rework: false, checkpoint_result: "pass" },
        { sprint_id: "S11", step_from: "review", step_to: "execution", duration_seconds: 60, had_rework: true, checkpoint_result: "fail" },
      ],
      tasks: [
        { id: "t1", sprint: "S11", status: "done", title: "Task 1" },
        { id: "t2", sprint: "S11", status: "done", title: "Task 2" },
      ],
      retros: [],
    });
  });

  it("generateRetroData produces structured data", async () => {
    const retro = await generateRetroData(supabase, "S11");
    expect(retro).not.toBeNull();
    expect(retro!.workflowStats.totalTransitions).toBe(4);
    expect(retro!.workflowStats.reworkCount).toBe(1);
    expect(retro!.tasks.length).toBe(2);
  });

  it("generateRetroData computes avg step durations", async () => {
    const retro = await generateRetroData(supabase, "S11");
    expect(retro!.workflowStats.avgStepDuration).toBeDefined();
    expect(retro!.workflowStats.avgStepDuration["request"]).toBe(120);
    expect(retro!.workflowStats.avgStepDuration["execution"]).toBe(3600);
  });

  it("generateRetroData counts checkpoint results", async () => {
    const retro = await generateRetroData(supabase, "S11");
    expect(retro!.workflowStats.checkpointResults["pass"]).toBe(2);
    expect(retro!.workflowStats.checkpointResults["fail"]).toBe(1);
    expect(retro!.workflowStats.checkpointResults["skipped"]).toBe(1);
  });

  it("saveRetro stores retro data", async () => {
    const result = await saveRetro(supabase, "S11", {
      what_worked: ["Bonne decomposition"],
      what_didnt: ["Timeout sur les agents"],
      patterns_detected: ["Rework frequent en phase review"],
      actions_proposed: [{ action: "Ajouter tests", priority: "high" }],
      raw_analysis: "Analysis text",
    });

    expect(result).toBe(true);
    const retros = supabase._getTable("retros");
    expect(retros.length).toBe(1);
    expect(retros[0].sprint_id).toBe("S11");
    expect(retros[0].what_worked).toContain("Bonne decomposition");
  });

  it("getRetro retrieves stored retro", async () => {
    await saveRetro(supabase, "S11", {
      what_worked: ["test"],
      what_didnt: [],
      patterns_detected: [],
      actions_proposed: [],
      raw_analysis: "",
    });

    const retro = await getRetro(supabase, "S11");
    expect(retro).not.toBeNull();
    expect(retro.sprint_id).toBe("S11");
  });

  it("acceptRetroActions updates the retro", async () => {
    await saveRetro(supabase, "S11", {
      what_worked: [],
      what_didnt: [],
      patterns_detected: [],
      actions_proposed: [{ action: "Add tests", priority: "high" }],
      raw_analysis: "",
    });

    const result = await acceptRetroActions(supabase, "S11", [
      { action: "Add tests", priority: "high" },
    ]);
    expect(result).toBe(true);

    const retro = await getRetro(supabase, "S11");
    expect(retro.actions_accepted).toBeDefined();
    expect(retro.actions_accepted.length).toBe(1);
    expect(retro.validated_at).toBeDefined();
  });
});

// ── Retro Formatting ─────────────────────────────────────────

describe("Retro Formatting", () => {
  it("formatRetro produces readable output", () => {
    const result = formatRetro({
      sprint_id: "S11",
      what_worked: ["Bonne planification", "CI stable"],
      what_didnt: ["Timeout agents"],
      patterns_detected: ["Rework en review"],
      actions_proposed: [
        { action: "Augmenter timeout", priority: "high" },
        { action: "Ajouter tests", priority: "medium" },
      ],
      actions_accepted: [{ action: "Augmenter timeout", priority: "high" }],
    });

    expect(result).toContain("S11");
    expect(result).toContain("Bonne planification");
    expect(result).toContain("Timeout agents");
    expect(result).toContain("Rework en review");
    expect(result).toContain("[OK]");
    expect(result).toContain("[ ]");
  });

  it("formatRetro handles null input", () => {
    expect(formatRetro(null)).toContain("Pas de retro");
  });

  it("formatRetro handles empty arrays", () => {
    const result = formatRetro({
      sprint_id: "S12",
      what_worked: [],
      what_didnt: [],
      patterns_detected: [],
      actions_proposed: [],
    });

    expect(result).toContain("S12");
  });
});
