/**
 * @module prd-workflow
 * @description Conversational PRD-to-Deploy workflow orchestrator.
 * State machine that chains: triage -> generation -> revision -> decomposition -> implementation -> notification.
 * Behind feature flag "prd_to_deploy".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BotContext } from "./bot-context.ts";
import {
  generatePRD,
  savePRD,
  getPRD,
  updatePRDContent,
  updatePRDStatus,
  formatPRDDetail,
  type PRD,
  type PRDSessionConstraints,
} from "./prd.ts";
import { shardDocument } from "./document-sharding.ts";
import { resolveProjectContext } from "./projects.ts";
import { decomposeTask } from "./agent.ts";
import { addTask } from "./tasks.ts";
import { buildStoryFile, enrichTaskWithStory } from "./story-files.ts";
import { launch as launchJob, isJobManagerEnabled } from "./job-manager.ts";
import { enqueue } from "./notification-queue.ts";
import { explainPipelineChoice, type PipelineType } from "./pipeline-selection.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import {
  getSession,
  addDecision,
  type ConversationSession,
  type DetectedConstraint,
} from "./conversation-session.ts";

const MAX_REVISIONS = 3;

// ── Types ────────────────────────────────────────────────────

export interface TriageResult {
  score: number;
  pipeline: string;
  pipelineExplanation: string;
  label: string;
}

// ── Feature Flag Check ───────────────────────────────────────

export function isPrdWorkflowEnabled(): boolean {
  return isFeatureEnabled("prd_to_deploy");
}

// ── F1: Triage ───────────────────────────────────────────────

/**
 * Compute difficulty triage for a description.
 * Returns score, pipeline, and human-readable explanation.
 */
export async function triageDescription(
  description: string,
  supabase?: SupabaseClient | null,
): Promise<TriageResult> {
  let score = 0.5;
  let pipeline: PipelineType = "DEFAULT";

  try {
    const { computeDifficultyScore } = await import("./llm-router.ts");
    // Create a pseudo-task for the scorer
    const pseudoTask = {
      id: "triage",
      title: description.substring(0, 200),
      description,
      status: "backlog" as const,
      priority: 3,
      project: "telegram-relay",
      created_at: new Date().toISOString(),
    };
    const difficulty = await computeDifficultyScore(pseudoTask, supabase);
    score = difficulty.score;
    pipeline = difficulty.pipeline;
  } catch {
    // Fallback: estimate from text length
    const len = description.length;
    if (len < 50) { score = 0.2; pipeline = "SOLO"; }
    else if (len < 150) { score = 0.45; pipeline = "LIGHT"; }
    else { score = 0.7; pipeline = "DEFAULT"; }
  }

  const label = score < 0.3 ? "faible" : score <= 0.6 ? "moyenne" : "haute";

  // Get pipeline explanation
  const { selectPipeline, SOLO_PIPELINE, LIGHT_PIPELINE, DEFAULT_PIPELINE, QUICK_PIPELINE, RESEARCH_PIPELINE, REVIEW_PIPELINE } = await import("./pipeline-selection.ts");
  const pipelineMap: Record<string, any[]> = {
    SOLO: SOLO_PIPELINE,
    LIGHT: LIGHT_PIPELINE,
    DEFAULT: DEFAULT_PIPELINE,
    QUICK: QUICK_PIPELINE,
    RESEARCH: RESEARCH_PIPELINE,
    REVIEW: REVIEW_PIPELINE,
  };
  const roles = pipelineMap[pipeline] || DEFAULT_PIPELINE;
  const pipelineExplanation = explainPipelineChoice(roles, score);

  return { score, pipeline, pipelineExplanation, label };
}

/**
 * Build the triage response message and keyboard for F1.
 */
export function buildTriageResponse(
  description: string,
  triage: TriageResult,
): { message: string; keyboard: InlineKeyboard } {
  const shortDesc = description.length > 100 ? description.substring(0, 97) + "..." : description;

  const message = [
    `Complexite estimee : ${triage.label} (${Math.round(triage.score * 100)}%)`,
    triage.pipelineExplanation,
    "",
    `Description : ${shortDesc}`,
  ].join("\n");

  // Telegram callback data must be <=64 bytes, so we don't embed the description
  // We store it in the session instead
  const keyboard = new InlineKeyboard()
    .text("Creer le PRD", "prdwf_create")
    .text("Juste une tache", "prdwf_task")
    .row()
    .text("Annuler", "prdwf_cancel");

  return { message, keyboard };
}

