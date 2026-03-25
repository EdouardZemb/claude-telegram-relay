/**
 * @module job-manager
 * @description Job Manager singleton: launches long-running operations in background,
 * tracks their status, sends completion notifications. Uses Semaphore for concurrency
 * control and JSON persistence for crash recovery.
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { join } from "path";
import { isFeatureEnabled } from "./feature-flags.ts";
import { sectionTitle, separator } from "./html-format-helpers.ts";
import { escapeHtml } from "./html-utils.ts";
import { createLogger } from "./logger.ts";
import { enqueue } from "./notification-queue.ts";
import { getTracker, type SddPhase, type StepStatus, updateStep } from "./pipeline-tracker.ts";
import {
  _clearDepthForTests,
  getAutoAdvanceDepth,
  getNextSddPhase,
  resetAutoAdvanceDepth,
  tryAutoAdvance,
} from "./sdd-auto-advance.ts";
import { syncTaskStatusForPhase } from "./sdd-task-sync.ts";
import { Semaphore } from "./semaphore.ts";

// Re-export auto-advance API for consumers
export { getAutoAdvanceDepth, getNextSddPhase, resetAutoAdvanceDepth };

const log = createLogger("job-manager");
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const JOBS_FILE = join(RELAY_DIR, "jobs.json");
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const BATCH_RESULT_MAX_CHARS = 4000;
const TELEGRAM_MSG_MAX_CHARS = 3800;

/** Configurable failure threshold for batch escalation (R7). */
export const BATCH_FAILURE_THRESHOLD = 0.5;

// ── Batch Result Parsing ─────────────────────────────────────

export interface BatchResult {
  ok: number;
  total: number;
  failedIds: string[];
  details: string;
}

/**
 * Parse the structured BATCH_COMPLETE format into a typed object.
 * Format: BATCH_COMPLETE:<ok>/<total>:failed=<id1>,<id2>\n\n<details>
 * Returns null if the input does not match the expected format.
 */
export function parseBatchResult(result: string): BatchResult | null {
  if (!result?.startsWith("BATCH_COMPLETE:")) return null;
  const afterPrefix = result.replace("BATCH_COMPLETE:", "");
  const [header, ...rest] = afterPrefix.split("\n\n");
  const [counts, failedPart] = header.split(":failed=");
  const [ok, total] = counts.split("/").map(Number);
  const failedIds = failedPart?.split(",").filter(Boolean) ?? [];
  return { ok, total, failedIds, details: rest.join("\n\n") };
}

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

/**
 * Send a progress message to a chat. Catches errors silently (R5, V13).
 * Used by onProgress callbacks in planning.ts closures.
 */
