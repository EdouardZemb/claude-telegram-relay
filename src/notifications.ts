/**
 * Proactive Notifications — S26 Smart Notifications
 *
 * All notifications are routed through the notification queue for
 * batching, quiet hours, and inline buttons. Direct sends kept
 * as fallback (sendToTopic) for queue-bypassed messages.
 */

import type { Bot } from "grammy";
import { enqueue } from "./notification-queue.ts";

const GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";
const DEV_THREAD_ID = parseInt(process.env.DEV_THREAD_ID || "0");
const SPRINT_THREAD_ID = parseInt(process.env.SPRINT_THREAD_ID || "0");

let botInstance: Bot | null = null;

function timestamp(): string {
  return new Date().toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: process.env.USER_TIMEZONE || "Europe/Paris",
  });
}

export function initNotifications(bot: Bot): void {
  botInstance = bot;
}

export async function sendToTopic(threadId: number, message: string): Promise<void> {
  if (!botInstance || !GROUP_ID || !threadId) return;
  try {
    await botInstance.api.sendMessage(parseInt(GROUP_ID), message, {
      message_thread_id: threadId,
    });
  } catch (error) {
    console.error(`Notification error (thread ${threadId}):`, error);
  }
}

// ── PR Notifications → queue ─────────────────────────────────

export async function notifyPRCreated(
  taskTitle: string,
  prUrl: string,
  branchName: string
): Promise<void> {
  const message = [
    `[${timestamp()}] PR creee`,
    `${taskTitle}`,
    `Branche: ${branchName}`,
    `${prUrl}`,
  ].join("\n");
  await enqueue({
    type: "pr",
    severity: "normal",
    message,
    data: { prUrl },
  });
}

// ── Task Notifications → queue ───────────────────────────────

export async function notifyTaskStarted(
  taskTitle: string,
  taskId: string
): Promise<void> {
  const message = `[${timestamp()}] Tache demarree: ${taskTitle} [${taskId.substring(0, 8)}]`;
  await enqueue({
    type: "task",
    severity: "normal",
    message,
    data: { taskId, taskStatus: "in_progress" },
  });
}

export async function notifyTaskDone(
  taskTitle: string,
  taskId: string
): Promise<void> {
  const message = `[${timestamp()}] Tache terminee: ${taskTitle} [${taskId.substring(0, 8)}]`;
  await enqueue({
    type: "task",
    severity: "normal",
    message,
    data: { taskId, taskStatus: "done" },
  });
}

// ── Idea Notifications → queue ───────────────────────────────

export async function notifyIdeaCreated(
  ideaContent: string,
  source: string
): Promise<void> {
  const preview = ideaContent.length > 80 ? ideaContent.slice(0, 80) + "..." : ideaContent;
  const message = `[${timestamp()}] Nouvelle idee (${source}): ${preview}`;
  await enqueue({
    type: "idea",
    severity: "normal",
    message,
  });
}

export async function notifyIdeaPromoted(
  ideaContent: string,
  taskTitle: string
): Promise<void> {
  const preview = ideaContent.length > 80 ? ideaContent.slice(0, 80) + "..." : ideaContent;
  const message = `[${timestamp()}] Idee promue en tache: ${preview}\nTache: ${taskTitle}`;
  await enqueue({
    type: "idea",
    severity: "normal",
    message,
  });
}
