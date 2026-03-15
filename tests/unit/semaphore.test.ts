/**
 * Unit Tests — src/semaphore.ts (S25 T1)
 *
 * Tests for counting semaphore: concurrency limits, FIFO ordering, mutex mode.
 */

import { describe, it, expect } from "bun:test";
import { Semaphore } from "../../src/semaphore";

describe("Semaphore", () => {
  it("respects maxConcurrency limit (EC-002)", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, (_, i) => async () => {
      await sem.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      running--;
      sem.release();
    });

    await Promise.all(tasks.map((t) => t()));

    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(sem.current).toBe(0);
  });

  it("releases in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    await sem.acquire();

    // Queue 3 waiters
    const p1 = sem.acquire().then(() => { order.push(1); sem.release(); });
    const p2 = sem.acquire().then(() => { order.push(2); sem.release(); });
    const p3 = sem.acquire().then(() => { order.push(3); sem.release(); });

    expect(sem.waiting).toBe(3);

    sem.release(); // unblocks p1
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("with concurrency 1 behaves as mutex", async () => {
    const sem = new Semaphore(1);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 4 }, () => async () => {
      await sem.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      sem.release();
    });

    await Promise.all(tasks.map((t) => t()));

    expect(maxRunning).toBe(1);
  });

  it("handles immediate acquisition when under capacity", async () => {
    const sem = new Semaphore(3);

    await sem.acquire();
    expect(sem.current).toBe(1);

    await sem.acquire();
    expect(sem.current).toBe(2);

    await sem.acquire();
    expect(sem.current).toBe(3);

    // Fourth should queue
    expect(sem.waiting).toBe(0);
    const p = sem.acquire();
    expect(sem.waiting).toBe(1);

    sem.release();
    await p;
    // Slot transferred directly, current stays at 3
    expect(sem.current).toBe(3);
    expect(sem.waiting).toBe(0);
  });

  it("exposes max and current properties", () => {
    const sem = new Semaphore(5);
    expect(sem.max).toBe(5);
    expect(sem.current).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it("enforces minimum concurrency of 1", () => {
    const sem = new Semaphore(0);
    expect(sem.max).toBe(1);

    const sem2 = new Semaphore(-5);
    expect(sem2.max).toBe(1);
  });
});
