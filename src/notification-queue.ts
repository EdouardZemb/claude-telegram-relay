/**
 * @module notification-queue
 * @description Notification batching queue: enqueue, flush, digest formatting,
 * inline buttons, quiet hours, morning digest, JSON persistence.
 */

/**
 * Notification Queue — S26 Smart Notifications
 *
 * Batches notifications, respects quiet hours, sends inline buttons
 * on standalone notifications, and produces morning digests.
 * Persistence via JSON file for crash recovery.
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { dirname, join } from "path";
import { createLogger } from "./logger.ts";

// ── Notification Preferences (inlined from notification-prefs.ts) ──

const PREFS_PROJECT_ROOT = dirname(dirname(import.meta.path));
const PREFS_FILE = join(PREFS_PROJECT_ROOT, "config", "notification-prefs.json");

export type NotificationType = "task" | "pr" | "idea" | "alert";

export interface TypePrefs {
  enabled: boolean;
  immediate: boolean;
}

export interface NotificationPrefs {
  quietStart: number;
  quietEnd: number;
  batchIntervalMs: number;
  batchThreshold: number;
  types: Record<NotificationType, TypePrefs>;
}

const DEFAULT_PREFS: NotificationPrefs = {
  quietStart: 20,
  quietEnd: 9,
  batchIntervalMs: 5 * 60 * 1000,
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
    const merged: NotificationPrefs = {
      ...DEFAULT_PREFS,
      ...parsed,
      types: { ...DEFAULT_PREFS.types, ...parsed.types },
    };
    cachedPrefs = merged;
    return merged;
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
    now.toLocaleTimeString("en-US", { hour: "2-digit", hour12: false, timeZone: tz }),
    10,
  );
  const { quietStart, quietEnd } = prefs;
  if (quietStart < quietEnd) return currentHour >= quietStart && currentHour < quietEnd;
  if (quietStart > quietEnd) return currentHour >= quietStart || currentHour < quietEnd;
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

const log = createLogger("notification-queue");
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const QUEUE_FILE = join(RELAY_DIR, "notification-queue.json");
const MCP_PENDING_FILE = join(RELAY_DIR, "mcp-pending-notifications.json");

// ── Types ──────────────────────────────────────────────────────

export interface NotificationItem {
  id: string;
  type: NotificationType;
  severity: "critical" | "normal";
  message: string;
  data?: {
    taskId?: string;
    taskStatus?: string;
    prUrl?: string;
    ideaId?: string;
    alertType?: string;
  };
  createdAt: number; // epoch ms
}

// ── State ──────────────────────────────────────────────────────

let queue: NotificationItem[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let botInstance: Bot | null = null;
let groupId = "";
let sprintThreadId = 0;
let devThreadId = 0;

// ── Queue Management ───────────────────────────────────────────

export function getQueue(): NotificationItem[] {
  return queue;
}

export async function loadQueue(): Promise<void> {
  try {
    const content = await readFile(QUEUE_FILE, "utf-8");
    queue = JSON.parse(content);
  } catch {
    // R6: optional IO → degrade gracefully
    queue = [];
  }
}

async function saveQueue(): Promise<void> {
  await mkdir(RELAY_DIR, { recursive: true });
  const tmp = QUEUE_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(queue, null, 2));
  await rename(tmp, QUEUE_FILE);
}

// ── Inline Buttons ─────────────────────────────────────────────

export function getInlineKeyboard(item: NotificationItem): InlineKeyboard | undefined {
  const { type, data } = item;

  if (type === "task" && data?.taskId) {
    const kb = new InlineKeyboard();
    if (data.taskStatus === "backlog" || data.taskStatus === "todo") {
      kb.text("Demarrer", `notif_start:${data.taskId}`);
    } else if (data.taskStatus === "in_progress") {
      kb.text("Terminer", `notif_done:${data.taskId}`);
    }
    kb.text("Voir details", `notif_view:${data.taskId}`);
    return kb;
  }

  if (type === "pr" && data?.prUrl) {
    return new InlineKeyboard().url("Voir la PR", data.prUrl);
  }

  if (type === "idea" && data?.ideaId) {
    return new InlineKeyboard()
      .text("Promouvoir", `notif_promote:${data.ideaId}`)
      .text("Archiver", `notif_archive:${data.ideaId}`);
  }

  if (type === "alert") {
    const kb = new InlineKeyboard();
    if (data?.taskId) {
      kb.text("Voir tache", `notif_viewtask:${data.taskId}`);
    }
    kb.text("Voir sprint", "notif_sprint");
    kb.text("Ignorer", `notif_dismiss:${item.id}`);
    return kb;
  }

  return undefined;
}

// ── Thread Routing ─────────────────────────────────────────────

function getThreadId(type: NotificationType): number {
  return type === "pr" ? devThreadId : sprintThreadId;
}

// ── Send Helpers ───────────────────────────────────────────────

async function sendStandalone(item: NotificationItem): Promise<void> {
  if (!botInstance) return;
  const chatId = groupId || process.env.TELEGRAM_USER_ID || "";
  if (!chatId) return;

  const threadId = getThreadId(item.type);
  const keyboard = getInlineKeyboard(item);

  const opts: Record<string, unknown> = {};
  if (groupId && threadId) opts.message_thread_id = threadId;
  if (keyboard) opts.reply_markup = keyboard;

  try {
    await botInstance.api.sendMessage(chatId, item.message, opts);
  } catch (error) {
    log.error(`Notification send error:`, { error: String(error) });
  }
}

async function sendDigest(items: NotificationItem[], header?: string): Promise<void> {
  if (!botInstance || items.length === 0) return;
  const chatId = groupId || process.env.TELEGRAM_USER_ID || "";
  if (!chatId) return;

  const text = header ? `${header}\n\n${formatDigest(items)}` : formatDigest(items);

  const opts: Record<string, unknown> = {};
  if (groupId && sprintThreadId) opts.message_thread_id = sprintThreadId;

  try {
    await botInstance.api.sendMessage(chatId, text, opts);
  } catch (error) {
    log.error(`Digest send error:`, { error: String(error) });
  }
}

// ── Digest Formatting ──────────────────────────────────────────

const TYPE_PRIORITY: Record<NotificationType, number> = {
  alert: 0,
  task: 1,
  pr: 2,
  idea: 3,
};

const TYPE_LABELS: Record<NotificationType, string> = {
  alert: "ALERTES",
  task: "TACHES",
  pr: "PULL REQUESTS",
  idea: "IDEES",
};

export function formatDigest(items: NotificationItem[]): string {
  // Sort by priority then by time
  const sorted = [...items].sort((a, b) => {
    const pDiff = TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
    if (pDiff !== 0) return pDiff;
    return a.createdAt - b.createdAt;
  });

  // Group by type
  const groups = new Map<NotificationType, NotificationItem[]>();
  for (const item of sorted) {
    const list = groups.get(item.type) || [];
    list.push(item);
    groups.set(item.type, list);
  }

  const lines: string[] = [];
  let shown = 0;
  const MAX_SHOWN = 10;

  for (const type of ["alert", "task", "pr", "idea"] as NotificationType[]) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;

    lines.push(`${TYPE_LABELS[type]} (${group.length})`);
    for (const item of group) {
      if (shown >= MAX_SHOWN) break;
      lines.push(`  ${item.message}`);
      shown++;
    }
  }

  const total = items.length;
  if (total > MAX_SHOWN) {
    lines.push("");
    lines.push(`+ ${total - MAX_SHOWN} autres notifications`);
  }

  return lines.join("\n");
}

export function formatMorningDigest(items: NotificationItem[]): string {
  if (items.length === 0) return "";

  const tz = process.env.USER_TIMEZONE || "Europe/Paris";
  const oldest = new Date(Math.min(...items.map((i) => i.createdAt)));
  const now = new Date();

  const fmt = (d: Date) =>
    d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: tz });

  const header = `Resume ${fmt(oldest)} - ${fmt(now)}, ${items.length} notification${items.length > 1 ? "s" : ""}`;
  return `${header}\n\n${formatDigest(items)}`;
}

// ── Core Queue Logic ───────────────────────────────────────────

export async function enqueue(item: Omit<NotificationItem, "id" | "createdAt">): Promise<void> {
  if (!isTypeEnabled(item.type)) return;

  const fullItem: NotificationItem = {
    ...item,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };

  // Critical alerts or immediate-type bypass everything
  if (item.severity === "critical" || isImmediate(item.type)) {
    await sendStandalone(fullItem);
    return;
  }

  // During quiet hours, queue for morning digest
  if (isQuietHours()) {
    queue.push(fullItem);
    await saveQueue();
    return;
  }

  // Normal batching
  queue.push(fullItem);
  await saveQueue();

  // Flush if threshold reached
  const prefs = getPrefs();
  if (queue.length >= prefs.batchThreshold) {
    await flush();
  }
}

export async function flush(): Promise<void> {
  if (queue.length === 0) return;

  const items = [...queue];
  queue = [];
  await saveQueue();

  if (items.length === 1) {
    await sendStandalone(items[0]);
  } else {
    await sendDigest(items);
  }
}

export async function flushMorningDigest(): Promise<void> {
  if (queue.length === 0) return;

  const items = [...queue];
  queue = [];
  await saveQueue();

  const text = formatMorningDigest(items);
  if (!botInstance || !text) return;

  const chatId = groupId || process.env.TELEGRAM_USER_ID || "";
  if (!chatId) return;

  const opts: Record<string, unknown> = {};
  if (groupId && sprintThreadId) opts.message_thread_id = sprintThreadId;

  try {
    await botInstance.api.sendMessage(chatId, text, opts);
  } catch (error) {
    log.error(`Morning digest send error:`, { error: String(error) });
  }
}

// ── MCP Notification Bridge ──────────────────────────────────

export async function consumeMcpPending(): Promise<void> {
  try {
    const content = await readFile(MCP_PENDING_FILE, "utf-8");
    const pending = JSON.parse(content);
    if (!Array.isArray(pending) || pending.length === 0) return;

    for (const item of pending) {
      if (!isTypeEnabled(item.type)) continue;
      const fullItem: NotificationItem = {
        id: crypto.randomUUID(),
        type: item.type,
        severity: item.severity || "normal",
        message: item.message,
        data: item.data,
        createdAt: item.createdAt || Date.now(),
      };
      queue.push(fullItem);
    }

    // Clear the pending file
    await writeFile(MCP_PENDING_FILE, "[]");
    await saveQueue();
  } catch {
    // R6: optional IO → degrade gracefully
    // File doesn't exist or parse error — normal when no MCP pending
  }
}

// ── Lifecycle ──────────────────────────────────────────────────

export async function startQueue(bot: Bot): Promise<void> {
  botInstance = bot;
  groupId = process.env.TELEGRAM_GROUP_ID || "";
  sprintThreadId = parseInt(process.env.SPRINT_THREAD_ID || "0", 10);
  devThreadId = parseInt(process.env.DEV_THREAD_ID || "0", 10);

  await loadPrefs();
  await loadQueue();

  const prefs = getPrefs();
  timer = setInterval(async () => {
    // Consume any pending MCP notifications
    await consumeMcpPending();
    // Don't auto-flush during quiet hours (wait for morning digest)
    if (!isQuietHours() && queue.length > 0) {
      await flush();
    }
  }, prefs.batchIntervalMs);
}

export function stopQueue(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getQueueSize(): number {
  return queue.length;
}
