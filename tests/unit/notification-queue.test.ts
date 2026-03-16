/**
 * Unit Tests — src/notification-queue.ts
 *
 * Tests for notification queue, batching, digest formatting, inline buttons.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";

// Set env before imports
process.env.TELEGRAM_GROUP_ID = "123456";
process.env.DEV_THREAD_ID = "100";
process.env.SPRINT_THREAD_ID = "200";
process.env.TELEGRAM_USER_ID = "999";
process.env.USER_TIMEZONE = "Europe/Paris";

import type { NotificationItem } from "../../src/notification-queue";

const {
  enqueue,
  flush,
  flushMorningDigest,
  getQueue,
  loadQueue,
  startQueue,
  stopQueue,
  getQueueSize,
  formatDigest,
  formatMorningDigest,
  getInlineKeyboard,
} = await import("../../src/notification-queue");

const { savePrefs, getDefaultPrefs, loadPrefs } = await import("../../src/notification-prefs");

function makeItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: crypto.randomUUID(),
    type: "task",
    severity: "normal",
    message: "Test notification",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("formatDigest", () => {
  it("groups items by type with priority ordering", () => {
    const items = [
      makeItem({ type: "idea", message: "New idea" }),
      makeItem({ type: "alert", message: "Alert!" }),
      makeItem({ type: "task", message: "Task done" }),
    ];
    const result = formatDigest(items);

    const alertIdx = result.indexOf("ALERTES");
    const taskIdx = result.indexOf("TACHES");
    const ideaIdx = result.indexOf("IDEES");

    expect(alertIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThan(alertIdx);
    expect(ideaIdx).toBeGreaterThan(taskIdx);
  });

  it("shows counts per type", () => {
    const items = [
      makeItem({ type: "task", message: "Task 1" }),
      makeItem({ type: "task", message: "Task 2" }),
      makeItem({ type: "alert", message: "Alert 1" }),
    ];
    const result = formatDigest(items);
    expect(result).toContain("TACHES (2)");
    expect(result).toContain("ALERTES (1)");
  });

  it("collapses after 10 items", () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      makeItem({ type: "task", message: `Task ${i}` })
    );
    const result = formatDigest(items);
    expect(result).toContain("+ 5 autres notifications");
  });

  it("handles empty array", () => {
    const result = formatDigest([]);
    expect(result).toBe("");
  });

  it("handles single item", () => {
    const items = [makeItem({ type: "pr", message: "PR created" })];
    const result = formatDigest(items);
    expect(result).toContain("PULL REQUESTS (1)");
    expect(result).toContain("PR created");
  });
});

describe("formatMorningDigest", () => {
  it("includes time range header", () => {
    const items = [
      makeItem({ createdAt: Date.now() - 3600000 }),
      makeItem({ createdAt: Date.now() }),
    ];
    const result = formatMorningDigest(items);
    expect(result).toContain("Resume");
    expect(result).toContain("2 notifications");
  });

  it("returns empty string for empty array", () => {
    expect(formatMorningDigest([])).toBe("");
  });

  it("singular for 1 notification", () => {
    const items = [makeItem()];
    const result = formatMorningDigest(items);
    expect(result).toContain("1 notification");
    expect(result).not.toContain("notifications");
  });
});

describe("getInlineKeyboard", () => {
  it("returns start+view buttons for backlog task", () => {
    const item = makeItem({
      type: "task",
      data: { taskId: "abc123", taskStatus: "backlog" },
    });
    const kb = getInlineKeyboard(item);
    expect(kb).toBeDefined();
  });

  it("returns done+view buttons for in_progress task", () => {
    const item = makeItem({
      type: "task",
      data: { taskId: "abc123", taskStatus: "in_progress" },
    });
    const kb = getInlineKeyboard(item);
    expect(kb).toBeDefined();
  });

  it("returns URL button for PR", () => {
    const item = makeItem({
      type: "pr",
      data: { prUrl: "https://github.com/pr/1" },
    });
    const kb = getInlineKeyboard(item);
    expect(kb).toBeDefined();
  });

  it("returns promote+archive buttons for idea", () => {
    const item = makeItem({
      type: "idea",
      data: { ideaId: "idea123" },
    });
    const kb = getInlineKeyboard(item);
    expect(kb).toBeDefined();
  });

  it("returns alert buttons with dismiss", () => {
    const item = makeItem({
      type: "alert",
      data: { alertType: "stuck_task", taskId: "t1" },
    });
    const kb = getInlineKeyboard(item);
    expect(kb).toBeDefined();
  });

  it("returns undefined for task without data", () => {
    const item = makeItem({ type: "task" });
    const kb = getInlineKeyboard(item);
    expect(kb).toBeUndefined();
  });
});

describe("enqueue", () => {
  beforeEach(async () => {
    // Reset prefs to defaults
    const prefs = getDefaultPrefs();
    // Disable quiet hours for tests
    prefs.quietStart = 0;
    prefs.quietEnd = 0;
    // High threshold so batch doesn't auto-flush
    prefs.batchThreshold = 100;
    await savePrefs(prefs);
    await loadPrefs();
    // Clear queue
    while (getQueue().length > 0) getQueue().pop();
  });

  it("adds normal items to queue", async () => {
    await enqueue({ type: "task", severity: "normal", message: "Test" });
    expect(getQueueSize()).toBe(1);
  });

  it("skips disabled types", async () => {
    const prefs = getDefaultPrefs();
    prefs.quietStart = 0;
    prefs.quietEnd = 0;
    prefs.batchThreshold = 100;
    prefs.types.idea.enabled = false;
    await savePrefs(prefs);
    await loadPrefs();

    await enqueue({ type: "idea", severity: "normal", message: "Skipped" });
    expect(getQueueSize()).toBe(0);

    // Restore defaults to avoid leaking to other test files
    const restored = getDefaultPrefs();
    restored.quietStart = 0;
    restored.quietEnd = 0;
    restored.batchThreshold = 100;
    await savePrefs(restored);
    await loadPrefs();
  });

  it("assigns unique IDs and timestamps", async () => {
    await enqueue({ type: "task", severity: "normal", message: "A" });
    await enqueue({ type: "task", severity: "normal", message: "B" });
    const q = getQueue();
    expect(q[0].id).not.toBe(q[1].id);
    expect(q[0].createdAt).toBeLessThanOrEqual(q[1].createdAt);
  });
});

describe("flush", () => {
  beforeEach(async () => {
    const prefs = getDefaultPrefs();
    prefs.quietStart = 0;
    prefs.quietEnd = 0;
    prefs.batchThreshold = 100;
    await savePrefs(prefs);
    await loadPrefs();
    while (getQueue().length > 0) getQueue().pop();
  });

  it("clears queue after flush", async () => {
    await enqueue({ type: "task", severity: "normal", message: "A" });
    await enqueue({ type: "task", severity: "normal", message: "B" });
    expect(getQueueSize()).toBe(2);

    await flush();
    expect(getQueueSize()).toBe(0);
  });

  it("does nothing on empty queue", async () => {
    await flush(); // Should not throw
    expect(getQueueSize()).toBe(0);
  });
});

describe("queue lifecycle", () => {
  it("stopQueue clears timer", () => {
    stopQueue();
    // Should not throw even if called twice
    stopQueue();
  });
});
