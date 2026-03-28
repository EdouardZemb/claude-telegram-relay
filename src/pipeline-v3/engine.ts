/**
 * @module pipeline-v3/engine
 * @description Reflective loop state machine: implement -> review -> fix cycle
 * with circuit breaker. Calqued on maturation/engine.ts pattern.
 */

import { createLogger } from "../logger.ts";
import type { PanelVerdict, V3Phase, V3Run } from "./types.ts";

const log = createLogger("pipeline-v3/engine");

// ── Phase transitions ───────────────────────────────────────

export interface V3TransitionContext {
  /** Panel verdict from review phase */
  panelVerdict?: PanelVerdict;
  /** Current iteration */
  iteration?: number;
  /** Max iterations (circuit breaker) */
  maxIterations?: number;
}

/**
 * Determine the next phase based on the current phase and context.
 * Returns null when the pipeline should terminate.
 *
 * Flow:
 * bridge -> implement -> review -> {fix -> implement (loop)} | done
 * Circuit breaker: if iteration >= maxIterations -> failed (not done)
 */
export function getNextV3Phase(current: V3Phase, ctx: V3TransitionContext): V3Phase | null {
  switch (current) {
    case "bridge":
      return "implement";

    case "implement":
      return "review";

    case "review": {
      const verdict = ctx.panelVerdict?.verdict;
      if (verdict === "APPROVED") {
        return "done";
      }
      // CHANGES_REQUESTED: check circuit breaker
      const iteration = ctx.iteration ?? 0;
      const maxIterations = ctx.maxIterations ?? 3;
      if (iteration >= maxIterations - 1) {
        // Circuit breaker tripped — max iterations reached
        log.warn("Circuit breaker tripped", { iteration, maxIterations });
        return "failed";
      }
      return "fix";
    }

    case "fix":
      return "implement";

    case "done":
      return null;

    case "failed":
      return null;

    default:
      return null;
  }
}

// ── Phase result handling ───────────────────────────────────

export interface V3PhaseResult {
  status: "ok" | "failed";
  result?: string;
  panelVerdict?: PanelVerdict;
}

/**
 * Apply a phase result to the run state machine.
 * Updates step status, timestamps, and transitions to next phase.
 * Returns the mutated run.
 */
export function handleV3PhaseResult(run: V3Run, phase: V3Phase, result: V3PhaseResult): V3Run {
  const step = run.steps[phase];
  step.status = result.status;
  step.result = result.result;
  step.completedAt = new Date().toISOString();
  run.updatedAt = new Date().toISOString();

  if (result.status === "failed") {
    log.warn(`Phase ${phase} failed for run ${run.id}`);
    run.currentPhase = "failed";
    run.steps.failed.status = "ok";
    run.finalStatus = "failed";
    return run;
  }

  // Record panel verdict in history
  if (phase === "review" && result.panelVerdict) {
    run.panelHistory.push(result.panelVerdict);
  }

  const ctx: V3TransitionContext = {
    panelVerdict: result.panelVerdict,
    iteration: run.iteration,
    maxIterations: run.maxIterations,
  };

  const next = getNextV3Phase(phase, ctx);

  if (next === null) {
    // Terminal state
    if (run.currentPhase === "done" || phase === "done") {
      run.finalStatus = "merged";
    }
    return run;
  }

  // Increment iteration when looping back through fix -> implement
  if (phase === "fix" && next === "implement") {
    run.iteration += 1;
    // Reset implement and review steps for next iteration
    run.steps.implement.status = "pending";
    run.steps.implement.result = undefined;
    run.steps.implement.startedAt = undefined;
    run.steps.implement.completedAt = undefined;
    run.steps.review.status = "pending";
    run.steps.review.result = undefined;
    run.steps.review.startedAt = undefined;
    run.steps.review.completedAt = undefined;
    run.steps.fix.status = "pending";
    run.steps.fix.result = undefined;
    run.steps.fix.startedAt = undefined;
    run.steps.fix.completedAt = undefined;
    log.info(`V3 loop iteration ${run.iteration}`, { runId: run.id });
  }

  // Circuit breaker tripped
  if (next === "failed") {
    run.currentPhase = "failed";
    run.steps.failed.status = "ok";
    run.finalStatus = "circuit_breaker";
    log.warn(`V3 circuit breaker tripped for run ${run.id}`, {
      iteration: run.iteration,
      maxIterations: run.maxIterations,
    });
    return run;
  }

  // Mark done
  if (next === "done") {
    run.currentPhase = "done";
    run.steps.done.status = "ok";
    run.finalStatus = "merged";
    return run;
  }

  run.currentPhase = next;
  return run;
}
