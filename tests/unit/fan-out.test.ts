/**
 * Unit Tests — src/fan-out.ts (S25 T6)
 *
 * Tests for fan-out/fan-in with subtask parallelism.
 */

import { describe, it, expect } from "bun:test";
import {
  parseSubtasks,
  shouldFanOut,
  fanOut,
  type Subtask,
} from "../../src/fan-out";
import type { AgentStepResult } from "../../src/orchestrator";

describe("parseSubtasks", () => {
  it("parses subtasks from structured output", () => {
    const output = {
      subtasks: [
        { title: "Implement API", description: "REST endpoints", files: ["src/api.ts"] },
        { title: "Write tests", description: "Unit tests" },
      ],
    };

    const subtasks = parseSubtasks(output as any);
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].title).toBe("Implement API");
    expect(subtasks[0].files).toEqual(["src/api.ts"]);
    expect(subtasks[1].files).toEqual([]);
  });

  it("handles string-only subtasks", () => {
    const output = { subtasks: ["Task A", "Task B"] };
    const subtasks = parseSubtasks(output as any);
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].title).toBe("Task A");
  });

  it("returns empty for null output", () => {
    expect(parseSubtasks(null)).toHaveLength(0);
  });

  it("handles items field", () => {
    const output = {
      items: [{ title: "Item 1" }, { title: "Item 2" }],
    };
    const subtasks = parseSubtasks(output as any);
    expect(subtasks).toHaveLength(2);
  });
});

describe("shouldFanOut", () => {
  it("returns true with 2+ subtasks and parallel=true", () => {
    const subtasks: Subtask[] = [
      { title: "A" },
      { title: "B" },
    ];
    expect(shouldFanOut(subtasks, true)).toBe(true);
  });

  it("returns false with parallel=false", () => {
    const subtasks: Subtask[] = [
      { title: "A" },
      { title: "B" },
    ];
    expect(shouldFanOut(subtasks, false)).toBe(false);
  });

  it("returns false with 0-1 subtasks", () => {
    expect(shouldFanOut([], true)).toBe(false);
    expect(shouldFanOut([{ title: "A" }], true)).toBe(false);
  });
});

describe("fanOut", () => {
  it("launches N agents up to maxConcurrency (AC-004)", async () => {
    const subtasks: Subtask[] = [
      { title: "Sub 1", files: ["src/a.ts"] },
      { title: "Sub 2", files: ["src/b.ts"] },
      { title: "Sub 3", files: ["src/c.ts"] },
    ];

    let maxConcurrent = 0;
    let running = 0;

    const result = await fanOut(subtasks, "task-1", async (subtask, wtPath, idx) => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return {
        agentId: "dev" as any,
        agentName: `Dev-sub-${idx}`,
        success: true,
        output: `Done: ${subtask.title}`,
        structured: null,
        durationMs: 20,
      };
    }, { maxConcurrency: 2 });

    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.success)).toBe(true);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(result.sequential_fallback).toBe(false);
  });

  it("sequential fallback on file overlap (EC-001)", async () => {
    const subtasks: Subtask[] = [
      { title: "Sub 1", files: ["src/shared.ts"] },
      { title: "Sub 2", files: ["src/shared.ts"] },
    ];

    const result = await fanOut(subtasks, "task-1", async (subtask, wtPath, idx) => {
      // wtPath should be null in sequential fallback
      return {
        agentId: "dev" as any,
        agentName: `Dev-sub-${idx}`,
        success: true,
        output: `Done: ${subtask.title}`,
        structured: null,
        durationMs: 10,
      };
    });

    expect(result.sequential_fallback).toBe(true);
    expect(result.conflicts).toContain("src/shared.ts");
    expect(result.worktrees).toHaveLength(0);
    expect(result.results).toHaveLength(2);
  });

  it("failed agent still produces result (AC-006)", async () => {
    const subtasks: Subtask[] = [
      { title: "Good", files: ["src/a.ts"] },
      { title: "Bad", files: ["src/b.ts"] },
    ];

    const result = await fanOut(subtasks, "task-1", async (subtask, wtPath, idx) => {
      const success = subtask.title !== "Bad";
      return {
        agentId: "dev" as any,
        agentName: `Dev-sub-${idx}`,
        success,
        output: success ? "ok" : "",
        structured: null,
        error: success ? undefined : "failed",
        durationMs: 10,
      };
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.filter((r) => r.success)).toHaveLength(1);
    expect(result.results.filter((r) => !r.success)).toHaveLength(1);
  });

  it("no fan-out when PM produces 0-1 subtasks", () => {
    expect(shouldFanOut([], true)).toBe(false);
    expect(shouldFanOut([{ title: "Only one" }], true)).toBe(false);
  });
});
