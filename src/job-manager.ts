/**
 * @module job-manager
 * @description Job Manager singleton: launches long-running operations in background,
 * tracks their status, sends completion notifications. Uses Semaphore for concurrency
 * control and JSON persistence for crash recovery.
 */

import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { join } from "path";
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import { Semaphore } from "./semaphore.ts";
import { enqueue } from "./notification-queue.ts";
import { isFeatureEnabled } from "./feature-flags.ts";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const JOBS_FILE = join(RELAY_DIR, "jobs.json");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Types ──────────────────────────────────────────────────────

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  chatId: number | string;
  messageThreadId?: number;
  taskId?: string;
  startedAt: string;
  completedAt: string | null;
  result: string | null;
  error: string | null;
}

export interface LaunchOptions {
  taskId?: string;
  timeoutMs?: number;
  messageThreadId?: number;
}

// ── State ──────────────────────────────────────────────────────

const registry = new Map<string, Job>();
const semaphore = new Semaphore(3);
let loaded = false;
let botInstance: Bot | null = null;

// ── Bot Injection ─────────────────────────────────────────────

/**
 * Initialize the job manager with a bot instance for direct notifications.
 * Call this once at startup after creating the bot.
 */
export function initJobManager(bot: Bot): void {
  botInstance = bot;
}

// ── Persistence ────────────────────────────────────────────────

async function loadJobs(): Promise<void> {
  if (loaded) return;
  try {
    const content = await readFile(JOBS_FILE, "utf-8");
    const jobs: Job[] = JSON.parse(content);
    for (const job of jobs) {
      // Mark any running jobs as failed (restart recovery)
      if (job.status === "running" || job.status === "pending") {
        job.status = "failed";
        job.error = "restart";
        job.completedAt = new Date().toISOString();
      }
      registry.set(job.id, job);
    }
  } catch {
    // File doesn't exist or parse error — start fresh
  }
  loaded = true;
}

async function saveJobs(): Promise<void> {
  try {
    await mkdir(RELAY_DIR, { recursive: true });
    const jobs = Array.from(registry.values());
    const tmp = JOBS_FILE + `.tmp.${crypto.randomUUID().substring(0, 8)}`;
    await writeFile(tmp, JSON.stringify(jobs, null, 2));
    await rename(tmp, JOBS_FILE);
  } catch (error) {
    console.error("Job persistence error:", error);
  }
}

// ── Core API ───────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID().substring(0, 8);
}

/**
 * Launch a background job. Returns the job ID immediately.
 * The function runs asynchronously; a notification is sent on completion.
 */
export async function launch(
  type: string,
  chatId: number | string,
  fn: () => Promise<string>,
  options?: LaunchOptions,
): Promise<string> {
  await loadJobs();

  const id = generateId();
  const job: Job = {
    id,
    type,
    status: "pending",
    chatId,
    messageThreadId: options?.messageThreadId,
    taskId: options?.taskId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
    error: null,
  };

  registry.set(id, job);
  await saveJobs();

  // Fire-and-forget: acquire semaphore, run, notify
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  (async () => {
    await semaphore.acquire();
    job.status = "running";
    await saveJobs();

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`Job timeout after ${Math.round(timeoutMs / 60000)}min`)),
            timeoutMs,
          );
        }),
      ]);

      job.status = "completed";
      job.result = typeof result === "string" ? result.substring(0, 500) : String(result).substring(0, 500);
      job.completedAt = new Date().toISOString();
    } catch (error: any) {
      job.status = "failed";
      job.error = (error?.message || String(error)).substring(0, 500);
      job.completedAt = new Date().toISOString();
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      semaphore.release();
      await saveJobs();
    }

    // Send completion notification directly to originating chat
    try {
      await sendJobCompletionNotification(job);
    } catch (notifError) {
      console.error("Job notification error:", notifError);
    }
  })();

  return id;
}

// ── Completion Notifications ──────────────────────────────────

/**
 * Extract a GitHub PR URL from a result string.
 */
function extractPrUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
  return match?.[0];
}

/**
 * Build contextual inline keyboard for a completed job.
 */
export function getCompletionKeyboard(job: Job): InlineKeyboard | undefined {
  if (job.status === "failed") return undefined;

  const kb = new InlineKeyboard();
  const prUrl = job.result ? extractPrUrl(job.result) : undefined;
  let hasButtons = false;

  switch (job.type) {
    case "exec":
    case "orchestrate":
    case "autopipeline":
      if (prUrl) { kb.url("Voir la PR", prUrl); hasButtons = true; }
      if (job.taskId) { kb.text("Terminer la tache", `jc_done:${job.taskId.substring(0, 8)}`); hasButtons = true; }
      break;
    case "prd-decompose":
    case "plan":
      kb.text("Voir le backlog", "jc_backlog");
      hasButtons = true;
      break;
    case "prd":
      // result format: PRD_CREATED:<id>|<title>
      if (job.result?.startsWith("PRD_CREATED:")) {
        const prdId = job.result.replace("PRD_CREATED:", "").split("|")[0].trim();
        kb.text("Visualiser le PRD", `jc_prd:${prdId.substring(0, 8)}`);
        kb.text("Approuver", `prd_approve:${prdId}`);
        hasButtons = true;
      }
      break;
    case "explore":
      kb.text("Creer une tache", "jc_task_from_explore");
      hasButtons = true;
      break;
    default:
      return undefined;
  }

  return hasButtons ? kb : undefined;
}

