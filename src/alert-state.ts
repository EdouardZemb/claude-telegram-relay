/**
 * @module alert-state
 * @description Alert deduplication and cooldown persistence. Sits between
 * detection (alerts.ts) and sending (notification-queue.ts). Persists state
 * to config/alert-state.json with atomic writes.
 */

import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { join } from "path";
import type { Alert } from "./alerts.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const STATE_FILE = join(PROJECT_DIR, "config", "alert-state.json");
const COOLDOWNS_FILE = join(PROJECT_DIR, "config", "alert-cooldowns.json");

const CLEANUP_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48h

// ── Types ────────────────────────────────────────────────────

export interface AlertStateEntry {
  lastSentAt: number;
  severity: string;
  count: number;
  firstSeenAt: number;
  resolvedAt: number | null;
}

export interface AlertState {
  alerts: Record<string, AlertStateEntry>;
}

export interface AlertCooldowns {
  stuck_task?: number;
  high_rework?: number;
  behind_schedule?: number;
  long_running_step?: number;
  review_score_drop?: number;
  agent_failure_pattern?: number;
  stale_task?: number;
  default: number;
  critical_multiplier: number;
}

const DEFAULT_COOLDOWNS: AlertCooldowns = {
  stuck_task: 21600000,
  high_rework: 43200000,
  behind_schedule: 43200000,
  long_running_step: 21600000,
  review_score_drop: 43200000,
  agent_failure_pattern: 21600000,
  stale_task: 43200000,
  default: 21600000,
  critical_multiplier: 2,
};

// ── Key Generation ───────────────────────────────────────────

export function buildAlertKey(alert: Alert): string {
  const d = alert.data;
  switch (alert.type) {
    case "stuck_task":
    case "stale_task":
      return `${alert.type}:${d.taskId ?? "unknown"}`;
    case "high_rework":
    case "behind_schedule":
      return `${alert.type}:${d.sprintId ?? "unknown"}`;
    case "agent_failure_pattern":
      return `${alert.type}:${d.agent ?? d.role ?? "unknown"}`;
    case "review_score_drop":
    case "long_running_step":
      return alert.type;
    default:
      return alert.type;
  }
}

// ── Load / Save ──────────────────────────────────────────────

export async function loadAlertState(): Promise<AlertState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && parsed.alerts && typeof parsed.alerts === "object") {
      return parsed as AlertState;
    }
    return { alerts: {} };
  } catch {
    return { alerts: {} };
  }
}

export async function saveAlertState(state: AlertState): Promise<void> {
  const dir = join(PROJECT_DIR, "config");
  await mkdir(dir, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, STATE_FILE);
}

export async function loadCooldowns(): Promise<AlertCooldowns> {
  try {
    const content = await readFile(COOLDOWNS_FILE, "utf-8");
    const parsed = JSON.parse(content);
    return { ...DEFAULT_COOLDOWNS, ...parsed };
  } catch {
    return DEFAULT_COOLDOWNS;
  }
}

// ── Cooldown Logic ───────────────────────────────────────────

export function shouldSendAlert(
  key: string,
  alert: Alert,
  state: AlertState,
  cooldowns: AlertCooldowns,
  now: number = Date.now()
): boolean {
  const entry = state.alerts[key];

  // New alert — never sent before
  if (!entry) return true;

  // Get cooldown for this alert type
  const baseCooldown =
    (cooldowns as Record<string, number>)[alert.type] ?? cooldowns.default;

  // Critical severity multiplies the cooldown.
  // Escalated critical (already sent, count > 0) multiplies again.
  let effectiveCooldown = baseCooldown;
  if (alert.severity === "critical") {
    effectiveCooldown *= cooldowns.critical_multiplier;
    // Escalation: already sent at least once as critical
    if (entry.count > 0) {
      effectiveCooldown *= cooldowns.critical_multiplier;
    }
  }

  const elapsed = now - entry.lastSentAt;
  return elapsed >= effectiveCooldown;
}

// ── State Update ─────────────────────────────────────────────

export function markAlertSent(
  key: string,
  alert: Alert,
  state: AlertState,
  now: number = Date.now()
): void {
  const existing = state.alerts[key];
  state.alerts[key] = {
    lastSentAt: now,
    severity: alert.severity,
    count: (existing?.count ?? 0) + 1,
    firstSeenAt: existing?.firstSeenAt ?? now,
    resolvedAt: null,
  };
}

// ── Cleanup ──────────────────────────────────────────────────

export function cleanupResolvedAlerts(
  currentKeys: Set<string>,
  state: AlertState,
  now: number = Date.now()
): void {
  for (const [key, entry] of Object.entries(state.alerts)) {
    if (currentKeys.has(key)) {
      // Alert is still active — clear resolvedAt if it was previously marked
      if (entry.resolvedAt !== null) {
        entry.resolvedAt = null;
      }
      continue;
    }

    // Alert not in current keys
    if (entry.resolvedAt === null) {
      // First time absent — mark as resolved
      entry.resolvedAt = now;
    } else if (now - entry.resolvedAt >= CLEANUP_THRESHOLD_MS) {
      // Resolved for >48h — remove
      delete state.alerts[key];
    }
  }
}
