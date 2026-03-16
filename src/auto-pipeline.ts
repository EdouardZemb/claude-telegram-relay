/**
 * @module auto-pipeline
 * @description Autonomous end-to-end pipeline with auto pipeline selection and retries.
 */

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
import {
  orchestrate,
  selectPipeline,
  classifyPipeline,
  type AgentRole,
  type OrchestratedResult,
} from "./orchestrator.ts";
import { buildStoryFile, enrichTaskWithStory } from "./story-files.ts";
import { WorkflowTracker } from "./workflow.ts";
import { Semaphore } from "./semaphore.ts";
import { routeTask, routerPipelineToRoles, type RouterDecision } from "./llm-router.ts";

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
  /** Use dynamic pipeline selection (S22-06) */
  autoPipeline?: boolean;
  /** Max retries per agent (S22-04) */
  maxRetries?: number;
  /** S25: Max concurrency for batch parallel execution (default: 2) */
  maxConcurrency?: number;
  /** S34: Use LLM router for dynamic pipeline selection (FR-004) */
  useRouter?: boolean;
  /** S34: Enable model cascade for agents (FR-003) */
  cascade?: boolean;
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
  const {
    onProgress,
    includeAnalysis = true,
    skipGates = false,
    autoPipeline = false,
    maxRetries = 0,
    useRouter = false,
    cascade = false,
  } = options;

  const progress = async (msg: string) => {
    if (onProgress) await onProgress(msg);
  };

  // S34: LLM router for dynamic pipeline selection (FR-004)
  let routerDecision: RouterDecision | null = null;
  if (useRouter) {
    routerDecision = await routeTask(task);
    if (routerDecision) {
      await progress(`LLM Router: pipeline=${routerDecision.pipeline}, budget=$${routerDecision.budget}, reason=${routerDecision.reasoning}`);
    } else {
      await progress("LLM Router: fallback to keyword-based selection");
    }
  }

  // S22-06: Log pipeline classification
  const pipelineType = routerDecision
    ? routerDecision.pipeline
    : (autoPipeline ? classifyPipeline(task) : "DEFAULT");
  await progress(`AUTO-PIPELINE demarre pour: ${task.title} (pipeline: ${pipelineType})`);

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

    const analysisPipeline = routerDecision
      ? routerPipelineToRoles(routerDecision).filter((r) => r !== "dev" && r !== "qa")
      : autoPipeline
        ? selectPipeline(task).filter((r) => r !== "dev" && r !== "qa")
        : (["analyst", "pm", "architect"] as AgentRole[]);

    const analysisResult = await orchestrate(supabase, task, {
      pipeline: analysisPipeline,
      onProgress,
      stopOnFailure: false,
      maxRetries,
      modelOverrides: routerDecision?.models,
      cascade,
    });

    const analysisOk = analysisResult.steps.filter((s) => s.success).length;
    await progress(`Analyse: ${analysisOk}/${analysisResult.steps.length} agents OK.`);

    // Reload task from DB so dev agent gets PM/Architect artefacts
    if (supabase) {
      const { data: enriched } = await supabase
        .from("tasks")
        .select("*")
        .eq("id", task.id)
        .single();
      if (enriched) {
        Object.assign(task, enriched);
      }
    }
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
 * Run auto-pipeline on multiple tasks.
 * S25: When maxConcurrency > 1, runs tasks in parallel via semaphore.
 * Otherwise falls back to sequential execution.
 * Parallel mode: no stop-on-first-failure (AC-020).
 */
export async function runBatchPipeline(
  supabase: SupabaseClient | null,
  tasks: Task[],
  options: PipelineOptions = {}
): Promise<PipelineResult[]> {
  const maxConcurrency = options.maxConcurrency ?? 1;

  if (maxConcurrency <= 1) {
    // Sequential (backward-compatible)
    const results: PipelineResult[] = [];
    for (const task of tasks) {
      if (options.onProgress) {
        await options.onProgress(`\nBatch: ${results.length + 1}/${tasks.length} — ${task.title}`);
      }
      const result = await runAutoPipeline(supabase, task, options);
      results.push(result);
      // Stop on blocking failure (sequential only)
      if (!result.success && result.phase === "blocked") {
        if (options.onProgress) {
          await options.onProgress(`Batch arrete: tache bloquee par gate.`);
        }
        break;
      }
    }
    return results;
  }

  // S25: Parallel batch execution
  const semaphore = new Semaphore(maxConcurrency);

  if (options.onProgress) {
    await options.onProgress(`Batch parallele: ${tasks.length} taches, max concurrency: ${maxConcurrency}`);
  }

  const settled = await Promise.allSettled(
    tasks.map(async (task, i) => {
      await semaphore.acquire();
      try {
        if (options.onProgress) {
          await options.onProgress(`Batch [${i + 1}/${tasks.length}]: ${task.title}`);
        }
        return await runAutoPipeline(supabase, task, options);
      } finally {
        semaphore.release();
      }
    })
  );

  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      success: false,
      phase: "blocked" as PipelinePhase,
      task: tasks[i],
      durationMs: 0,
      message: `Erreur: ${String(r.reason)}`,
    };
  });
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
