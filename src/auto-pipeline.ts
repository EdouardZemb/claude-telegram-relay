/**
 * Auto Pipeline — S16-09
 *
 * Automated end-to-end BMad pipeline for a task:
 *   PRD validation -> Architecture check -> Dev execution -> Code review -> Done
 *
 * Runs autonomously. Pauses only when a gate blocks (critical review findings,
 * CI failure, etc.) and notifies the user via Telegram.
 *
 * Uses the orchestrator for multi-agent chaining and gates for quality control.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "./tasks.ts";
import { updateTaskStatus } from "./tasks.ts";
import { executeTask } from "./agent.ts";
import { checkGatesWithOverrides } from "./gates.ts";
import { orchestrate, type AgentRole, type OrchestratedResult } from "./orchestrator.ts";
import { buildStoryFile, enrichTaskWithStory } from "./story-files.ts";
import { WorkflowTracker } from "./workflow.ts";
import { runCodeReview, formatReviewResult } from "./code-review.ts";

// ── Types ────────────────────────────────────────────────────

export type PipelinePhase =
  | "gate_check"
  | "story_enrichment"
  | "analysis"
  | "execution"
  | "review"
  | "done"
  | "blocked";

export interface PipelineResult {
  success: boolean;
  phase: PipelinePhase;
  task: Task;
  durationMs: number;
  message: string;
  blocked?: {
    reason: string;
    gate?: string;
    overridable: boolean;
  };
  prUrl?: string;
  reviewScore?: number;
}

export interface PipelineOptions {
  /** Send progress updates */
  onProgress?: (message: string) => Promise<void>;
  /** Include analysis phase (Analyst + PM + Architect before dev) */
  includeAnalysis?: boolean;
  /** Skip gate checks (for overridden tasks) */
  skipGates?: boolean;
}

// ── Auto Pipeline ────────────────────────────────────────────

/**
 * Run a task through the full automated BMad pipeline.
 *
 * Phases:
 * 1. Gate check — verify PRD + architecture requirements
 * 2. Story enrichment — generate structured story file
 * 3. Analysis (optional) — run Analyst + PM + Architect
 * 4. Execution — Dev agent implements the task
 * 5. Review — code review + CI checks
 * 6. Done — task completed
 */
