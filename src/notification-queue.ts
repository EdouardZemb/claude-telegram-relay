/**
 * @module notification-queue
 * @description Notification system: immediate send, inline buttons, MCP bridge, preferences.
 * Batching, quiet hours, and morning digest have been removed (superseded by always-immediate delivery).
 */

import { readFile, writeFile } from "fs/promises";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { dirname, join } from "path";
import { sectionTitle, statusIcon } from "./html-format-helpers.ts";
import { escapeHtml } from "./html-utils.ts";
import { createLogger } from "./logger.ts";

// ── Notification Preferences ────────────────────────────────────

const PREFS_PROJECT_ROOT = dirname(dirname(import.meta.path));
const PREFS_FILE = join(PREFS_PROJECT_ROOT, "config", "notification-prefs.json");

export type NotificationType = "task" | "pr" | "idea" | "alert";

export interface TypePrefs {
  enabled: boolean;
  immediate: boolean;
}

export interface NotificationPrefs {
  types: Record<NotificationType, TypePrefs>;
}

const DEFAULT_PREFS: NotificationPrefs = {
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

export function formatPrefs(prefs: NotificationPrefs): string {
  const lines = [sectionTitle("Preferences notifications"), "", "<b>Types</b>"];
  for (const [type, tp] of Object.entries(prefs.types)) {
    const icon = tp.enabled ? (tp.immediate ? "\u26A1" : statusIcon("ok")) : statusIcon("critical");
    const label = tp.enabled ? (tp.immediate ? "immediat" : "normal") : "desactive";
    lines.push(`${icon} <code>${escapeHtml(type)}</code> : ${label}`);
  }
  return lines.join("\n");
}

export function getDefaultPrefs(): NotificationPrefs {
  return {
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
const MCP_PENDING_FILE = join(RELAY_DIR, "mcp-pending-notifications.json");
const MCP_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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

let timer: ReturnType<typeof setInterval> | null = null;
let botInstance: Bot | null = null;
let groupId = "";
let sprintThreadId = 0;
let devThreadId = 0;

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

// ── Send Helper ────────────────────────────────────────────────

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

// ── Core Enqueue Logic ──────────────────────────────────────────

export async function enqueue(item: Omit<NotificationItem, "id" | "createdAt">): Promise<void> {
  if (!isTypeEnabled(item.type)) return;

  const fullItem: NotificationItem = {
    ...item,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };

  await sendStandalone(fullItem);
}

// ── MCP Notification Bridge ────────────────────────────────────

export async function consumeMcpPending(): Promise<void> {
  try {
    const content = await readFile(MCP_PENDING_FILE, "utf-8");
    const pending = JSON.parse(content);
    if (!Array.isArray(pending) || pending.length === 0) return;

    for (const item of pending) {
      await enqueue({
        type: item.type,
        severity: item.severity || "normal",
        message: item.message,
        data: item.data,
      });
    }

    // Clear the pending file
    await writeFile(MCP_PENDING_FILE, "[]");
  } catch {
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

  timer = setInterval(async () => {
    await consumeMcpPending();
  }, MCP_POLL_INTERVAL_MS);
}

export function stopQueue(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getQueueSize(): number {
  return 0;
}
