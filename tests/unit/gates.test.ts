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
  it("passes when task has sufficient description", async () => {
    const supabase = createMockSupabase();

    const result = await checkGate2_Architecture(supabase, {
      id: "t1",
      title: "Implement feature",
      description: "Create a new REST endpoint /api/projects with CRUD operations and proper validation",
    });

    expect(result.passed).toBe(true);
  });

  it("fails when task has no description", async () => {
    const supabase = createMockSupabase();

    const result = await checkGate2_Architecture(supabase, {
      id: "t1",
      title: "Do something",
      description: null,
    });

    expect(result.passed).toBe(false);
    expect(result.overridable).toBe(true);
  });

  it("fails when description is too short", async () => {
    const supabase = createMockSupabase();

    const result = await checkGate2_Architecture(supabase, {
      id: "t1",
      title: "Task",
      description: "Fix bug",
    });

    expect(result.passed).toBe(false);
  });
});

describe("checkAllGates", () => {
  it("returns null when all gates pass", async () => {
    const supabase = createMockSupabase({
      prds: [{ id: "prd-1", title: "PRD", project: "my-app", status: "approved" }],
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
  it("overrideGate marks a gate as overridden", () => {
    overrideGate("task-1", "GATE 1 — PRD");
    expect(isGateOverridden("task-1", "GATE 1 — PRD")).toBe(true);
    expect(isGateOverridden("task-1", "GATE 2 — Architecture")).toBe(false);
    clearGateOverrides("task-1");
  });

  it("clearGateOverrides removes all overrides for a task", () => {
    overrideGate("task-2", "GATE 1 — PRD");
    overrideGate("task-2", "GATE 2 — Architecture");
    clearGateOverrides("task-2");
    expect(isGateOverridden("task-2", "GATE 1 — PRD")).toBe(false);
    expect(isGateOverridden("task-2", "GATE 2 — Architecture")).toBe(false);
  });

  it("checkGatesWithOverrides skips overridden gates", async () => {
    const supabase = createMockSupabase({ prds: [] });

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
    overrideGate("task-3", result1!.gate);

    // Now gate 1 is skipped, should pass (description is sufficient)
    const result2 = await checkGatesWithOverrides(supabase, task);
    expect(result2).toBeNull();

    clearGateOverrides("task-3");
  });
});
