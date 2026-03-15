/**
 * Unit Tests — Workflow Enforcement & Retry Policies (S23-08/09)
 *
 * Tests for transition enforcement in WorkflowTracker
 * and retry policy resolution from workflow.yaml.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";

process.env.PROJECT_DIR = import.meta.dir + "/../fixtures/..";

import {
  WorkflowTracker,
  getRetryPolicy,
  getExecutionRetryPolicy,
  reloadWorkflowConfig,
} from "../../src/workflow";

// ── Workflow Transition Enforcement (S23-08) ─────────────────

describe("WorkflowTracker enforcement", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    reloadWorkflowConfig();
  });

  it("allows valid transition when enforce=true", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "request" });
    const result = await tracker.transition("decomposition", { enforce: true });

    expect(result).toBe(true);
    expect(tracker.getCurrentStep()).toBe("decomposition");
  });

  it("rejects invalid transition when enforce=true", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "request" });
    const result = await tracker.transition("closure", { enforce: true });

    expect(result).toBe(false);
    expect(tracker.getCurrentStep()).toBe("request"); // should not change
  });

  it("allows any transition when enforce is not set (backward compat)", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "request" });
    const result = await tracker.transition("closure");

    expect(result).toBe(true);
    expect(tracker.getCurrentStep()).toBe("closure");
  });

  it("allows orchestration steps without enforcement", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "request" });
    const result = await tracker.transition("orchestration_analyst", { enforce: true });

    expect(result).toBe(true);
    expect(tracker.getCurrentStep()).toBe("orchestration_analyst");
  });

  it("allows orchestration-to-orchestration transitions", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "orchestration_analyst" });
    const result = await tracker.transition("orchestration_dev", { enforce: true });

    expect(result).toBe(true);
  });

  it("enforces valid transition: execution -> review", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "execution" });
    const result = await tracker.transition("review", { enforce: true });

    expect(result).toBe(true);
  });

  it("enforces valid rework transition: review -> execution", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "review" });
    const result = await tracker.transition("execution", {
      enforce: true,
      had_rework: true,
    });

    expect(result).toBe(true);
  });

  it("rejects invalid transition: decomposition -> closure", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "decomposition" });
    const result = await tracker.transition("closure", { enforce: true });

    expect(result).toBe(false);
  });

  it("enforces: review -> closure (valid)", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "review" });
    const result = await tracker.transition("closure", { enforce: true });

    expect(result).toBe(true);
  });

  it("logs transition even when enforced", async () => {
    const tracker = new WorkflowTracker(supabase, {
      startStep: "request",
      taskId: "t1",
    });
    await tracker.transition("decomposition", { enforce: true });

    const logs = supabase._getTable("workflow_logs");
    expect(logs.length).toBe(1);
    expect(logs[0].step_from).toBe("request");
    expect(logs[0].step_to).toBe("decomposition");
  });

  it("does not log when transition is rejected", async () => {
    const tracker = new WorkflowTracker(supabase, { startStep: "request" });
    await tracker.transition("closure", { enforce: true });

    const logs = supabase._getTable("workflow_logs");
    expect(logs.length).toBe(0);
  });
});

// ── Retry Policies (S23-09) ──────────────────────────────────

describe("getRetryPolicy", () => {
  beforeEach(() => {
    reloadWorkflowConfig();
  });

  it("returns 0 retries for off mode (request step)", () => {
    const policy = getRetryPolicy("request");
    expect(policy.maxRetries).toBe(0);
    expect(policy.mode).toBe("off");
  });

  it("returns 1 retry for light mode (decomposition step)", () => {
    const policy = getRetryPolicy("decomposition");
    expect(policy.maxRetries).toBe(1);
    expect(policy.mode).toBe("light");
  });

  it("returns 3 retries for strict mode (execution step)", () => {
    const policy = getRetryPolicy("execution");
    expect(policy.maxRetries).toBe(3);
    expect(policy.mode).toBe("strict");
  });

  it("returns 1 retry for light mode (review step)", () => {
    const policy = getRetryPolicy("review");
    expect(policy.maxRetries).toBe(1);
    expect(policy.mode).toBe("light");
  });

  it("returns 0 retries for unknown step", () => {
    const policy = getRetryPolicy("nonexistent");
    expect(policy.maxRetries).toBe(0);
    expect(policy.mode).toBe("off");
  });
});

describe("getExecutionRetryPolicy", () => {
  beforeEach(() => {
    reloadWorkflowConfig();
  });

  it("returns max retries for execution step", () => {
    const retries = getExecutionRetryPolicy();
    expect(retries).toBe(3);
  });
});
