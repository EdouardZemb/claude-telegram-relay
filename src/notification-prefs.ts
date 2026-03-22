/**
 * @module notification-prefs
 * @description Notification preferences: quiet hours, per-type enable/disable/immediate,
 * /notify command config.
 */

/**
 * Notification Preferences — S26 Smart Notifications
 *
 * Configurable preferences for notification batching, quiet hours,
 * and per-type enable/disable/immediate settings.
 * Persisted to config/notification-prefs.json.
 */

import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const PREFS_FILE = join(PROJECT_ROOT, "config", "notification-prefs.json");

export type NotificationType = "task" | "pr" | "idea" | "alert";

export interface TypePrefs {
  enabled: boolean;
  immediate: boolean;
}

export interface NotificationPrefs {
  quietStart: number; // hour 0-23
  quietEnd: number;   // hour 0-23
  batchIntervalMs: number;
  batchThreshold: number;
  types: Record<NotificationType, TypePrefs>;
}

const DEFAULT_PREFS: NotificationPrefs = {
  quietStart: 20,
  quietEnd: 9,
  batchIntervalMs: 5 * 60 * 1000, // 5 minutes
  batchThreshold: 5,
  types: {
    task: { enabled: true, immediate: false },
    pr: { enabled: true, immediate: false },
    idea: { enabled: true, immediate: false },
    alert: { enabled: true, immediate: true },
  },
};

let cachedPrefs: NotificationPrefs | null = null;

export async function loadPrefs(): Promise<NotificationPrefs> {
  try {
    const content = await readFile(PREFS_FILE, "utf-8");
    const parsed = JSON.parse(content);
    cachedPrefs = { ...DEFAULT_PREFS, ...parsed, types: { ...DEFAULT_PREFS.types, ...parsed.types } };
    return cachedPrefs!;
  } catch {
    cachedPrefs = getDefaultPrefs();
    return cachedPrefs;
  }
}

export async function savePrefs(prefs: NotificationPrefs): Promise<void> {
  cachedPrefs = prefs;
  await writeFile(PREFS_FILE, JSON.stringify(prefs, null, 2));
}

export function getPrefs(): NotificationPrefs {
  return cachedPrefs || { ...DEFAULT_PREFS, types: { ...DEFAULT_PREFS.types } };
}

export function isTypeEnabled(type: NotificationType): boolean {
  return getPrefs().types[type]?.enabled ?? true;
}

export function isImmediate(type: NotificationType): boolean {
  return getPrefs().types[type]?.immediate ?? false;
}

export function isQuietHours(timezone?: string): boolean {
  const prefs = getPrefs();
  const tz = timezone || process.env.USER_TIMEZONE || "Europe/Paris";
  const now = new Date();
  const currentHour = parseInt(
    now.toLocaleTimeString("en-US", { hour: "2-digit", hour12: false, timeZone: tz })
  );

  const { quietStart, quietEnd } = prefs;

  // Same-day range (e.g., 1h-6h)
  if (quietStart < quietEnd) {
    return currentHour >= quietStart && currentHour < quietEnd;
  }
  // Cross-midnight range (e.g., 20h-9h)
  if (quietStart > quietEnd) {
    return currentHour >= quietStart || currentHour < quietEnd;
  }
  // quietStart === quietEnd means no quiet hours
  return false;
}

export function formatPrefs(prefs: NotificationPrefs): string {
  const lines = [
    "PREFERENCES NOTIFICATIONS",
    "",
    `Quiet hours : ${prefs.quietStart}h - ${prefs.quietEnd}h`,
    `Batch : ${prefs.batchIntervalMs / 60000}min ou ${prefs.batchThreshold} messages`,
    "",
    "Types :",
  ];
  for (const [type, tp] of Object.entries(prefs.types)) {
    const status = tp.enabled ? (tp.immediate ? "immediat" : "batch") : "desactive";
    lines.push(`  ${type} : ${status}`);
  }
  return lines.join("\n");
}

export function getDefaultPrefs(): NotificationPrefs {
  return {
    ...DEFAULT_PREFS,
    types: {
      task: { ...DEFAULT_PREFS.types.task },
      pr: { ...DEFAULT_PREFS.types.pr },
      idea: { ...DEFAULT_PREFS.types.idea },
      alert: { ...DEFAULT_PREFS.types.alert },
    },
  };
}