/**
 * Send job completion notification directly to the originating chat.
 * Falls back to notification queue if bot is not available.
 */
async function sendJobCompletionNotification(job: Job): Promise<void> {
  const elapsed = job.completedAt
    ? formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())
    : "?";

  let message: string;
  if (job.status === "completed") {
    if (job.type === "prd" && job.result?.startsWith("PRD_CREATED:")) {
      const parts = job.result.replace("PRD_CREATED:", "").split("|");
      const prdTitle = parts[1] || "";
      message = `PRD créé avec succès (${elapsed})${prdTitle ? `\n${prdTitle}` : ""}`;
    } else {
      message = `Job ${job.type} terminé (${elapsed})\n${job.result || ""}`;
    }
  } else {
    message = `Job ${job.type} échoué (${elapsed})\n${job.error || "Erreur inconnue"}`;
  }

  // Try direct notification to originating chat
  if (botInstance && job.chatId) {
    try {
      const opts: Record<string, unknown> = {};
      if (job.messageThreadId) opts.message_thread_id = job.messageThreadId;
      const keyboard = getCompletionKeyboard(job);
      if (keyboard) opts.reply_markup = keyboard;

      await botInstance.api.sendMessage(job.chatId, message, opts);
      return;
    } catch (error) {
      console.error("Direct job notification failed, falling back to queue:", error);
    }
  }

  // Fallback to notification queue
  await enqueue({
    type: job.status === "completed" ? "task" : "alert",
    severity: "normal",
    message: `Job ${job.type} termine (${job.id})\n${job.status === "completed" ? job.result || "" : job.error || "Erreur inconnue"}`,
    data: job.taskId ? { taskId: job.taskId } : undefined,
  });
}

/**
 * List running jobs + last N completed/failed jobs.
 */
export async function list(recentCount = 5): Promise<{ running: Job[]; recent: Job[] }> {
  await loadJobs();

  const running: Job[] = [];
  const finished: Job[] = [];

  for (const job of registry.values()) {
    if (job.status === "running" || job.status === "pending") {
      running.push(job);
    } else {
      finished.push(job);
    }
  }

  // Sort finished by completedAt descending
  finished.sort((a, b) => {
    const ta = a.completedAt ? new Date(a.completedAt).getTime() : 0;
    const tb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
    return tb - ta;
  });

  return {
    running,
    recent: finished.slice(0, recentCount),
  };
}

/**
 * Get a single job by ID.
 */
export async function get(id: string): Promise<Job | undefined> {
  await loadJobs();
  return registry.get(id);
}

/**
 * Cancel a running job. Marks it as failed with "cancelled" error.
 * Note: the underlying process continues to run but its result is discarded.
 */
export async function cancel(id: string): Promise<Job | undefined> {
  await loadJobs();
  const job = registry.get(id);
  if (!job) return undefined;

  if (job.status === "running" || job.status === "pending") {
    job.status = "failed";
    job.error = "cancelled";
    job.completedAt = new Date().toISOString();
    await saveJobs();
  }

  return job;
}

/**
 * Remove jobs completed/failed more than 24h ago.
 */
export async function cleanup(): Promise<number> {
  await loadJobs();
  const cutoff = Date.now() - CLEANUP_AGE_MS;
  let removed = 0;

  for (const [id, job] of registry.entries()) {
    if (
      (job.status === "completed" || job.status === "failed") &&
      job.completedAt &&
      new Date(job.completedAt).getTime() < cutoff
    ) {
      registry.delete(id);
      removed++;
    }
  }

  if (removed > 0) await saveJobs();
  return removed;
}

/**
 * Get current semaphore stats.
 */
export function getCapacity(): { current: number; max: number; waiting: number } {
  return {
    current: semaphore.current,
    max: semaphore.max,
    waiting: semaphore.waiting,
  };
}

/**
 * Format the job list for Telegram display.
 */
export function formatJobList(running: Job[], recent: Job[]): string {
  const lines: string[] = [];

  const capacity = getCapacity();
  lines.push(`Jobs en cours (${running.length}/${capacity.max}):`);

  if (running.length === 0) {
    lines.push("  (aucun)");
  } else {
    for (const job of running) {
      const elapsed = formatDuration(Date.now() - new Date(job.startedAt).getTime());
      const taskLabel = job.taskId ? job.taskId.substring(0, 8) : job.type;
      lines.push(`  ${job.id} | ${job.type} | ${taskLabel} | ${elapsed}`);
    }
  }

  if (capacity.waiting > 0) {
    lines.push(`  (${capacity.waiting} en attente)`);
  }

  if (recent.length > 0) {
    lines.push("");
    lines.push("Derniers termines:");
    for (const job of recent) {
      const taskLabel = job.taskId ? job.taskId.substring(0, 8) : job.type;
      const status = job.status === "completed" ? "OK" : "FAIL";
      const elapsed = job.completedAt
        ? formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())
        : "?";
      lines.push(`  ${job.id} | ${job.type} | ${taskLabel} | ${status} | ${elapsed}`);
    }
  }

  return lines.join("\n");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Check if the job_manager feature flag is enabled.
 */
export function isJobManagerEnabled(): boolean {
  return isFeatureEnabled("job_manager");
}

/**
 * Reset the registry (for testing only).
 */
export function _resetForTests(): void {
  registry.clear();
  loaded = false;
  botInstance = null;
}