export async function runAutoPipeline(
  supabase: SupabaseClient | null,
  task: Task,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const startTime = Date.now();
  const { onProgress, includeAnalysis = false, skipGates = false } = options;

  const progress = async (msg: string) => {
    if (onProgress) await onProgress(msg);
  };

  await progress(`AUTO-PIPELINE demarre pour: ${task.title}`);

  // Track workflow
  let tracker: WorkflowTracker | undefined;
  if (supabase) {
    tracker = new WorkflowTracker(supabase, {
      taskId: task.id,
      sprintId: task.sprint || undefined,
    });
  }

  // Phase 1: Gate check
  if (!skipGates && supabase) {
    await progress("Phase 1/5: Verification des gates...");
    if (tracker) await tracker.transition("validation");

    const gateResult = await checkGatesWithOverrides(supabase, task);
    if (gateResult) {
      await progress(`PIPELINE BLOQUE: ${gateResult.gate}\n${gateResult.reason}`);
      return {
        success: false,
        phase: "blocked",
        task,
        durationMs: Date.now() - startTime,
        message: `Pipeline bloque par ${gateResult.gate}`,
        blocked: {
          reason: gateResult.reason,
          gate: gateResult.gate,
          overridable: gateResult.overridable,
        },
      };
    }
    await progress("Gates OK.");
  }

  // Phase 2: Story enrichment
  await progress("Phase 2/5: Generation du story file...");
  const story = buildStoryFile(task);
  if (supabase) {
    await enrichTaskWithStory(supabase, task.id, story);
    // Refresh task with enriched data
    const { data: refreshed } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task.id)
      .single();
    if (refreshed) {
      Object.assign(task, refreshed);
    }
  }
  await progress(`Story file genere: ${story.acceptanceCriteria.length} ACs, ${story.implementationSteps.length} steps.`);

  // Phase 3: Analysis (optional)
  if (includeAnalysis) {
    await progress("Phase 3/5: Analyse multi-agents (Analyst -> PM -> Architect)...");
    if (tracker) await tracker.transition("decomposition");

    const analysisResult = await orchestrate(supabase, task, {
      pipeline: ["analyst", "pm", "architect"] as AgentRole[],
      onProgress,
      stopOnFailure: false,
    });

    const analysisOk = analysisResult.steps.filter((s) => s.success).length;
    await progress(`Analyse: ${analysisOk}/${analysisResult.steps.length} agents OK.`);
  } else {
    await progress("Phase 3/5: Analyse — sautee (mode rapide).");
  }

  // Phase 4: Execution
  await progress("Phase 4/5: Execution (Dev agent Amelia)...");
  if (tracker) await tracker.transition("execution");

  const execResult = await executeTask(supabase, task, onProgress);

  if (!execResult.success) {
    await progress(`EXECUTION ECHOUEE: ${execResult.error || "erreur inconnue"}`);
    return {
      success: false,
      phase: "execution",
      task,
      durationMs: Date.now() - startTime,
      message: `Execution echouee: ${execResult.error?.substring(0, 200) || "erreur inconnue"}`,
    };
  }

  await progress("Execution terminee.");

  // Phase 5: Review (already done in executeTask if there were changes)
  if (tracker) await tracker.transition("review");
  await progress("Phase 5/5: Review et CI...");

  if (execResult.reviewScore !== undefined) {
    await progress(`Code review: ${execResult.reviewScore}/100`);
  }

  if (execResult.ciPassed === false) {
    await progress(`CI echouee. Tache en review.`);
    return {
      success: false,
      phase: "review",
      task,
      durationMs: Date.now() - startTime,
      message: `CI echouee: ${execResult.ciDetails || "voir la PR"}`,
      prUrl: execResult.prUrl,
      reviewScore: execResult.reviewScore,
    };
  }

  // Done
  if (tracker) await tracker.transition("closure", { checkpoint_result: "pass" });
  const totalDuration = Math.round((Date.now() - startTime) / 1000);

  await progress(
    `AUTO-PIPELINE TERMINE en ${totalDuration}s\n` +
    `Tache: ${task.title}\n` +
    (execResult.prUrl ? `PR: ${execResult.prUrl}\n` : "") +
    (execResult.reviewScore !== undefined ? `Review: ${execResult.reviewScore}/100` : "")
  );

  return {
    success: true,
    phase: "done",
    task,
    durationMs: Date.now() - startTime,
    message: `Pipeline complete en ${totalDuration}s`,
    prUrl: execResult.prUrl,
    reviewScore: execResult.reviewScore,
  };
}

// ── Batch Pipeline ───────────────────────────────────────────

/**
 * Run auto-pipeline on multiple tasks sequentially.
 * Stops on first blocking failure.
 */
export async function runBatchPipeline(
  supabase: SupabaseClient | null,
  tasks: Task[],
  options: PipelineOptions = {}
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];

  for (const task of tasks) {
    if (options.onProgress) {
      await options.onProgress(`\nBatch: ${results.length + 1}/${tasks.length} — ${task.title}`);
    }

    const result = await runAutoPipeline(supabase, task, options);
    results.push(result);

    // Stop on blocking failure
    if (!result.success && result.phase === "blocked") {
      if (options.onProgress) {
        await options.onProgress(`Batch arrete: tache bloquee par gate.`);
      }
      break;
    }
  }

  return results;
}

// ── Formatting ───────────────────────────────────────────────

export function formatPipelineResult(result: PipelineResult): string {
  const lines: string[] = [];
  const status = result.success ? "OK" : "ECHEC";
  const duration = Math.round(result.durationMs / 1000);

  lines.push(`PIPELINE ${status} — ${result.task.title}`);
  lines.push(`Phase: ${result.phase} | Duree: ${duration}s`);

  if (result.prUrl) {
    lines.push(`PR: ${result.prUrl}`);
  }

  if (result.reviewScore !== undefined) {
    lines.push(`Review: ${result.reviewScore}/100`);
  }

  if (result.blocked) {
    lines.push("");
    lines.push(`BLOQUE: ${result.blocked.gate || "gate"}`);
    lines.push(result.blocked.reason);
    if (result.blocked.overridable) {
      lines.push("(peut etre bypass manuellement)");
    }
  }

  lines.push("");
  lines.push(result.message);

  return lines.join("\n").trim();
}