// ── F2: PRD Generation with Session Constraints ──────────────

/**
 * Extract session constraints into PRD generation format.
 */
export function extractSessionConstraints(
  constraints: DetectedConstraint[],
): PRDSessionConstraints {
  const result: PRDSessionConstraints = {};
  for (const c of constraints) {
    if (c.type === "speed") result.speed = c.value;
    else if (c.type === "quality") result.quality = c.value;
    else if (c.type === "budget") result.budget = c.value;
    else if (c.type === "scope") result.scope = c.value;
    else if (c.type === "deadline") result.deadline = c.value;
  }
  return result;
}

/**
 * Generate and save a PRD from the workflow context.
 */
export async function generateAndSavePRD(
  supabase: SupabaseClient,
  description: string,
  project: string,
  requestedBy: string,
  sessionConstraints?: PRDSessionConstraints,
  threadId?: number,
): Promise<PRD | null> {
  const generated = await generatePRD(description, project, sessionConstraints);
  if (!generated) return null;

  const prd = await savePRD(supabase, generated, {
    project,
    requested_by: requestedBy,
  });
  if (!prd) return null;

  // Shard for semantic search
  const currentProject = await resolveProjectContext(supabase, threadId);
  await shardDocument(supabase, {
    id: prd.id,
    title: prd.title,
    content: prd.content,
    type: "prd",
    project_id: currentProject?.id,
  });

  return prd;
}

// ── F3: Bounded Revision ─────────────────────────────────────

/**
 * Get the current revision count for a PRD.
 */
export function getRevisionCount(prd: PRD): number {
  return (prd.metadata as any)?.revision_count ?? 0;
}

/**
 * Check if more revisions are allowed.
 */
export function canRevise(prd: PRD): boolean {
  return getRevisionCount(prd) < MAX_REVISIONS;
}

/**
 * Build the revision keyboard based on remaining revisions.
 */
export function buildRevisionKeyboard(prd: PRD): InlineKeyboard {
  const revCount = getRevisionCount(prd);
  const kb = new InlineKeyboard()
    .text("Approuver", `prd_approve:${prd.id}`);

  if (revCount < MAX_REVISIONS) {
    kb.text(`Revision (${revCount}/${MAX_REVISIONS})`, `prdwf_revise:${prd.id}`);
  }

  kb.row().text("Rejeter", `prd_reject:${prd.id}`);

  return kb;
}

/**
 * Regenerate a PRD with revision feedback.
 */
export async function revisePRD(
  supabase: SupabaseClient,
  prd: PRD,
  feedback: string,
  sessionConstraints?: PRDSessionConstraints,
): Promise<PRD | null> {
  const revCount = getRevisionCount(prd) + 1;
  const description = [
    `PRD EXISTANT A REVISER:`,
    prd.content,
    "",
    `FEEDBACK UTILISATEUR (revision ${revCount}/${MAX_REVISIONS}):`,
    feedback,
    "",
    "Regenere le PRD en integrant les modifications demandees.",
  ].join("\n");

  const generated = await generatePRD(description, prd.project, sessionConstraints);
  if (!generated) return null;

  const updated = await updatePRDContent(supabase, prd.id, generated.content, {
    ...(prd.metadata as Record<string, unknown> || {}),
    revision_count: revCount,
  });

  return updated;
}

// ── F4: Post-Approval Decomposition ──────────────────────────

/**
 * Decompose an approved PRD into tasks.
 * Returns the number of tasks created.
 */
export async function decomposePRDIntoTasks(
  supabase: SupabaseClient,
  prd: PRD,
  projectSlug: string,
  projectId?: string,
): Promise<{ tasks: Array<{ id: string; title: string; priority: number }>; message: string }> {
  const prdDescription = `PRD: ${prd.title}\n${prd.summary || ""}\n\n${prd.content}`;
  const subtasks = await decomposeTask(prdDescription);

  if (subtasks.length === 0) {
    throw new Error("Aucune sous-tache generee depuis le PRD.");
  }

  const added: Array<{ id: string; title: string; priority: number; acceptance_criteria?: string }> = [];
  for (const st of subtasks) {
    const task = await addTask(supabase, st.title, {
      description: st.description,
      priority: st.priority,
      project: projectSlug,
      project_id: projectId,
    });
    if (task) {
      if (st.acceptance_criteria) {
        await supabase.from("tasks").update({
          acceptance_criteria: st.acceptance_criteria,
        }).eq("id", task.id);
        task.acceptance_criteria = st.acceptance_criteria;
      }
      const story = buildStoryFile(task);
      await enrichTaskWithStory(supabase, task.id, story);
      added.push(task);
    }
  }

  const lines = added.map((t, i) => {
    const acCount = (t.acceptance_criteria || "").split("\n").filter((l: string) => l.trim()).length;
    return `${i + 1}. P${t.priority} ${t.title} [${t.id.substring(0, 8)}]${acCount > 0 ? ` (${acCount} ACs)` : ""}`;
  });

  return {
    tasks: added.map((t) => ({ id: t.id, title: t.title, priority: t.priority })),
    message: `${added.length} taches creees depuis le PRD "${prd.title}" :\n${lines.join("\n")}`,
  };
}

