/**
 * @module prd-workflow
 * @description Conversational PRD-to-Deploy workflow orchestrator.
 * State machine that chains: triage -> generation -> revision -> decomposition -> implementation -> notification.
 * Behind feature flag "prd_to_deploy".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { InlineKeyboard } from "grammy";
import {
  type AdversarialInput,
  runAdversarialChallenge,
  runImpactAnalysis,
} from "./adversarial-challenge.ts";
import { decomposeTask } from "./agent.ts";
import type { AdversarialResult, ImpactAnalysisResult, ProtoSpec } from "./agent-schemas.ts";
import {
  buildConversationContext,
  type ConversationSession,
  type DetectedConstraint,
} from "./conversation-session.ts";
import { shardDocument } from "./document-sharding.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import { enqueue } from "./notification-queue.ts";
import { explainPipelineChoice, type PipelineType } from "./pipeline-selection.ts";
import {
  generatePRD,
  type PRD,
  type PRDSessionConstraints,
  savePRD,
  updatePRDContent,
} from "./prd.ts";
import { resolveProjectContext } from "./projects.ts";
import { generateProtoSpec, type StoryFileInput } from "./spec-lite.ts";
import { buildStoryFile, enrichTaskWithStory } from "./story-files.ts";
import { addTask, type Task } from "./tasks.ts";

const MAX_REVISIONS = 3;

// ── Types ────────────────────────────────────────────────────

export interface TriageResult {
  score: number;
  pipeline: string;
  pipelineExplanation: string;
  label: string;
}

/** Preflight report combining P1 (proto-spec), P2 (adversarial), E1 (impact) */
export interface PreflightReport {
  prdId: string;
  prdTitle: string;
  /** P1: proto-specs per task (one per decomposed task) */
  protoSpecs: Array<{ taskId: string; taskTitle: string; spec: ProtoSpec }>;
  /** P2: adversarial challenge result on the global PRD */
  adversarial: AdversarialResult | null;
  /** E1: impact analysis result */
  impact: ImpactAnalysisResult | null;
  /** Consolidated verdict: PASS, PAUSE, or SKIPPED */
  verdict: "PASS" | "PAUSE" | "SKIPPED";
  /** Total preflight duration in ms */
  durationMs: number;
}

// ── Feature Flag Check ───────────────────────────────────────

export function isPrdWorkflowEnabled(): boolean {
  return isFeatureEnabled("prd_to_deploy");
}

// ── Description Enrichment ───────────────────────────────────

/**
 * Build an enriched description for PRD generation by combining
 * the detected description with the full conversation context.
 * Fixes the "PRD sans contexte" bug where only regex-captured args
 * were passed to the PRD generator.
 */
