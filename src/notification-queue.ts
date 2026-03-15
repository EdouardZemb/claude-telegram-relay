/**
 * Notification Queue — S26 Smart Notifications
 *
 * Batches notifications, respects quiet hours, sends inline buttons
 * on standalone notifications, and produces morning digests.
 * Persistence via JSON file for crash recovery.
 */

import { readFile, writeFile, rename } from "fs/promises";
import { join, dirname } from "path";
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import {
  loadPrefs,
  getPrefs,
  isTypeEnabled,
  isImmediate,
  isQuietHours,
  type NotificationType,
} from "./notification-prefs.ts";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const QUEUE_FILE = join(RELAY_DIR, "notification-queue.json");

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
    queue = [];
  }
}

async function saveQueue(): Promise<void> {
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
    console.error(`Notification send error:`, error);
  }
}

async function sendDigest(items: NotificationItem[], header?: string): Promise<void> {
  if (!botInstance || items.length === 0) return;
  const chatId = groupId || process.env.TELEGRAM_USER_ID || "";
  if (!chatId) return;

  const text = header
    ? `${header}\n\n${formatDigest(items)}`
    : formatDigest(items);

  const opts: Record<string, unknown> = {};
  if (groupId && sprintThreadId) opts.message_thread_id = sprintThreadId;

  try {
    await botInstance.api.sendMessage(chatId, text, opts);
  } catch (error) {
    console.error(`Digest send error:`, error);
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
    console.error(`Morning digest send error:`, error);
  }
}

// ── Lifecycle ──────────────────────────────────────────────────

export async function startQueue(bot: Bot): Promise<void> {
  botInstance = bot;
  groupId = process.env.TELEGRAM_GROUP_ID || "";
  sprintThreadId = parseInt(process.env.SPRINT_THREAD_ID || "0");
  devThreadId = parseInt(process.env.DEV_THREAD_ID || "0");

  await loadPrefs();
  await loadQueue();

  const prefs = getPrefs();
  timer = setInterval(async () => {
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