// ── F5: Build Launch Confirmation ────────────────────────────

/**
 * Build the message and keyboard for implementation launch confirmation.
 */
export function buildLaunchConfirmation(
  prdId: string,
  pipeline: string,
  pipelineExplanation: string,
  taskCount: number,
): { message: string; keyboard: InlineKeyboard } {
  const message = [
    `${taskCount} taches pretes pour l'implementation.`,
    "",
    pipelineExplanation,
    "",
    "Confirmer le lancement ?",
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .text("Lancer l'implementation", `prdwf_launch:${prdId.substring(0, 8)}`)
    .row()
    .text("Voir le backlog", "jc_backlog")
    .text("Annuler", "prdwf_cancel");

  return { message, keyboard };
}

// ── F6: Gate Notifications ───────────────────────────────────

/**
 * Send a gate evaluation notification via the notification queue.
 */
export async function notifyGateResult(
  gateName: string,
  passed: boolean,
  score: number,
  autoApproved: boolean,
  agentRole?: string,
  trustScore?: number,
  reworkIteration?: number,
): Promise<void> {
  let message: string;

  if (autoApproved && trustScore !== undefined) {
    message = `Gate ${gateName} auto-approuvee (trust ${agentRole || "?"}: ${trustScore})`;
  } else if (reworkIteration && reworkIteration > 0) {
    message = `Gate ${gateName} : rework demande (iteration ${reworkIteration}/2)`;
  } else {
    message = `Gate ${gateName} evaluee : ${score}/100 (${passed ? "OK" : "ECHEC"})`;
  }

  await enqueue({
    type: "task",
    severity: "normal",
    message,
  });
}

// ── F7: PR Merge Notification ────────────────────────────────

/**
 * Build final notification with PR merge button.
 */
export function buildPRCompletionKeyboard(
  prUrl: string,
  gatesSummary: string,
): { message: string; keyboard: InlineKeyboard } {
  const message = [
    "Implementation terminee !",
    "",
    gatesSummary,
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .url("Voir la PR", prUrl)
    .text("Merger", `prdwf_merge:${extractPrNumber(prUrl)}`);

  return { message, keyboard };
}

function extractPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match?.[1] || "0";
}

// ── Workflow State Helpers ────────────────────────────────────

/**
 * Store the pending description in the session for callback resolution.
 */
const pendingDescriptions = new Map<string, string>();

export function storePendingDescription(chatKey: string, description: string): void {
  pendingDescriptions.set(chatKey, description);
  // Auto-cleanup after 10 minutes
  setTimeout(() => pendingDescriptions.delete(chatKey), 10 * 60 * 1000);
}

export function getPendingDescription(chatKey: string): string | undefined {
  return pendingDescriptions.get(chatKey);
}

export function clearPendingDescription(chatKey: string): void {
  pendingDescriptions.delete(chatKey);
}

/**
 * Store pending revision state.
 */
const pendingRevisions = new Map<string, { prdId: string; constraints?: PRDSessionConstraints }>();

export function storePendingRevision(chatKey: string, prdId: string, constraints?: PRDSessionConstraints): void {
  pendingRevisions.set(chatKey, { prdId, constraints });
  setTimeout(() => pendingRevisions.delete(chatKey), 5 * 60 * 1000);
}

export function getPendingRevision(chatKey: string): { prdId: string; constraints?: PRDSessionConstraints } | undefined {
  return pendingRevisions.get(chatKey);
}

export function clearPendingRevision(chatKey: string): void {
  pendingRevisions.delete(chatKey);
}

/**
 * Build chat key for pending state.
 */
export function chatKey(chatId: number, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`;
}