export function buildEnrichedDescription(
  detectedDescription: string,
  session: ConversationSession,
): string {
  const conversationContext = buildConversationContext(session);
  if (!conversationContext) return detectedDescription;

  return [
    "CONTEXTE DE LA DISCUSSION:",
    conversationContext,
    "",
    "DEMANDE:",
    detectedDescription,
  ].join("\n");
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
    // Create a pseudo-task for the scorer (cast to Task — missing fields default gracefully)
    const pseudoTask = {
      id: "triage",
      title: description.substring(0, 200),
      description,
      status: "backlog" as const,
      priority: 3,
      project: "telegram-relay",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sprint: null,
      tags: [],
      estimated_hours: null,
      actual_hours: null,
      blocked_by: null,
      notes: null,
      completed_at: null,
      acceptance_criteria: null,
      dev_notes: null,
      architecture_ref: null,
      subtasks: [],
      project_id: null,
    };
    const difficulty = await computeDifficultyScore(pseudoTask, supabase);
    score = difficulty.score;
    pipeline = difficulty.pipeline;
  } catch {
    // Fallback: estimate from text length
    const len = description.length;
    if (len < 50) {
      score = 0.2;
      pipeline = "SOLO";
    } else if (len < 150) {
      score = 0.45;
      pipeline = "LIGHT";
    } else {
      score = 0.7;
      pipeline = "DEFAULT";
    }
  }

  const label = score < 0.3 ? "faible" : score <= 0.6 ? "moyenne" : "haute";

  // Get pipeline explanation
  const {
    selectPipeline: _selectPipeline,
    SOLO_PIPELINE,
    LIGHT_PIPELINE,
    DEFAULT_PIPELINE,
    QUICK_PIPELINE,
    RESEARCH_PIPELINE,
    REVIEW_PIPELINE,
  } = await import("./pipeline-selection.ts");
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
  const kb = new InlineKeyboard().text("Approuver", `prd_approve:${prd.id}`);

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
    ...((prd.metadata as Record<string, unknown>) || {}),
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

  const added: Array<{
    id: string;
    title: string;
    priority: number;
    acceptance_criteria?: string | null;
  }> = [];
  for (const st of subtasks) {
    const task = await addTask(supabase, st.title, {
      description: st.description,
      priority: st.priority,
      project: projectSlug,
      project_id: projectId,
      tags: [`prd:${prd.id}`],
    });
    if (task) {
      if (st.acceptance_criteria) {
        await supabase
          .from("tasks")
          .update({
            acceptance_criteria: st.acceptance_criteria,
          })
          .eq("id", task.id);
        task.acceptance_criteria = st.acceptance_criteria;
      }
      const story = buildStoryFile(task);
      await enrichTaskWithStory(supabase, task.id, story);
      added.push(task);
    }
  }

  const lines = added.map((t, i) => {
    const acCount = (t.acceptance_criteria || "")
      .split("\n")
      .filter((l: string) => l.trim()).length;
    return `${i + 1}. P${t.priority} ${t.title} [${t.id.substring(0, 8)}]${acCount > 0 ? ` (${acCount} ACs)` : ""}`;
  });

  return {
    tasks: added.map((t) => ({ id: t.id, title: t.title, priority: t.priority })),
    message: `${added.length} tâches créées depuis le PRD "${prd.title}" :\n${lines.join("\n")}`,
  };
}

// ── F5: Build Launch Confirmation ────────────────────────────

/**
 * Build the message and keyboard for implementation launch confirmation.
 */
