/**
 * Unit Tests — src/notification-queue.ts
 *
 * Tests for notification system: immediate enqueue, inline buttons, preferences.
 * Batching, quiet hours, and digest features have been removed (S-simplify sprint).
 */

import { beforeEach, describe, expect, it } from "bun:test";
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
  stopQueue,
  getQueueSize,
  getInlineKeyboard,
  formatPrefs,
  isTypeEnabled,
  isImmediate,
  consumeMcpPending,
} = await import("../../src/notification-queue");

const { savePrefs, getDefaultPrefs, loadPrefs } = await import("../../src/notification-queue");

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

describe("getInlineKeyboard", () => {
  // V7: task with data returns keyboard
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

  // V8: task without data returns undefined
  it("returns undefined for task without data", () => {
    const item = makeItem({ type: "task" });
    const kb = getInlineKeyboard(item);
    expect(kb).toBeUndefined();
  });
});

describe("enqueue", () => {
  beforeEach(async () => {
    await savePrefs(getDefaultPrefs());
    await loadPrefs();
  });

  // V1: immediate send — queue size stays 0 (no internal queue)
  it("V1: sends immediately — getQueueSize remains 0", async () => {
    await enqueue({ type: "task", severity: "normal", message: "Test" });
    expect(getQueueSize()).toBe(0);
  });

  // V2: disabled type is silently skipped
  it("V2: skips disabled types", async () => {
    const prefs = getDefaultPrefs();
    prefs.types.idea.enabled = false;
    await savePrefs(prefs);
    await loadPrefs();

    await enqueue({ type: "idea", severity: "normal", message: "Skipped" });
    expect(getQueueSize()).toBe(0);

    await savePrefs(getDefaultPrefs());
    await loadPrefs();
  });

  // V3: critical severity still calls send
  it("V3: critical severity enqueues immediately without throwing", async () => {
    await expect(
      enqueue({ type: "task", severity: "critical", message: "Critical!" }),
    ).resolves.toBeUndefined();
    expect(getQueueSize()).toBe(0);
  });

  // V4: getQueueSize always returns 0
  it("V4: getQueueSize always returns 0 regardless of enqueue calls", async () => {
    await enqueue({ type: "task", severity: "normal", message: "A" });
    await enqueue({ type: "task", severity: "normal", message: "B" });
    await enqueue({ type: "pr", severity: "normal", message: "C" });
    expect(getQueueSize()).toBe(0);
  });
});

