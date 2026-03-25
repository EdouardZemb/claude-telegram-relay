/**
 * Unit Tests — SDD Pipeline <-> Backlog bidirectional link
 *
 * V-criteria:
 * V1: PipelineTracker has optional taskId field
 * V2: createPipeline accepts optional taskId, stored in tracker
 * V3: Task interface has optional sdd_pipeline_name field
 * V4: addTask accepts sdd_pipeline_name in opts
 * V5: formatBacklog shows [SDD] indicator for tasks with sdd_pipeline_name
 * V6: Phase mapping: explore/discuss/spec/challenge -> in_progress
 * V7: Phase mapping: implement/review -> review
 * V8: Phase mapping: doc (ok) -> done
 * V9: syncTaskStatus is best-effort (no throw if taskId missing)
 * V10: getTaskById returns task by id prefix
 * V11: createPipeline with taskId stores bidirectional link
 * V12: Backward-compat: trackers without taskId load fine
 * V13: SQL schema has sdd_pipeline_name column
 * V14: formatBacklog [SDD] indicator placement correct
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { _clearForTests, createPipeline, getTracker } from "../../src/pipeline-tracker.ts";
import { PHASE_TO_TASK_STATUS, syncTaskStatusForPhase } from "../../src/sdd-task-sync.ts";
import { addTask, formatBacklog, type Task } from "../../src/tasks.ts";
import { createMockSupabase } from "../fixtures/mock-supabase.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-sdd-backlog-link");
const PIPELINES_FILE = join(TEST_DIR, "pipelines.json");

const origRelayDir = process.env.RELAY_DIR;

describe("SDD-Backlog Link", () => {
  beforeEach(async () => {
    process.env.RELAY_DIR = TEST_DIR;
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await mkdir(TEST_DIR, { recursive: true });
    _clearForTests();
  });

  afterEach(async () => {
    _clearForTests();
    process.env.RELAY_DIR = origRelayDir;
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  // ── V1: PipelineTracker has optional taskId ──────────────────

  describe("PipelineTracker taskId field", () => {
    it("V1: tracker created without taskId has undefined taskId", async () => {
      const tracker = await createPipeline(12345, undefined, "test-pipeline");
      expect(tracker.taskId).toBeUndefined();
    });

    it("V2: createPipeline with taskId stores it in tracker", async () => {
      const tracker = await createPipeline(12345, undefined, "test-pipeline", {
        taskId: "abc-123-def",
      });
      expect(tracker.taskId).toBe("abc-123-def");
    });

    it("V11: taskId persists to disk and survives reload", async () => {
      await createPipeline(12345, undefined, "test-pipeline", {
        taskId: "abc-123-def",
      });
      _clearForTests();
      const tracker = await getTracker(12345, undefined);
      expect(tracker).not.toBeNull();
      expect(tracker!.taskId).toBe("abc-123-def");
    });

    it("V12: backward-compat — trackers without taskId load fine", async () => {
      const oldTracker = {
        chatId: 12345,
        name: "old-pipeline",
        steps: {
          explore: { phase: "explore", status: "ok" },
          discuss: { phase: "discuss", status: "pending" },
          spec: { phase: "spec", status: "pending" },
          challenge: { phase: "challenge", status: "pending" },
          implement: { phase: "implement", status: "pending" },
          review: { phase: "review", status: "pending" },
          doc: { phase: "doc", status: "pending" },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Note: no taskId field
      };

      _clearForTests();
      const entries = [{ key: "12345:main", tracker: oldTracker }];
      await writeFile(PIPELINES_FILE, JSON.stringify(entries, null, 2));

      const tracker = await getTracker(12345, undefined);
      expect(tracker).not.toBeNull();
      expect(tracker!.taskId).toBeUndefined();
      expect(tracker!.name).toBe("old-pipeline");
    });
  });

  // ── V3, V4: Task interface sdd_pipeline_name ──────────────────

  describe("Task sdd_pipeline_name field", () => {
    it("V3: Task interface accepts sdd_pipeline_name", () => {
      const task: Partial<Task> = {
        id: "abc",
        title: "SDD Task",
        sdd_pipeline_name: "my-pipeline",
      };
      expect(task.sdd_pipeline_name).toBe("my-pipeline");
    });

    it("V4: addTask with sdd_pipeline_name stores it", async () => {
      const supabase = createMockSupabase();
      const task = await addTask(supabase, "SDD Task", {
        sdd_pipeline_name: "my-pipeline",
        tags: ["sdd-pipeline"],
      });
      expect(task).not.toBeNull();
      expect(task!.title).toBe("SDD Task");
      expect(task!.sdd_pipeline_name).toBe("my-pipeline");
      expect(task!.tags).toContain("sdd-pipeline");
    });

    it("V4: addTask without sdd_pipeline_name has null value", async () => {
      const supabase = createMockSupabase();
      const task = await addTask(supabase, "Regular Task");
      expect(task).not.toBeNull();
      expect(task!.sdd_pipeline_name).toBeNull();
    });
  });

  // ── V5, V14: formatBacklog [SDD] indicator ─────────────────────

  describe("formatBacklog SDD indicator", () => {
    it("V5: shows [SDD] for tasks with sdd_pipeline_name", () => {
      const tasks: Task[] = [
        {
          id: "abcd1234-0000-0000-0000-000000000001",
          title: "Refactoring memoire",
          status: "in_progress",
          priority: 2,
          sprint: "S12",
          sdd_pipeline_name: "refactoring-memoire",
          tags: ["sdd-pipeline"],
        } as Task,
        {
          id: "abcd1234-0000-0000-0000-000000000002",
          title: "Fix bug",
          status: "in_progress",
          priority: 1,
          sprint: "S12",
          sdd_pipeline_name: null,
          tags: [],
        } as Task,
      ];

      const result = formatBacklog(tasks);
      expect(result).toContain("[SDD]");
      expect(result).toContain("Refactoring memoire");
      // [SDD] should appear near "Refactoring memoire" but not near "Fix bug"
      const lines = result.split("\n");
      const sddLine = lines.find((l) => l.includes("Refactoring memoire"));
      const normalLine = lines.find((l) => l.includes("Fix bug"));
      expect(sddLine).toContain("[SDD]");
      expect(normalLine).not.toContain("[SDD]");
    });

    it("V14: [SDD] indicator is placed before the title", () => {
      const tasks: Task[] = [
        {
          id: "abcd1234-0000-0000-0000-000000000001",
          title: "Pipeline task",
          status: "backlog",
          priority: 3,
          sprint: null,
          sdd_pipeline_name: "pipeline-task",
          tags: ["sdd-pipeline"],
        } as Task,
      ];

      const result = formatBacklog(tasks);
      const line = result.split("\n").find((l) => l.includes("Pipeline task"));
      expect(line).toBeDefined();
      // [SDD] should come before the title in the line
      const sddIdx = line!.indexOf("[SDD]");
      const titleIdx = line!.indexOf("Pipeline task");
      expect(sddIdx).toBeLessThan(titleIdx);
    });
  });

  // ── V6, V7, V8: Phase-to-status mapping ───────────────────────

  describe("PHASE_TO_TASK_STATUS mapping", () => {
    it("V6: explore/discuss/spec/challenge map to in_progress", () => {
      expect(PHASE_TO_TASK_STATUS.explore).toBe("in_progress");
      expect(PHASE_TO_TASK_STATUS.discuss).toBe("in_progress");
      expect(PHASE_TO_TASK_STATUS.spec).toBe("in_progress");
      expect(PHASE_TO_TASK_STATUS.challenge).toBe("in_progress");
    });

    it("V7: implement/review map to review", () => {
      expect(PHASE_TO_TASK_STATUS.implement).toBe("review");
      expect(PHASE_TO_TASK_STATUS.review).toBe("review");
    });

    it("V8: doc maps to done", () => {
      expect(PHASE_TO_TASK_STATUS.doc).toBe("done");
    });
  });

  // ── V9: syncTaskStatusForPhase best-effort ─────────────────────

  describe("syncTaskStatusForPhase", () => {
    it("V9: no-op when taskId is undefined (no throw)", async () => {
      const supabase = createMockSupabase();
      // Should not throw
      await syncTaskStatusForPhase(supabase, undefined, "explore", "ok");
    });

    it("V9: no-op when phase status is not ok (only sync on success)", async () => {
      const supabase = createMockSupabase({
        tasks: [{ id: "t1", title: "Task", status: "backlog", priority: 3 }],
      });
      await syncTaskStatusForPhase(supabase, "t1", "explore", "running");
      // Task status should remain unchanged
      const tasks = supabase._getTable("tasks");
      expect(tasks[0].status).toBe("backlog");
    });

    it("syncs task to in_progress when explore phase completes", async () => {
      const supabase = createMockSupabase({
        tasks: [{ id: "t1", title: "Task", status: "backlog", priority: 3 }],
      });
      await syncTaskStatusForPhase(supabase, "t1", "explore", "ok");
      const tasks = supabase._getTable("tasks");
      expect(tasks[0].status).toBe("in_progress");
    });

    it("syncs task to review when implement phase completes", async () => {
      const supabase = createMockSupabase({
        tasks: [{ id: "t1", title: "Task", status: "in_progress", priority: 3 }],
      });
      await syncTaskStatusForPhase(supabase, "t1", "implement", "ok");
      const tasks = supabase._getTable("tasks");
      expect(tasks[0].status).toBe("review");
    });

    it("syncs task to done when doc phase completes", async () => {
      const supabase = createMockSupabase({
        tasks: [{ id: "t1", title: "Task", status: "review", priority: 3 }],
      });
      await syncTaskStatusForPhase(supabase, "t1", "doc", "ok");
      const tasks = supabase._getTable("tasks");
      expect(tasks[0].status).toBe("done");
    });

    it("V15: does not downgrade: in_progress not changed if already in review", async () => {
      const supabase = createMockSupabase({
        tasks: [{ id: "t1", title: "Task", status: "review", priority: 3 }],
      });
      // explore phase ok would try to set in_progress, but task is already in review
      await syncTaskStatusForPhase(supabase, "t1", "explore", "ok");
      const tasks = supabase._getTable("tasks");
      expect(tasks[0].status).toBe("review");
    });

    it("V16: no-op when stepStatus is failed", async () => {
      const supabase = createMockSupabase({
        tasks: [{ id: "t1", title: "Task", status: "backlog", priority: 3 }],
      });
      await syncTaskStatusForPhase(supabase, "t1", "explore", "failed");
      const tasks = supabase._getTable("tasks");
      expect(tasks[0].status).toBe("backlog");
    });
  });

  // ── V10: getTaskById ──────────────────────────────────────────

  describe("getTaskById", () => {
    it("V10: finds task by full UUID", async () => {
      const { getTaskById } = await import("../../src/tasks.ts");
      const supabase = createMockSupabase({
        tasks: [
          { id: "abcd1234-5678-9abc-def0-111111111111", title: "My Task", status: "backlog" },
        ],
      });
      const task = await getTaskById(supabase, "abcd1234-5678-9abc-def0-111111111111");
      expect(task).not.toBeNull();
      expect(task!.title).toBe("My Task");
    });

    it("V10: returns null for non-existent id", async () => {
      const { getTaskById } = await import("../../src/tasks.ts");
      const supabase = createMockSupabase({ tasks: [] });
      const task = await getTaskById(supabase, "nonexistent");
      expect(task).toBeNull();
    });
  });

  // ── V13: SQL schema check ──────────────────────────────────────

  describe("SQL schema", () => {
    it("V13: schema.sql contains sdd_pipeline_name column", async () => {
      const { readFile } = await import("fs/promises");
      const { join: pjoin } = await import("path");
      const schema = await readFile(
        pjoin(import.meta.dir, "..", "..", "db", "schema.sql"),
        "utf-8",
      );
      expect(schema).toContain("sdd_pipeline_name");
    });
  });
});