export function buildLaunchConfirmation(
  prdId: string,
  _pipeline: string,
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
  const message = ["Implementation terminee !", "", gatesSummary].join("\n");

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

export function storePendingRevision(
  chatKey: string,
  prdId: string,
  constraints?: PRDSessionConstraints,
): void {
  pendingRevisions.set(chatKey, { prdId, constraints });
  setTimeout(() => pendingRevisions.delete(chatKey), 5 * 60 * 1000);
}

export function getPendingRevision(
  chatKey: string,
): { prdId: string; constraints?: PRDSessionConstraints } | undefined {
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

// ── Pending Proto-Specs Storage (R8) ─────────────────────────

const pendingProtoSpecs = new Map<
  string,
  { protoSpecs: PreflightReport["protoSpecs"]; prdId: string }
>();

/**
 * Store proto-specs for a chat key with 10-minute TTL (R8).
 * Used between preflight completion and user confirmation.
 */
export function storePendingProtoSpec(
  key: string,
  prdId: string,
  protoSpecs: PreflightReport["protoSpecs"],
): void {
  pendingProtoSpecs.set(key, { protoSpecs, prdId });
  setTimeout(() => pendingProtoSpecs.delete(key), 10 * 60 * 1000);
}

/**
 * Retrieve pending proto-specs for a chat key.
 */
export function getPendingProtoSpec(
  key: string,
): { protoSpecs: PreflightReport["protoSpecs"]; prdId: string } | undefined {
  return pendingProtoSpecs.get(key);
}

/**
 * Clear pending proto-specs for a chat key.
 */
export function clearPendingProtoSpec(key: string): void {
  pendingProtoSpecs.delete(key);
}

// ── Preflight Check Feature Flag ─────────────────────────────

/**
 * Check if PRD maturation phases (preflight) are enabled.
 */
export function isPrdMaturationEnabled(): boolean {
  return isFeatureEnabled("prd_maturation_phases");
}

// ── Preflight Execution (R1, R2, R5, R5bis, R6, R7) ─────────

/**
 * Run the full preflight checks for a PRD.
 *
 * R1: Triggered after decomposition when prd_maturation_phases is active.
 * R2: P1 sequentially per task, then P2+E1 in parallel on the PRD global.
 * R5: P1 skipped when spec_phase_lite is off (protoSpecs: []).
 * R5bis: E1 uses story files impactedFiles when P1 is off.
 * R6: P2+E1 skipped when adversarial_challenge is off.
 *
 * @param prd The approved PRD
 * @param tasks The decomposed tasks
 * @returns PreflightReport with consolidated verdict
 */
export async function runPrdPreflightChecks(prd: PRD, tasks: Task[]): Promise<PreflightReport> {
  const startTime = Date.now();

  const runP1 = isFeatureEnabled("spec_phase_lite");
  const runP2E1 = isFeatureEnabled("adversarial_challenge");

  // If both sub-flags are off, return SKIPPED (R12 matrix row 5)
  if (!runP1 && !runP2E1) {
    return {
      prdId: prd.id,
      prdTitle: prd.title,
      protoSpecs: [],
      adversarial: null,
      impact: null,
      verdict: "SKIPPED",
      durationMs: Date.now() - startTime,
    };
  }

  // ── Phase P1: Proto-specs per task ──────────────────────────
  const protoSpecs: PreflightReport["protoSpecs"] = [];

  if (runP1) {
    for (const task of tasks) {
      const story = buildStoryFile(task);
      // Convert StoryFile to StoryFileInput: stringify AcceptanceCriterion objects
      const storyInput: StoryFileInput = {
        acceptanceCriteria: story.acceptanceCriteria.map(
          (ac) => `${ac.id}: Given ${ac.given}, When ${ac.when}, Then ${ac.then}`,
        ),
        implementationSteps: story.implementationSteps.map((s) => `${s.id}: ${s.title}`),
        testStubs: story.testStubs.map((t) => `${t.id}: ${t.description}`),
        impactedFiles: story.impactedFiles,
      };
      const spec = await generateProtoSpec(task, storyInput);
      protoSpecs.push({ taskId: task.id, taskTitle: task.title, spec });
    }
  }

  // ── Phase P2+E1: Adversarial + Impact in parallel ──────────
  let adversarial: AdversarialResult | null = null;
  let impact: ImpactAnalysisResult | null = null;

  if (runP2E1) {
    // Build synthetic AdversarialInput for the global PRD (R2, F-DA-1 correction)
    const challengeInput: AdversarialInput = {
      taskTitle: prd.title,
      taskDescription: prd.content,
      protoSpec: null,
      agentOutput:
        protoSpecs.length > 0 ? JSON.stringify(protoSpecs.map((p) => p.spec)) : undefined,
    };

    // Determine impacted files for E1
    let impactedFiles: string[];
    if (protoSpecs.length > 0) {
      // Union of impacted files from all proto-specs
      const fileSet = new Set<string>();
      for (const p of protoSpecs) {
        for (const f of p.spec.impacted_files) {
          fileSet.add(f);
        }
      }
      impactedFiles = Array.from(fileSet);
    } else {
      // R5bis: P1 off — use story files impactedFiles as fallback
      const fileSet = new Set<string>();
      for (const task of tasks) {
        const story = buildStoryFile(task);
        for (const f of story.impactedFiles) {
          fileSet.add(f);
        }
      }
      impactedFiles = Array.from(fileSet);
    }

    // P2+E1 in parallel (pattern from orchestrator.ts L.1154-1158)
    [adversarial, impact] = await Promise.all([
      runAdversarialChallenge(challengeInput),
      runImpactAnalysis(impactedFiles),
    ]);
  }

  // ── Verdict Computation ─────────────────────────────────────
  let verdict: PreflightReport["verdict"] = "PASS";

  if (adversarial) {
    // F-DA-2 correction: SKIPPED => PAUSE (prudence — agent failure should not validate)
    if (adversarial.verdict === "PAUSE" || adversarial.verdict === "SKIPPED") {
      verdict = "PAUSE";
    }
  }
  // If P2 was skipped (flag off) and P1 ran, verdict stays PASS

  return {
    prdId: prd.id,
    prdTitle: prd.title,
    protoSpecs,
    adversarial,
    impact,
    verdict,
    durationMs: Date.now() - startTime,
  };
}

// ── Preflight Report Formatting (R9) ─────────────────────────

/**
 * Format a PreflightReport as plain text for Telegram (R9).
 * - Always shows BLOQUANT findings.
 * - Shows MAJEUR findings if <= 3.
 * - Never shows MINEUR findings.
 * - No markdown characters (*, _, `).
 */
export function formatPreflightReport(report: PreflightReport): string {
  const lines: string[] = [];

  lines.push(`RAPPORT PRE-LANCEMENT — ${report.prdTitle}`);
  lines.push("");

  // Proto-spec section
  const totalVCriteria = report.protoSpecs.reduce((sum, p) => sum + p.spec.v_criteria.length, 0);
  const allFiles = new Set<string>();
  for (const p of report.protoSpecs) {
    for (const f of p.spec.impacted_files) allFiles.add(f);
  }
  lines.push(
    `Proto-spec : ${report.protoSpecs.length} taches analysees, ${totalVCriteria} V-criteres generes`,
  );
  lines.push(`Fichiers impactes : ${allFiles.size} fichiers identifies`);
  lines.push("");

  // Adversarial section
  if (report.adversarial) {
    lines.push(`Challenge adversarial : ${report.adversarial.verdict}`);
    const { bloquants, majeurs } = report.adversarial.stats;
    lines.push(`${bloquants} finding(s) bloquant(s), ${majeurs} finding(s) majeur(s)`);

    // R9: Always show BLOQUANT findings
    const bloquantFindings = report.adversarial.findings.filter((f) => f.severity === "BLOQUANT");
    for (const f of bloquantFindings) {
      lines.push(`  ${f.id} : ${f.title}`);
    }

    // R9: Show MAJEUR findings only if <= 3
    const majeurFindings = report.adversarial.findings.filter((f) => f.severity === "MAJEUR");
    if (majeurFindings.length > 0 && majeurFindings.length <= 3) {
      for (const f of majeurFindings) {
        lines.push(`  ${f.id} : ${f.title}`);
      }
    }
    lines.push("");
  } else {
    lines.push("Challenge adversarial : non execute");
    lines.push("");
  }

  // Impact section
  if (report.impact) {
    lines.push(`Analyse d'impact : risque ${report.impact.risk_level}`);
    lines.push(
      `${report.impact.modules_impacted_direct} modules directs, ${report.impact.modules_impacted_transitive} modules transitifs`,
    );
    if (report.impact.breaking_changes.length > 0) {
      for (const bc of report.impact.breaking_changes) {
        lines.push(`  Breaking : ${bc}`);
      }
    }
    lines.push("");
  } else {
    lines.push("Analyse d'impact : non executee");
    lines.push("");
  }

  // Duration
  const durationSec = Math.round(report.durationMs / 1000);
  lines.push(`Duree : ${durationSec}s`);

  return lines.join("\n");
}

/**
 * Build the result tag for job-manager (R14).
 * Format: PRDWF_PREFLIGHT:{prdId}|{verdict}|{resume}
 */
export function buildPreflightResultTag(report: PreflightReport): string {
  const taskCount = report.protoSpecs.length;
  const totalVCriteria = report.protoSpecs.reduce((sum, p) => sum + p.spec.v_criteria.length, 0);
  const riskLevel = report.impact?.risk_level || "N/A";
  const resume = `${taskCount} taches analysees, ${totalVCriteria} V-criteres, risque ${riskLevel}`;
  return `PRDWF_PREFLIGHT:${report.prdId}|${report.verdict}|${resume}`;
}

/**
 * Build the preflight keyboard with conditional buttons (R3, R10).
 * - Always: prdwf_preflight_ok, prdwf_preflight_abort
 * - If verdict PAUSE: also prdwf_revise_prd
 */
export function buildPreflightKeyboard(verdict: PreflightReport["verdict"]): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text("Continuer", `prdwf_preflight_ok`);
  if (verdict === "PAUSE") {
    kb.text("Reviser le PRD", `prdwf_revise_prd`);
  }
  kb.row().text("Annuler", `prdwf_preflight_abort`);
  return kb;
}