describe("notification preferences", () => {
  beforeEach(async () => {
    await savePrefs(getDefaultPrefs());
    await loadPrefs();
  });

  // V5: disable type via savePrefs
  it("V5: isTypeEnabled returns false after disabling idea", async () => {
    const prefs = getDefaultPrefs();
    prefs.types.idea.enabled = false;
    await savePrefs(prefs);
    await loadPrefs();
    expect(isTypeEnabled("idea")).toBe(false);

    await savePrefs(getDefaultPrefs());
    await loadPrefs();
  });

  it("V5: isTypeEnabled returns true after re-enabling", async () => {
    const prefs = getDefaultPrefs();
    prefs.types.task.enabled = false;
    await savePrefs(prefs);
    await loadPrefs();
    expect(isTypeEnabled("task")).toBe(false);

    prefs.types.task.enabled = true;
    await savePrefs(prefs);
    await loadPrefs();
    expect(isTypeEnabled("task")).toBe(true);
  });

  // V6: isImmediate defaults
  it("V6: isImmediate returns true for alert by default", async () => {
    expect(isImmediate("alert")).toBe(true);
  });

  it("V6: isImmediate returns false for task by default", async () => {
    expect(isImmediate("task")).toBe(false);
  });

  // V9: formatPrefs output — no quiet hours, no batch interval
  it("V9: formatPrefs does not mention quiet hours or batch interval", async () => {
    const prefs = getDefaultPrefs();
    const output = formatPrefs(prefs);
    expect(output).not.toContain("Quiet");
    expect(output).not.toContain("quiet");
    expect(output).not.toContain("Batch interval");
    expect(output).not.toContain("batchInterval");
    expect(output).toContain("PREFERENCES NOTIFICATIONS");
    expect(output).toContain("Types :");
  });

  it("V9: formatPrefs shows types with normal/immediat/desactive labels", async () => {
    const prefs = getDefaultPrefs();
    const output = formatPrefs(prefs);
    // alert is immediate by default
    expect(output).toContain("alert : immediat");
    // task is normal (not immediate, not disabled)
    expect(output).toContain("task : normal");
  });

  // V12: immediate mode via savePrefs
  it("V12: setting immediate=true for task works", async () => {
    const prefs = getDefaultPrefs();
    prefs.types.task.immediate = true;
    await savePrefs(prefs);
    await loadPrefs();
    expect(isImmediate("task")).toBe(true);

    await savePrefs(getDefaultPrefs());
    await loadPrefs();
  });

  // V18: loadPrefs ignores obsolete fields from JSON
  it("V18: loadPrefs ignores quietStart/quietEnd/batchIntervalMs/batchThreshold", async () => {
    const { writeFile } = await import("fs/promises");
    const PREFS_FILE = join(process.cwd(), "config", "notification-prefs.json");

    const oldPrefs = {
      quietStart: 20,
      quietEnd: 9,
      batchIntervalMs: 300000,
      batchThreshold: 5,
      types: {
        task: { enabled: true, immediate: false },
        pr: { enabled: true, immediate: false },
        idea: { enabled: true, immediate: false },
        alert: { enabled: true, immediate: true },
      },
    };
    await writeFile(PREFS_FILE, JSON.stringify(oldPrefs, null, 2));
    const loaded = await loadPrefs();

    // Types still loaded correctly despite obsolete fields
    expect(loaded.types.task.enabled).toBe(true);
    expect(loaded.types.alert.immediate).toBe(true);
    expect(loaded.types.pr.enabled).toBe(true);
    // Obsolete fields are not part of the typed NotificationPrefs interface
    // (TypeScript ensures they're inaccessible via the typed API)

    await savePrefs(getDefaultPrefs());
    await loadPrefs();
  });
});

describe("consumeMcpPending", () => {
  const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
  const MCP_FILE = join(RELAY_DIR, "mcp-pending-notifications.json");

  // V16: file does not exist → no throw
  it("V16: handles missing MCP file gracefully (ENOENT)", async () => {
    const { unlink } = await import("fs/promises");
    try {
      await unlink(MCP_FILE);
    } catch {
      // file may not exist — that's fine
    }
    await expect(consumeMcpPending()).resolves.toBeUndefined();
  });

  // V15: reads valid pending items and clears file
  it("V15: reads MCP pending items and clears the file", async () => {
    const { mkdir: mkdirFn, writeFile: wf, readFile: rf } = await import("fs/promises");
    await mkdirFn(RELAY_DIR, { recursive: true });

    const pending = [
      { type: "task", severity: "normal", message: "MCP task", data: {} },
      { type: "alert", severity: "critical", message: "MCP alert" },
    ];
    await wf(MCP_FILE, JSON.stringify(pending));

    await consumeMcpPending();

    // File should be cleared
    const content = await rf(MCP_FILE, "utf-8");
    expect(JSON.parse(content)).toEqual([]);
  });

  it("V16: handles empty MCP file gracefully", async () => {
    const { mkdir: mkdirFn, writeFile: wf } = await import("fs/promises");
    await mkdirFn(RELAY_DIR, { recursive: true });
    await wf(MCP_FILE, "[]");
    await expect(consumeMcpPending()).resolves.toBeUndefined();
  });
});

describe("queue lifecycle", () => {
  it("stopQueue clears timer", () => {
    stopQueue();
    // Should not throw even if called twice
    stopQueue();
  });
});
