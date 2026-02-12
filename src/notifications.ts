/**
 * Proactive Notifications
 *
 * Sends automatic notifications to specific Telegram forum topics:
 * - PR created/merged → claude-relay topic
 * - Task status changes → sprint topic
 * - Deploy events → serveur topic
 */

import type { Bot } from "grammy";

const GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";
const DEV_THREAD_ID = parseInt(process.env.DEV_THREAD_ID || "0");
const SPRINT_THREAD_ID = parseInt(process.env.SPRINT_THREAD_ID || "0");
const SERVER_THREAD_ID = parseInt(process.env.SERVER_THREAD_ID || "0");

let botInstance: Bot | null = null;

export function initNotifications(bot: Bot): void {
  botInstance = bot;
}

async function sendToTopic(threadId: number, message: string): Promise<void> {
  if (!botInstance || !GROUP_ID || !threadId) return;
  try {
    await botInstance.api.sendMessage(parseInt(GROUP_ID), message, {
      message_thread_id: threadId,
    });
  } catch (error) {
    console.error(`Notification error (thread ${threadId}):`, error);
  }
}

// ── PR Notifications → claude-relay topic ────────────────────

export async function notifyPRCreated(
  taskTitle: string,
  prUrl: string,
  branchName: string
): Promise<void> {
  const message = [
    `PR creee: ${taskTitle}`,
    `Branche: ${branchName}`,
    `Lien: ${prUrl}`,
  ].join("\n");
  await sendToTopic(DEV_THREAD_ID, message);
}

export async function notifyPRMerged(
  taskTitle: string,
  prUrl: string
): Promise<void> {
  const message = `PR mergee: ${taskTitle}\n${prUrl}`;
  await sendToTopic(DEV_THREAD_ID, message);
}

// ── Task Notifications → sprint topic ────────────────────────

export async function notifyTaskStarted(
  taskTitle: string,
  taskId: string
): Promise<void> {
  const message = `Tache demarree: ${taskTitle} [${taskId.substring(0, 8)}]`;
  await sendToTopic(SPRINT_THREAD_ID, message);
}

export async function notifyTaskDone(
  taskTitle: string,
  taskId: string
): Promise<void> {
  const message = `Tache terminee: ${taskTitle} [${taskId.substring(0, 8)}]`;
  await sendToTopic(SPRINT_THREAD_ID, message);
}

// ── Deploy Notifications → serveur topic ─────────────────────

export async function notifyDeploy(
  branch: string,
  status: "success" | "failure",
  details?: string
): Promise<void> {
  const icon = status === "success" ? "OK" : "ECHEC";
  const parts = [`Deploy ${icon}: ${branch}`];
  if (details) parts.push(details);
  await sendToTopic(SERVER_THREAD_ID, parts.join("\n"));
}
