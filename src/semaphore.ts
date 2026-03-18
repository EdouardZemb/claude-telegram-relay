/**
 * @module semaphore
 * @description Promise-based counting semaphore for concurrency control (default max 3).
 */

/**
 * Semaphore — S25 T1
 *
 * Promise-based counting semaphore for concurrency control.
 * Used by DAG executor and parallel pipeline execution.
 */

export class Semaphore {
  private _max: number;
  private _current: number = 0;
  private _queue: Array<() => void> = [];

  constructor(maxConcurrency: number = 3) {
    this._max = Math.max(1, maxConcurrency);
  }

  get max(): number {
    return this._max;
  }

  get current(): number {
    return this._current;
  }

  get waiting(): number {
    return this._queue.length;
  }

  async acquire(): Promise<void> {
    if (this._current < this._max) {
      this._current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      // Don't decrement — the slot transfers directly to next waiter
      next();
    } else {
      this._current = Math.max(0, this._current - 1);
    }
  }
}