export async function sendProgressMessage(
  chatId: number | string,
  messageThreadId: number | undefined,
  message: string,
): Promise<void> {
  if (!botInstance) return;
  try {
    const opts: Record<string, unknown> = {};
    if (messageThreadId) opts.message_thread_id = messageThreadId;
    await botInstance.api.sendMessage(chatId, message, opts);
  } catch (error) {
    log.error("sendProgressMessage failed", { error: String(error) });
  }
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
    // R6: optional IO → degrade gracefully
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
    log.error("Job persistence error", { error: String(error) });
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
      const maxLen = job.type === "autopipeline-batch" ? BATCH_RESULT_MAX_CHARS : 500;
      job.result =
        typeof result === "string"
          ? result.substring(0, maxLen)
          : String(result).substring(0, maxLen);
      job.completedAt = new Date().toISOString();
    } catch (error: unknown) {
      job.status = "failed";
      job.error = (error instanceof Error ? error.message : String(error)).substring(0, 500);
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
      log.error("Job notification error", { error: String(notifError) });
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
 * Find the PR URL for an implement job from the registry.
 * Used as in-memory fallback for getCompletionKeyboard (sync) in review phase.
 * After restart, registry is empty — tracker disk persistence is the canonical source.
 */
function findImplementPrUrl(pipelineName: string): string | undefined {
  for (const job of registry.values()) {
    if (job.type === `sdd-implement:${pipelineName}` && job.status === "completed" && job.result) {
      return extractPrUrl(job.result);
    }
  }
  return undefined;
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
      if (prUrl) {
        kb.url("Voir la PR", prUrl);
        hasButtons = true;
      }
      if (job.taskId) {
        kb.text("Terminer la tache", `jc_done:${job.taskId.substring(0, 8)}`);
        hasButtons = true;
      }
      break;
    case "autopipeline-batch": {
      // R11: conditional retry button + backlog button
      const batchParsed = job.result ? parseBatchResult(job.result) : null;
      if (batchParsed && batchParsed.failedIds.length > 0) {
        const failRate = 1 - batchParsed.ok / batchParsed.total;
        if (failRate > BATCH_FAILURE_THRESHOLD) {
          kb.text(
            `Relancer les ${batchParsed.failedIds.length} echecs`,
            `jc_batch_retry:${job.id}`,
          );
        }
      }
      kb.text("Voir le backlog", "jc_backlog");
      hasButtons = true;
      break;
    }
    case "prd-decompose":
    case "plan":
      kb.text("Voir le backlog", "jc_backlog");
      hasButtons = true;
      // PRD workflow: if result contains task count, add launch button
      if (job.result?.startsWith("PRDWF_DECOMPOSED:")) {
        const parts = job.result.replace("PRDWF_DECOMPOSED:", "").split("|");
        const prdId = parts[0];
        if (prdId) {
          kb.row().text("Lancer l'implementation", `prdwf_launch:${prdId.substring(0, 8)}`);
        }
      }
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
      if (job.type.startsWith("sdd-")) {
        // SDD pipeline jobs: parse phase and pipeline name from type (F-SS-1)
        // Format: sdd-{phase}:{pipeline-name}
        // Result format: SDD_{PHASE}_{VERDICT}: ...
        const typeColonIdx = job.type.indexOf(":");
        const sddPhaseFromType =
          typeColonIdx !== -1
            ? job.type.substring(4, typeColonIdx) // strip "sdd-", take until ":"
            : job.type.substring(4); // strip "sdd-" only (legacy format)
        const sddName =
          typeColonIdx !== -1 ? job.type.substring(typeColonIdx + 1) : sddPhaseFromType;

        // Parse verdict from result: SDD_{PHASE}_{VERDICT}: ...
        // Use sddPhaseFromType (from job.type) for phase, parse only verdict from result
        const sddVerdictMatch = job.result?.match(
          /^SDD_\w+_(GO_WITH_CHANGES|NO-GO|GO|OK|FAILED|PIVOT|DROP|APPROVED|CHANGES_REQUESTED):/,
        );
        if (sddVerdictMatch) {
          const sddPhase = sddPhaseFromType.toLowerCase();
          const sddVerdict = sddVerdictMatch[1];
          // Build contextual buttons based on phase and verdict
          if (sddPhase === "explore") {
            if (sddVerdict === "GO") {
              kb.text("Discuter les resultats", `sdd_discuss:${sddName}`);
              kb.text("Specifier", `sdd_spec:${sddName}`);
            } else if (sddVerdict === "PIVOT") {
              kb.text("Re-explorer", `sdd_explore:${sddName}`);
              kb.text("Discuter", `sdd_discuss:${sddName}`);
            }
            // DROP: no buttons
          } else if (sddPhase === "spec") {
            kb.text("Challenger", `sdd_challenge:${sddName}`);
            kb.text("Implementer", `sdd_implement:${sddName}`);
          } else if (sddPhase === "challenge") {
            if (sddVerdict === "GO" || sddVerdict === "OK") {
              kb.text("Implementer", `sdd_implement:${sddName}`);
            } else if (sddVerdict === "GO_WITH_CHANGES") {
              kb.text("Implementer avec corrections", `sdd_implement:${sddName}`);
              kb.text("Corriger la spec", `sdd_spec:${sddName}`);
            } else if (sddVerdict === "NO-GO") {
              kb.text("Retravailler la spec", `sdd_spec:${sddName}`);
            }
          } else if (sddPhase === "implement") {
            kb.text("Review", `sdd_review:${sddName}`);
            kb.text("Corriger", `sdd_implement:${sddName}`);
          } else if (sddPhase === "review") {
            if (sddVerdict === "APPROVED") {
              const implementPrUrl = findImplementPrUrl(sddName);
              if (implementPrUrl) kb.url("Voir la PR", implementPrUrl);
              // If auto-merge was activated ([AUTO-MERGE] tag in result), skip manual merge button
              const isAutoMerge = job.result?.includes("[AUTO-MERGE]") ?? false;
              if (!isAutoMerge) {
                kb.row().text("Fusionner la PR", `sdd_merge_ask:${sddName}`);
              }
              hasButtons = true;
            } else if (sddVerdict === "CHANGES_REQUESTED") {
              const implementPrUrl = findImplementPrUrl(sddName);
              if (implementPrUrl) {
                kb.url("Voir la PR", implementPrUrl);
                hasButtons = true;
              }
            }
            // OK (legacy) and other verdicts: no buttons
          } else if (sddPhase === "doc") {
            // Terminal phase: no continuation buttons (R11)
          }
          if (!hasButtons) hasButtons = kb.inline_keyboard?.length > 0;
        }
      } else {
        return undefined;
      }
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
    } else if (job.type === "prd-decompose" && job.result?.startsWith("PRDWF_DECOMPOSED:")) {
      const parts = job.result.replace("PRDWF_DECOMPOSED:", "").split("|");
      const taskCount = parts[1] || "?";
      const details = parts.slice(2).join("|");
      message = `Décomposition terminée (${elapsed})\n${taskCount} tâches créées\n\n${details}`;
    } else if (job.type === "autopipeline-batch" && job.result?.startsWith("BATCH_COMPLETE:")) {
      const batch = parseBatchResult(job.result);
      if (batch) {
        const failRate = 1 - batch.ok / batch.total;
        const prefix = failRate > BATCH_FAILURE_THRESHOLD ? "ALERTE — " : "";
        let body = `${prefix}Implementation batch terminee (${elapsed})\nResultat : ${batch.ok}/${batch.total} taches reussies`;

        // R1: Add per-task detail lines from details section
        if (batch.details) {
          const taskBlocks = batch.details.split("\n\n---\n\n");
          const lines: string[] = [];
          for (let i = 0; i < taskBlocks.length; i++) {
            const block = taskBlocks[i].trim();
            if (!block) continue;
            // Extract first line as summary (e.g. "PIPELINE OK — Task title")
            const firstLine = block.split("\n")[0];
            const lineNum = i + 1;
            const statusMatch = firstLine.match(/^PIPELINE\s+(OK|ECHEC)\s+—\s+(.*)$/);
            if (statusMatch) {
              const [, status, title] = statusMatch;
              // Extract phase/duration from second line if available
              const secondLine = block.split("\n")[1] || "";
              const durationMatch = secondLine.match(/Duree:\s*(\d+)s/);
              const duration = durationMatch ? `, ${durationMatch[1]}s` : "";
              // Extract PR URL if present
              const prMatch = block.match(/PR:\s*(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/);
              const pr = prMatch ? `, PR ${prMatch[1].match(/pull\/(\d+)/)?.[0] || ""}` : "";
              lines.push(`${lineNum}. ${status} — ${title}${duration}${pr}`);
            } else {
              lines.push(`${lineNum}. ${firstLine}`);
            }

            // R3: Check if we're exceeding the Telegram limit
            const tentativeBody = body + "\n\n" + lines.join("\n");
            if (tentativeBody.length > TELEGRAM_MSG_MAX_CHARS) {
              const remaining = taskBlocks.length - i;
              lines.pop(); // Remove the line that would exceed the limit
              if (remaining > 0) {
                lines.push(`... +${remaining} autres. /jobs ${job.id} pour les details`);
              }
              break;
            }
          }
          // R3: If some task blocks were lost due to result truncation, add a note
          const totalExpected = batch.total;
          const linesWithNumbers = lines.filter((l) => /^\d+\./.test(l));
          if (linesWithNumbers.length < totalExpected && !lines.some((l) => l.startsWith("..."))) {
            const missing = totalExpected - linesWithNumbers.length;
            lines.push(`... +${missing} autres. /jobs ${job.id} pour les details`);
          }
          if (lines.length > 0) {
            body += "\n\n" + lines.join("\n");
          }
        }
        // Final safety: hard truncate if still over limit
        if (body.length > TELEGRAM_MSG_MAX_CHARS) {
          body =
            body.substring(0, TELEGRAM_MSG_MAX_CHARS - 60) +
            `\n... /jobs ${job.id} pour les details`;
        }
        message = body;
      } else {
        // Fallback for malformed BATCH_COMPLETE
        const summary = job.result.replace("BATCH_COMPLETE:", "").split("\n")[0].split(":")[0];
        message = `Implementation batch terminee (${elapsed})\nResultat : ${summary} taches reussies`;
      }
    } else if (job.type.startsWith("sdd-review:") && job.result?.includes("[AUTO-MERGE]")) {
      message = `Review approuvee (${elapsed})\nauto-merge active — le merge sera effectue automatiquement quand la CI passera.`;
    } else {
      message = `Job ${job.type} terminé (${elapsed})\n${job.result || ""}`;
    }
  } else {
    message = `Job ${job.type} échoué (${elapsed})\n${job.error || "Erreur inconnue"}`;
  }

  // R3: Persist prUrl for sdd-implement jobs so merge button works after restart
  if (job.status === "completed" && job.type.startsWith("sdd-implement:") && job.result) {
    const prUrl = extractPrUrl(job.result);
    if (prUrl) {
      const chatIdNum =
        typeof job.chatId === "number" ? job.chatId : parseInt(String(job.chatId), 10);
      if (!Number.isNaN(chatIdNum)) {
        try {
          await updateStep(chatIdNum, job.messageThreadId, "implement", { prUrl });
        } catch (err) {
          log.error("Failed to persist prUrl to tracker", { error: String(err) });
        }
      }
    }
  }

  // SDD-backlog sync: update pipeline step status and sync linked task
  if (job.type.startsWith("sdd-")) {
    const typeColonIdx = job.type.indexOf(":");
    if (typeColonIdx !== -1) {
      const sddPhase = job.type.substring(4, typeColonIdx); // strip "sdd-"
      const chatIdNum =
        typeof job.chatId === "number" ? job.chatId : parseInt(String(job.chatId), 10);

      if (!Number.isNaN(chatIdNum)) {
        const validPhases: SddPhase[] = [
          "explore",
          "discuss",
          "spec",
          "challenge",
          "implement",
          "review",
          "doc",
        ];
        const typedPhase = sddPhase as SddPhase;
        const typedStepStatus: StepStatus = job.status === "completed" ? "ok" : "failed";
        if (validPhases.includes(typedPhase)) {
          try {
            await updateStep(chatIdNum, job.messageThreadId, typedPhase, {
              status: typedStepStatus,
              summary: job.result?.substring(0, 200) ?? job.error?.substring(0, 200),
            });
          } catch (err) {
            log.warn("SDD step update failed", { error: String(err), sddPhase });
          }

          // Sync linked task status (best-effort, lazy supabase import)
          try {
            const tracker = await getTracker(chatIdNum, job.messageThreadId);
            if (tracker?.taskId) {
              const { getConfig } = await import("./config.ts");
              const { createClient } = await import("@supabase/supabase-js");
              const config = getConfig();
              const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
              await syncTaskStatusForPhase(supabase, tracker.taskId, typedPhase, typedStepStatus);
            }
          } catch (syncErr) {
            log.warn("SDD task sync failed (best-effort)", { error: String(syncErr), sddPhase });
          }
        }
      }
    }
  }

  // Try direct notification to originating chat
  if (botInstance && job.chatId) {
    try {
      const opts: Record<string, unknown> = {};
      if (job.messageThreadId) opts.message_thread_id = job.messageThreadId;
      const keyboard = getCompletionKeyboard(job);
      if (keyboard) opts.reply_markup = keyboard;

      await botInstance.api.sendMessage(job.chatId, message, opts);
    } catch (error) {
      log.error("Direct job notification failed, falling back to queue", { error: String(error) });
      // Fallback to notification queue
      await enqueueFallback(job);
    }
  } else {
    // Fallback to notification queue
    await enqueueFallback(job);
  }

  // SDD Auto-advance: attempt event-driven transition to next phase
  await tryAutoAdvance(job, botInstance, launch);

  // Emit SDD verdict + trigger feedback loop post-job (R1, R9) — fire-and-forget (F-SS-2)
  if (job.type.startsWith("sdd-") && job.status === "completed" && job.type.includes(":")) {
    Promise.resolve()
      .then(async () => {
        const { emitSddVerdict } = await import("./sdd-event.ts");
        await emitSddVerdict(job.id, job.type, job.result);
        const { runFeedbackLoop } = await import("./feedback-analyzer.ts");
        await runFeedbackLoop();
      })
      .catch((e) => log.warn("post-job SDD hook failed", { error: String(e) }));
  }
}

