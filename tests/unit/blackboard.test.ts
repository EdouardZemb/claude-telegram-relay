/**
 * Unit Tests — src/blackboard.ts (S24 T1+T2+T6)
 *
 * Tests for blackboard CRUD, optimistic locking,
 * role authorization, overflow handling, and traceability.
 */

import { describe, expect, it } from "bun:test";
import {
  type BlackboardSections,
  createBlackboard,
  formatTraceabilityReport,
  generateTraceabilityReport,
  getFullBlackboard,
  InMemoryBlackboard,
  readSection,
  updateBlackboardStatus,
  writeSection,
} from "../../src/blackboard";
import { createMockSupabase } from "../fixtures/mock-supabase";

// ── createBlackboard ─────────────────────────────────────────

describe("createBlackboard", () => {
  it("creates a row with version=1 and empty sections (AC-001)", async () => {
    const supabase = createMockSupabase();
    const result = await createBlackboard(supabase, "task-1", "session-1", "DEFAULT");

    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.session_id).toBe("session-1");
    expect(result!.task_id).toBe("task-1");
    expect(result!.status).toBe("active");
    expect(result!.sections.spec).toBeNull();
    expect(result!.sections.plan).toBeNull();
    expect(result!.sections.tasks).toBeNull();
    expect(result!.sections.implementation).toBeNull();
    expect(result!.sections.verification).toBeNull();
  });

  it("stores pipeline_type and project_id", async () => {
    const supabase = createMockSupabase();
    const result = await createBlackboard(supabase, "task-1", "session-2", "QUICK", "proj-1");

    expect(result!.pipeline_type).toBe("QUICK");
    expect(result!.project_id).toBe("proj-1");
  });
});

// ── readSection ──────────────────────────────────────────────

describe("readSection", () => {
  it("returns only the requested section (AC-004)", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 2,
          sections: {
            spec: { title: "My Spec" },
            plan: { design: "My Plan" },
            tasks: null,
            implementation: null,
            verification: null,
          },
          status: "active",
        },
      ],
    });

    const spec = await readSection(supabase, "session-1", "spec");
    expect(spec).toEqual({ title: "My Spec" });

    const plan = await readSection(supabase, "session-1", "plan");
    expect(plan).toEqual({ design: "My Plan" });
  });

  it("returns null for empty section (EC-001)", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 1,
          sections: {
            spec: null,
            plan: null,
            tasks: null,
            implementation: null,
            verification: null,
          },
          status: "active",
        },
      ],
    });

    const result = await readSection(supabase, "session-1", "tasks");
    expect(result).toBeNull();
  });
});

// ── writeSection ─────────────────────────────────────────────

describe("writeSection", () => {
  it("increments version and updates section (AC-002)", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 1,
          sections: {
            spec: null,
            plan: null,
            tasks: null,
            implementation: null,
            verification: null,
          },
          history: [],
          status: "active",
        },
      ],
    });

    const result = await writeSection(
      supabase,
      "session-1",
      "spec",
      { title: "Test" },
      "analyst",
      1,
    );

    expect(result.success).toBe(true);
    expect(result.newVersion).toBe(2);
  });

  it("rejects writes from unauthorized roles (AC-005)", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 1,
          sections: {
            spec: null,
            plan: null,
            tasks: null,
            implementation: null,
            verification: null,
          },
          history: [],
          status: "active",
        },
      ],
    });

    // PM can't write to spec
    const result = await writeSection(supabase, "session-1", "spec", { title: "Test" }, "pm", 1);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });

  it("fails with stale version (AC-003)", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 5,
          sections: {
            spec: null,
            plan: null,
            tasks: null,
            implementation: null,
            verification: null,
          },
          history: [],
          status: "active",
        },
      ],
    });

    // Try writing with version 3 when current is 5
    const result = await writeSection(
      supabase,
      "session-1",
      "spec",
      { title: "Test" },
      "analyst",
      3,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Version conflict");
  });

  it("handles version overflow (EC-007)", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 100,
          sections: {
            spec: null,
            plan: null,
            tasks: null,
            implementation: null,
            verification: null,
          },
          history: [],
          status: "active",
        },
      ],
    });

    const result = await writeSection(
      supabase,
      "session-1",
      "spec",
      { title: "Test" },
      "analyst",
      100,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Version overflow");
  });

  it("system role can write to any section", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 1,
          sections: {
            spec: null,
            plan: null,
            tasks: null,
            implementation: null,
            verification: null,
          },
          history: [],
          status: "active",
        },
      ],
    });

    const result = await writeSection(
      supabase,
      "session-1",
      "plan",
      { design: "Test" },
      "system",
      1,
    );

    expect(result.success).toBe(true);
  });
});

