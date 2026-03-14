/**
 * Unit Tests — src/gates.ts
 *
 * Tests for BMad gates (PRD validation, architecture readiness).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  checkGate1_PRD,
  checkGate2_Architecture,
  checkAllGates,
  overrideGate,
  isGateOverridden,
  clearGateOverrides,
  checkGatesWithOverrides,
} from "../../src/gates";

describe("Gate 1 — PRD", () => {
  it("passes when an approved PRD exists for the project", async () => {
    const supabase = createMockSupabase({
      prds: [
        { id: "prd-1", title: "Feature PRD", project: "my-app", status: "approved" },
      ],
    });

    const result = await checkGate1_PRD(supabase, {
      project: "my-app",
      sprint: "S14",
      title: "Some task",
    });

    expect(result.passed).toBe(true);
    expect(result.gate).toContain("PRD");
  });

  it("fails when no approved PRD exists", async () => {
    const supabase = createMockSupabase({
      prds: [
        { id: "prd-1", title: "Draft PRD", project: "my-app", status: "draft" },
      ],
    });

    const result = await checkGate1_PRD(supabase, {
      project: "my-app",
      sprint: "S14",
      title: "Some task",
    });

    expect(result.passed).toBe(false);
    expect(result.overridable).toBe(true);
    expect(result.reason).toContain("brouillon");
  });

  it("fails with no PRDs at all", async () => {
    const supabase = createMockSupabase({ prds: [] });

    const result = await checkGate1_PRD(supabase, {
      project: "my-app",
      sprint: null,
      title: "Task",
    });

    expect(result.passed).toBe(false);
    expect(result.overridable).toBe(true);
    expect(result.reason).toContain("/prd");
  });

  it("ignores approved PRDs from other projects", async () => {
    const supabase = createMockSupabase({
      prds: [
        { id: "prd-1", title: "Other PRD", project: "other-project", status: "approved" },
      ],
    });

    const result = await checkGate1_PRD(supabase, {
      project: "my-app",
      sprint: null,
      title: "Task",
    });

    expect(result.passed).toBe(false);
  });
});

describe("Gate 2 — Architecture", () => {
  it("passes when task has acceptance_criteria", async () => {
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Implement feature", acceptance_criteria: "Given a user\nWhen they login\nThen they see the dashboard" },
      ],
    });

    const result = await checkGate2_Architecture(supabase, {
      id: "t1",
      title: "Implement feature",
      description: null,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toContain("acceptance criteria");
  });

  it("passes when task has architecture_ref", async () => {
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Implement feature", architecture_ref: "REST endpoint with CRUD" },
      ],
    });

    const result = await checkGate2_Architecture(supabase, {
      id: "t1",
      title: "Implement feature",
      description: null,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toContain("architecture ref");
  });

  it("fails when task has no BMad artefacts", async () => {
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Do something" },
      ],
    });

    const result = await checkGate2_Architecture(supabase, {
      id: "t1",
      title: "Do something",
      description: null,
    });

    expect(result.passed).toBe(false);
    expect(result.overridable).toBe(true);
    expect(result.reason).toContain("acceptance criteria");
  });

  it("fails when task only has description (no BMad artefacts)", async () => {
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Task", description: "Some long description that would have passed before" },
      ],
    });

    const result = await checkGate2_Architecture(supabase, {
      id: "t1",
      title: "Task",
      description: "Some long description that would have passed before",
    });

    expect(result.passed).toBe(false);
  });

  it("includes subtask count in reason when present", async () => {
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Task", acceptance_criteria: "Given/When/Then", subtasks: ["step1", "step2", "step3"] },
      ],
    });

    const result = await checkGate2_Architecture(supabase, {
      id: "t1",
      title: "Task",
      description: null,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toContain("3 subtasks");
  });
});

describe("checkAllGates", () => {
  it("returns null when all gates pass", async () => {
    const supabase = createMockSupabase({
      prds: [{ id: "prd-1", title: "PRD", project: "my-app", status: "approved" }],
      tasks: [{ id: "t1", title: "Task", acceptance_criteria: "Given/When/Then criteria" }],
    });

    const result = await checkAllGates(supabase, {
      id: "t1",
      title: "Task",
      description: "A sufficiently detailed task description for the gate check",
      project: "my-app",
      sprint: "S14",
    });

    expect(result).toBeNull();
  });

  it("returns first failing gate", async () => {
    const supabase = createMockSupabase({ prds: [] });

    const result = await checkAllGates(supabase, {
      id: "t1",
      title: "Task",
      description: "A sufficiently detailed description",
      project: "my-app",
      sprint: "S14",
    });

    expect(result).not.toBeNull();
    expect(result!.gate).toContain("PRD");
  });
});

describe("Gate Overrides", () => {
  it("overrideGate marks a gate as overridden (persisted)", async () => {
    const supabase = createMockSupabase();

    await overrideGate(supabase, "task-1", "GATE 1 — PRD");
    expect(await isGateOverridden(supabase, "task-1", "GATE 1 — PRD")).toBe(true);
    expect(await isGateOverridden(supabase, "task-1", "GATE 2 — Architecture")).toBe(false);
    await clearGateOverrides(supabase, "task-1");
  });

  it("clearGateOverrides marks overrides as consumed", async () => {
    const supabase = createMockSupabase();

    await overrideGate(supabase, "task-2", "GATE 1 — PRD");
    await overrideGate(supabase, "task-2", "GATE 2 — Architecture");
    await clearGateOverrides(supabase, "task-2");
    expect(await isGateOverridden(supabase, "task-2", "GATE 1 — PRD")).toBe(false);
    expect(await isGateOverridden(supabase, "task-2", "GATE 2 — Architecture")).toBe(false);
  });

  it("checkGatesWithOverrides skips overridden gates", async () => {
    const supabase = createMockSupabase({
      prds: [],
      tasks: [{ id: "task-3", title: "Task", acceptance_criteria: "Given/When/Then" }],
    });

    const task = {
      id: "task-3",
      title: "Task",
      description: "A sufficiently detailed description",
      project: "my-app",
      sprint: "S14",
    };

    // Without override, gate 1 fails
    const result1 = await checkGatesWithOverrides(supabase, task);
    expect(result1).not.toBeNull();
    expect(result1!.gate).toContain("PRD");

    // Override gate 1
    await overrideGate(supabase, "task-3", result1!.gate);

    // Now gate 1 is skipped, should pass (task has acceptance_criteria)
    const result2 = await checkGatesWithOverrides(supabase, task);
    expect(result2).toBeNull();

    await clearGateOverrides(supabase, "task-3");
  });
});