/**
 * Enqueue fallback notification (used when bot instance is unavailable).
 */
async function enqueueFallback(job: Job): Promise<void> {
  let severity: "normal" | "critical" = "normal";
  if (job.type === "autopipeline-batch" && job.result) {
    const batch = parseBatchResult(job.result);
    if (batch && batch.total > 0 && 1 - batch.ok / batch.total > BATCH_FAILURE_THRESHOLD) {
      severity = "critical";
    }
  }
  await enqueue({
    type: job.status === "completed" ? "task" : "alert",
    severity,
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
  lines.push(sectionTitle(`Jobs en cours (${running.length}/${capacity.max})`));
  lines.push("");

  if (running.length === 0) {
    lines.push("  <i>(aucun)</i>");
  } else {
    for (const job of running) {
      const elapsed = formatDuration(Date.now() - new Date(job.startedAt).getTime());
      const taskLabel = job.taskId ? job.taskId.substring(0, 8) : job.type;
      lines.push(
        `  \u25B6\uFE0F <code>${escapeHtml(job.id)}</code> ${escapeHtml(job.type)} | ${escapeHtml(taskLabel)} | ${elapsed}`,
      );
    }
  }

  if (capacity.waiting > 0) {
    lines.push(`  <i>(${capacity.waiting} en attente)</i>`);
  }

  if (recent.length > 0) {
    lines.push("");
    lines.push(separator());
    lines.push("<b>Derniers termines</b>");
    for (const job of recent) {
      const taskLabel = job.taskId ? job.taskId.substring(0, 8) : job.type;
      const icon = job.status === "completed" ? "\u2705" : "\u274C";
      const elapsed = job.completedAt
        ? formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())
        : "?";
      lines.push(
        `  ${icon} <code>${escapeHtml(job.id)}</code> ${escapeHtml(job.type)} | ${escapeHtml(taskLabel)} | ${elapsed}`,
      );
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
  _clearDepthForTests();
}