// ── getFullBlackboard ────────────────────────────────────────

describe("getFullBlackboard", () => {
  it("returns all sections and metadata (AC-006)", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 3,
          sections: {
            spec: { title: "Spec" },
            plan: { design: "Plan" },
            tasks: null,
            implementation: null,
            verification: null,
          },
          history: [{ version: 2, section: "spec", timestamp: "2026-01-01", role: "analyst" }],
          status: "active",
          pipeline_type: "DEFAULT",
          task_id: "task-1",
        },
      ],
    });

    const result = await getFullBlackboard(supabase, "session-1");

    expect(result).not.toBeNull();
    expect(result!.version).toBe(3);
    expect(result!.sections.spec).toEqual({ title: "Spec" });
    expect(result!.sections.plan).toEqual({ design: "Plan" });
    expect(result!.history).toHaveLength(1);
    expect(result!.pipeline_type).toBe("DEFAULT");
  });
});

// ── updateBlackboardStatus ───────────────────────────────────

describe("updateBlackboardStatus", () => {
  it("updates status to completed", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-1",
          version: 1,
          status: "active",
        },
      ],
    });

    const result = await updateBlackboardStatus(supabase, "session-1", "completed");
    expect(result).toBe(true);
  });
});

// ── generateTraceabilityReport ───────────────────────────────

describe("generateTraceabilityReport", () => {
  it("maps FR to tasks, tests, and files (AC-020, AC-021, AC-022)", () => {
    const sections: BlackboardSections = {
      spec: {
        requirements: [
          { id: "FR-001", description: "Blackboard table" },
          { id: "FR-002", description: "API CRUD" },
          { id: "FR-003", description: "Evaluator" },
        ],
      },
      plan: null,
      tasks: {
        items: [
          { title: "Create table", traces_to: ["FR-001"] },
          { title: "Build API", traces_to: ["FR-002"] },
        ],
      },
      implementation: {
        files: [{ path: "src/blackboard.ts", traces_to: ["FR-001", "FR-002"] }],
      },
      verification: {
        tests: [{ name: "test create", validates: ["FR-001"] }],
      },
    };

    const report = generateTraceabilityReport(sections);

    expect(report.covered_fr).toContain("FR-001");
    expect(report.covered_fr).toContain("FR-002");
    expect(report.missing_fr).toContain("FR-003");
    expect(report.coverage_percentage).toBe(67); // 2/3
  });

  it("handles empty spec", () => {
    const sections: BlackboardSections = {
      spec: null,
      plan: null,
      tasks: null,
      implementation: null,
      verification: null,
    };

    const report = generateTraceabilityReport(sections);
    expect(report.coverage_percentage).toBe(0);
    expect(report.items).toHaveLength(0);
  });

  it("extracts FR from spec text when no requirements array", () => {
    const sections: BlackboardSections = {
      spec: "This spec covers FR-001 and FR-002.",
      plan: null,
      tasks: {
        items: [{ title: "Task 1", traces_to: ["FR-001"] }],
      },
      implementation: null,
      verification: null,
    };

    const report = generateTraceabilityReport(sections);
    expect(report.items).toHaveLength(2);
    expect(report.partially_covered_fr).toContain("FR-001");
    expect(report.missing_fr).toContain("FR-002");
  });

  it("reports missing FR when no tasks trace to it", () => {
    const sections: BlackboardSections = {
      spec: {
        requirements: [{ id: "FR-001" }, { id: "FR-002" }],
      },
      plan: null,
      tasks: { items: [] },
      implementation: null,
      verification: null,
    };

    const report = generateTraceabilityReport(sections);
    expect(report.missing_fr).toEqual(["FR-001", "FR-002"]);
    expect(report.coverage_percentage).toBe(0);
  });
});

// ── formatTraceabilityReport ─────────────────────────────────

describe("formatTraceabilityReport", () => {
  it("formats the report for display", () => {
    const report = {
      covered_fr: ["FR-001"],
      partially_covered_fr: ["FR-002"],
      missing_fr: ["FR-003"],
      coverage_percentage: 33,
      items: [],
    };

    const formatted = formatTraceabilityReport(report);
    expect(formatted).toContain("TRACEABILITY REPORT");
    expect(formatted).toContain("33%");
    expect(formatted).toContain("FR-001");
    expect(formatted).toContain("FR-003");
  });
});

