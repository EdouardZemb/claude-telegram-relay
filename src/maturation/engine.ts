/**
 * @module maturation/engine
 * @description State machine for maturation phase transitions and loop logic.
 */

import { createLogger } from "../logger.ts";
import type { MaturationPhase, MaturationRun } from "./types.ts";

const log = createLogger("maturation/engine");

export const MAX_LOOP_ITERATIONS = 2;
const AMBIGUITY_THRESHOLD = 5;

// Test hook for spawn
type SpawnHook = (opts: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
let _spawnHook: SpawnHook | undefined;
export function _setSpawnHookForTests(fn: SpawnHook | undefined): void {
  _spawnHook = fn;
}

// Phase transition context
export interface TransitionContext {
  ambiguityScore?: number;
  showstopper?: boolean;
  iteration?: number;
  maxIterations?: number;
}

export function getNextPhase(
  current: MaturationPhase,
  ctx: TransitionContext,
): MaturationPhase | null {
  switch (current) {
    case "understand":
      return (ctx.ambiguityScore ?? 5) > AMBIGUITY_THRESHOLD ? "clarify" : "explore";
    case "clarify":
      return "explore";
    case "explore":
      return "confront";
    case "confront":
      return "synthesize";
    case "synthesize":
      return "advocate";
    case "advocate":
      if (ctx.showstopper && (ctx.iteration ?? 0) < (ctx.maxIterations ?? MAX_LOOP_ITERATIONS)) {
        return "explore";
      }
      return "validate";
    case "validate":
      return null;
    default:
      return null;
  }
}

export function shouldSkipClarify(ambiguityScore: number): boolean {
  return ambiguityScore <= AMBIGUITY_THRESHOLD;
}

// Phase result
export interface PhaseResult {
  status: "ok" | "failed";
  documents: string[];
  verdict?: string;
  score?: number;
}

export function handlePhaseResult(
  run: MaturationRun,
  phase: MaturationPhase,
  result: PhaseResult,
): MaturationRun {
  const step = run.steps[phase];
  step.status = result.status;
  step.documents = result.documents;
  step.verdict = result.verdict;
  step.score = result.score;
  step.completedAt = new Date().toISOString();
  run.updatedAt = new Date().toISOString();

  if (result.status === "failed") {
    log.warn(`Phase ${phase} failed for run ${run.id}`);
    return run;
  }

  const ctx: TransitionContext = {
    iteration: run.iteration,
    maxIterations: run.maxIterations,
  };

  if (phase === "understand" && result.verdict) {
    const ambMatch = result.verdict.match(/ambiguity:(\d+(?:\.\d+)?)/);
    ctx.ambiguityScore = ambMatch ? parseFloat(ambMatch[1]) : 5;
  }

  if (phase === "advocate" && result.verdict) {
    ctx.showstopper = result.verdict.toUpperCase().includes("SHOWSTOPPER");
  }

  const next = getNextPhase(phase, ctx);

  if (next === null) {
    log.info(`Maturation run ${run.id} reached terminal phase`);
    return run;
  }

  // Skip clarify if ambiguity is low
  if (phase === "understand" && next === "explore") {
    run.steps.clarify.status = "skipped";
  }

  // Handle loop from advocate back to explore
  if (phase === "advocate" && next === "explore") {
    run.iteration += 1;
    log.info(`Maturation run ${run.id} looping back (iteration ${run.iteration})`);
  }

  run.currentPhase = next;
  return run;
}
