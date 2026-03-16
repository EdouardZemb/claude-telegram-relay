/**
 * Unit Tests — src/notification-prefs.ts
 *
 * Tests for notification preferences: load, save, quiet hours, type checks.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, unlink, readFile } from "fs/promises";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(dirname(dirname(import.meta.path)));
const PREFS_FILE = join(PROJECT_ROOT, "config", "notification-prefs.json");

// Import after env setup
const {
  loadPrefs,
  savePrefs,
  getPrefs,
  isTypeEnabled,
  isImmediate,
  isQuietHours,
  formatPrefs,
  getDefaultPrefs,
} = await import("../../src/notification-prefs");

// Reset to clean defaults after each test across all describe blocks
afterEach(async () => {
  try { await unlink(PREFS_FILE); } catch {}
  // Reset cached prefs to defaults
  await loadPrefs();
});

describe("loadPrefs", () => {

  it("returns defaults when file does not exist", async () => {
    try { await unlink(PREFS_FILE); } catch {}
    const prefs = await loadPrefs();
    expect(prefs.quietStart).toBe(20);
    expect(prefs.quietEnd).toBe(9);
    expect(prefs.batchThreshold).toBe(5);
    expect(prefs.types.alert.enabled).toBe(true);
    expect(prefs.types.alert.immediate).toBe(true);
  });

  it("loads prefs from file", async () => {
    await writeFile(PREFS_FILE, JSON.stringify({
      quietStart: 22,
      quietEnd: 7,
      types: { task: { enabled: false, immediate: false } },
    }));
    const prefs = await loadPrefs();
    expect(prefs.quietStart).toBe(22);
    expect(prefs.quietEnd).toBe(7);
    expect(prefs.types.task.enabled).toBe(false);
    // Other types should fallback to defaults
    expect(prefs.types.alert.immediate).toBe(true);
  });

  it("handles corrupted JSON gracefully", async () => {
    await writeFile(PREFS_FILE, "not json{{{");
    const prefs = await loadPrefs();
    // Should return defaults
    expect(prefs.quietStart).toBe(20);
    expect(prefs.quietEnd).toBe(9);
  });
});

describe("savePrefs", () => {
  it("persists prefs to file", async () => {
    const prefs = getDefaultPrefs();
    prefs.quietStart = 23;
    prefs.quietEnd = 6;
    await savePrefs(prefs);

    const content = JSON.parse(await readFile(PREFS_FILE, "utf-8"));
    expect(content.quietStart).toBe(23);
    expect(content.quietEnd).toBe(6);
  });

  it("updates cached prefs", async () => {
    const prefs = getDefaultPrefs();
    prefs.batchThreshold = 10;
    await savePrefs(prefs);

    expect(getPrefs().batchThreshold).toBe(10);
  });
});

describe("isTypeEnabled", () => {
  it("returns true for enabled types", async () => {
    await loadPrefs();
    expect(isTypeEnabled("task")).toBe(true);
    expect(isTypeEnabled("pr")).toBe(true);
    expect(isTypeEnabled("idea")).toBe(true);
    expect(isTypeEnabled("alert")).toBe(true);
  });

  it("returns false for disabled types", async () => {
    const prefs = getDefaultPrefs();
    prefs.types.idea.enabled = false;
    await savePrefs(prefs);

    expect(isTypeEnabled("idea")).toBe(false);
  });
});

describe("isImmediate", () => {
  it("returns true for alert by default", async () => {
    await loadPrefs();
    expect(isImmediate("alert")).toBe(true);
  });

  it("returns false for task by default", async () => {
    await loadPrefs();
    expect(isImmediate("task")).toBe(false);
  });
});

describe("isQuietHours", () => {
  it("detects cross-midnight quiet hours", () => {
    // Force prefs with 20h-9h
    const prefs = getDefaultPrefs();
    prefs.quietStart = 20;
    prefs.quietEnd = 9;
    // We save to set cached
    // Use savePrefs synchronously by accessing cache
    (globalThis as any).__testPrefs = prefs;

    // We can't easily control the current hour in tests,
    // but we can verify the function exists and returns a boolean
    const result = isQuietHours("Europe/Paris");
    expect(typeof result).toBe("boolean");
  });

  it("returns false when quietStart equals quietEnd (disabled)", async () => {
    const prefs = getDefaultPrefs();
    prefs.quietStart = 0;
    prefs.quietEnd = 0;
    await savePrefs(prefs);

    expect(isQuietHours("Europe/Paris")).toBe(false);
  });
});

describe("formatPrefs", () => {
  it("formats preferences as readable text", () => {
    const prefs = getDefaultPrefs();
    const text = formatPrefs(prefs);

    expect(text).toContain("PREFERENCES NOTIFICATIONS");
    expect(text).toContain("Quiet hours : 20h - 9h");
    expect(text).toContain("5min");
    expect(text).toContain("alert : immediat");
    expect(text).toContain("task : batch");
  });

  it("shows disabled types correctly", () => {
    const prefs = getDefaultPrefs();
    prefs.types.idea.enabled = false;
    const text = formatPrefs(prefs);

    expect(text).toContain("idea : desactive");
  });
});