// ── InMemoryBlackboard ───────────────────────────────────────

describe("InMemoryBlackboard", () => {
  it("creates and reads sections", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1", "DEFAULT");

    expect(bb.read("session-1", "spec")).toBeNull();

    const writeResult = bb.write("session-1", "spec", { title: "Test" }, "analyst", 1);
    expect(writeResult.success).toBe(true);
    expect(writeResult.newVersion).toBe(2);

    expect(bb.read("session-1", "spec")).toEqual({ title: "Test" });
  });

  it("rejects unauthorized role", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const result = bb.write("session-1", "spec", { title: "Test" }, "pm", 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });

  it("detects version conflict", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    bb.write("session-1", "spec", { v: 1 }, "analyst", 1);
    const result = bb.write("session-1", "spec", { v: 2 }, "analyst", 1); // stale version
    expect(result.success).toBe(false);
    expect(result.error).toContain("Version conflict");
  });

  it("concurrent sessions don't cross-contaminate (EC-003)", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");
    bb.create("task-2", "session-2");

    bb.write("session-1", "spec", { data: "A" }, "analyst", 1);
    bb.write("session-2", "spec", { data: "B" }, "analyst", 1);

    expect(bb.read("session-1", "spec")).toEqual({ data: "A" });
    expect(bb.read("session-2", "spec")).toEqual({ data: "B" });
  });

  it("returns full blackboard", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1", "DEFAULT");

    const full = bb.get("session-1");
    expect(full).not.toBeNull();
    expect(full!.session_id).toBe("session-1");
    expect(full!.pipeline_type).toBe("DEFAULT");
  });
});

// ── working_memory section (S36-07) ──────────────────────────

describe("working_memory section", () => {
  it("createBlackboard initializes working_memory as null", async () => {
    const supabase = createMockSupabase();
    const result = await createBlackboard(supabase, "task-1", "session-wm", "DEFAULT");

    expect(result).not.toBeNull();
    expect(result!.sections.working_memory).toBeNull();
  });

  it("all agent roles can write to working_memory", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const roles = ["analyst", "pm", "architect", "dev", "qa", "sm", "system"];
    for (const role of roles) {
      const result = bb.write(
        "session-1",
        "working_memory",
        { test: role },
        role,
        bb.get("session-1")!.version,
      );
      expect(result.success).toBe(true);
    }
  });

  it("stores working_memory with full structure", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const wmData = {
      decisions: [{ agent: "architect", decision: "Use REST API", reasoning: "Simpler" }],
      discoveries: [{ agent: "qa", fact: "85% coverage", source: "tests" }],
      blockers: [{ agent: "dev", issue: "API rate limited", status: "active" }],
      context_updates: [{ agent: "pm", key: "deadline", value: "2026-04-01" }],
    };

    const result = bb.write("session-1", "working_memory", wmData, "dev", 1);
    expect(result.success).toBe(true);

    const stored = bb.read("session-1", "working_memory");
    expect(stored.decisions).toHaveLength(1);
    expect(stored.decisions[0].decision).toBe("Use REST API");
    expect(stored.discoveries).toHaveLength(1);
    expect(stored.blockers).toHaveLength(1);
    expect(stored.context_updates).toHaveLength(1);
  });

  it("InMemoryBlackboard includes working_memory in sections", () => {
    const bb = new InMemoryBlackboard();
    const row = bb.create("task-1", "session-1");

    expect(row.sections).toHaveProperty("working_memory");
    expect(row.sections.working_memory).toBeNull();
  });

  it("Supabase writeSection accepts working_memory (role auth check)", async () => {
    const supabase = createMockSupabase({
      blackboard: [
        {
          id: "bb-1",
          session_id: "session-wm",
          version: 1,
          sections: {
            spec: null,
            plan: null,
            tasks: null,
            implementation: null,
            verification: null,
            working_memory: null,
          },
          history: [],
          status: "active",
        },
      ],
    });

    const result = await writeSection(
      supabase,
      "session-wm",
      "working_memory",
      { decisions: [], discoveries: [], blockers: [], context_updates: [] },
      "dev",
      1,
    );

    expect(result.success).toBe(true);
    expect(result.newVersion).toBe(2);
  });

  it("dev-sub-N roles can write to working_memory", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const result = bb.write("session-1", "working_memory", { test: true }, "dev-sub-0", 1);
    expect(result.success).toBe(true);
  });
});
