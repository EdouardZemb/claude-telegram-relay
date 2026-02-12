/**
 * Unit Tests — src/tasks.ts
 *
 * Tests for task CRUD, backlog queries, and formatting.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  addTask,
  getBacklog,
  updateTaskStatus,
  assignSprint,
  getCurrentSprint,
  formatTask,
  formatBacklog,
  formatSprintSummary,
  type Task,
} from "../../src/tasks";

describe("Task CRUD", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("addTask creates a task with defaults", async () => {
    const task = await addTask(supabase, "Test task");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Test task");
    expect(task!.project).toBe("telegram-relay");
    expect(task!.priority).toBe(3);
    expect(task!.sprint).toBeNull();
    expect(task!.tags).toEqual([]);
  });

  it("addTask creates a task with custom options", async () => {
    const task = await addTask(supabase, "Custom task", {
      description: "A detailed description",
      project: "other-project",
      priority: 1,
      sprint: "S12",
      tags: ["urgent", "bug"],
    });

    expect(task!.title).toBe("Custom task");
    expect(task!.description).toBe("A detailed description");
    expect(task!.project).toBe("other-project");
    expect(task!.priority).toBe(1);
    expect(task!.sprint).toBe("S12");
    expect(task!.tags).toEqual(["urgent", "bug"]);
  });

  it("addTask generates an id and created_at", async () => {
    const task = await addTask(supabase, "With ID");
    expect(task!.id).toBeDefined();
    expect(task!.created_at).toBeDefined();
  });
});

describe("Backlog Queries", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      tasks: [
        { id: "1", title: "Task A", status: "backlog", priority: 1, sprint: "S11", project: "telegram-relay", created_at: "2026-02-01" },
        { id: "2", title: "Task B", status: "in_progress", priority: 2, sprint: "S11", project: "telegram-relay", created_at: "2026-02-02" },
        { id: "3", title: "Task C", status: "done", priority: 3, sprint: "S11", project: "telegram-relay", created_at: "2026-02-03" },
        { id: "4", title: "Task D", status: "cancelled", priority: 4, sprint: "S11", project: "telegram-relay", created_at: "2026-02-04" },
        { id: "5", title: "Task E", status: "backlog", priority: 2, sprint: "S12", project: "other", created_at: "2026-02-05" },
      ],
    });
  });

  it("getBacklog excludes cancelled tasks", async () => {
    const tasks = await getBacklog(supabase);
    expect(tasks.every((t: Task) => t.status !== "cancelled")).toBe(true);
  });

  it("getBacklog filters by sprint", async () => {
    const tasks = await getBacklog(supabase, { sprint: "S11" });
    expect(tasks.every((t: Task) => t.sprint === "S11")).toBe(true);
  });

  it("getBacklog filters by project", async () => {
    const tasks = await getBacklog(supabase, { project: "other" });
    expect(tasks.every((t: Task) => t.project === "other")).toBe(true);
  });

  it("getBacklog filters by status", async () => {
    const tasks = await getBacklog(supabase, { status: "backlog" });
    expect(tasks.every((t: Task) => t.status === "backlog")).toBe(true);
  });

  it("getBacklog returns empty for no matches", async () => {
    const tasks = await getBacklog(supabase, { sprint: "S99" });
    expect(tasks.length).toBe(0);
  });
});

describe("Task Updates", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Task 1", status: "backlog", priority: 2, sprint: "S11" },
      ],
    });
  });

  it("updateTaskStatus changes the status", async () => {
    const task = await updateTaskStatus(supabase, "t1", "in_progress");
    expect(task).not.toBeNull();
    expect(task!.status).toBe("in_progress");
  });

  it("updateTaskStatus sets completed_at when done", async () => {
    const task = await updateTaskStatus(supabase, "t1", "done");
    expect(task!.status).toBe("done");
    expect(task!.completed_at).toBeDefined();
  });

  it("assignSprint changes the sprint", async () => {
    const task = await assignSprint(supabase, "t1", "S12");
    expect(task!.sprint).toBe("S12");
  });
});

describe("getCurrentSprint", () => {
  it("returns the most recent active sprint", async () => {
    const supabase = createMockSupabase({
      tasks: [
        { id: "1", sprint: "S11", status: "done", created_at: "2026-02-01" },
        { id: "2", sprint: "S12", status: "in_progress", created_at: "2026-02-10" },
      ],
    });

    const sprint = await getCurrentSprint(supabase);
    expect(sprint).toBe("S12");
  });

  it("returns null when no active tasks", async () => {
    const supabase = createMockSupabase({
      tasks: [
        { id: "1", sprint: "S11", status: "done", created_at: "2026-02-01" },
      ],
    });

    const sprint = await getCurrentSprint(supabase);
    expect(sprint).toBeNull();
  });
});

// ── Formatting ───────────────────────────────────────────────

describe("Task Formatting", () => {
  it("formatTask produces readable output", () => {
    const task = {
      id: "abc123",
      title: "Fix bug",
      status: "in_progress" as const,
      priority: 1,
      sprint: "S12",
    } as Task;

    const result = formatTask(task, 0);
    expect(result).toContain("1.");
    expect(result).toContain("[>]");
    expect(result).toContain("P1");
    expect(result).toContain("Fix bug");
    expect(result).toContain("S12");
  });

  it("formatTask handles missing sprint", () => {
    const task = {
      id: "abc",
      title: "No sprint",
      status: "backlog" as const,
      priority: 3,
      sprint: null,
    } as Task;

    const result = formatTask(task);
    expect(result).not.toContain("null");
    expect(result).toContain("No sprint");
  });

  it("formatBacklog groups by status", () => {
    const tasks: Task[] = [
      { id: "1", title: "A", status: "in_progress", priority: 1, sprint: "S12" } as Task,
      { id: "2", title: "B", status: "backlog", priority: 2, sprint: "S12" } as Task,
      { id: "3", title: "C", status: "done", priority: 3, sprint: "S12" } as Task,
    ];

    const result = formatBacklog(tasks);
    expect(result).toContain("En cours");
    expect(result).toContain("A faire");
    expect(result).toContain("Fait");
  });

  it("formatBacklog returns empty message", () => {
    expect(formatBacklog([])).toContain("Backlog vide");
  });

  it("formatSprintSummary produces correct output", () => {
    const result = formatSprintSummary("S12", {
      total: 16,
      backlog: 3,
      in_progress: 2,
      review: 1,
      done: 10,
    });

    expect(result).toContain("S12");
    expect(result).toContain("10/16");
    expect(result).toContain("63%");
  });
});
