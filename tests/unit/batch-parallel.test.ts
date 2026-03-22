/**
 * Unit Tests — src/auto-pipeline.ts batch parallel (S25 T8)
 *
 * Tests for parallel batch execution architecture.
 * Does NOT call runBatchPipeline with real tasks (that spawns Claude).
 * Instead tests the Semaphore integration pattern and empty batch.
 */

import { describe, expect, it } from "bun:test";
import { runBatchPipeline } from "../../src/auto-pipeline";
import { Semaphore } from "../../src/semaphore";

describe("runBatchPipeline", () => {
  it("batch with empty tasks returns empty array (AC-020)", async () => {
    const results = await runBatchPipeline(null, [], { maxConcurrency: 2 });
    expect(results).toHaveLength(0);
  });

  it("batch with empty tasks in sequential mode returns empty array", async () => {
    const results = await runBatchPipeline(null, [], { maxConcurrency: 1 });
    expect(results).toHaveLength(0);
  });

  it("Semaphore integration: parallel pattern limits concurrency (AC-019)", async () => {
    // Test the semaphore pattern used by runBatchPipeline
    const semaphore = new Semaphore(2);
    let maxConcurrent = 0;
    let running = 0;

    const tasks = Array.from({ length: 5 }, (_, i) => i);
    const results: number[] = [];

    await Promise.allSettled(
      tasks.map(async (taskIdx) => {
        await semaphore.acquire();
        try {
          running++;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((r) => setTimeout(r, 10));
          results.push(taskIdx);
          running--;
        } finally {
          semaphore.release();
        }
      }),
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(5);
  });

  it("one task failure doesn't stop others in parallel pattern (AC-021)", async () => {
    const semaphore = new Semaphore(3);
    const results: Array<{ idx: number; success: boolean }> = [];

    const settled = await Promise.allSettled(
      [0, 1, 2, 3, 4].map(async (idx) => {
        await semaphore.acquire();
        try {
          if (idx === 2) throw new Error("Task 2 failed");
          await new Promise((r) => setTimeout(r, 5));
          results.push({ idx, success: true });
          return { idx, success: true };
        } finally {
          semaphore.release();
        }
      }),
    );

    // All tasks should complete (4 success, 1 rejected)
    expect(settled).toHaveLength(5);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(1);
  });
});
