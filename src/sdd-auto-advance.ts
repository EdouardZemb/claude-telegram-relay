/**
 * @module sdd-auto-advance
 * @description Event-driven auto-advancement for SDD pipeline phases.
 * When a phase completes with an auto-advanceable verdict (e.g., explore+GO, spec+OK),
 * the next phase is launched automatically without user intervention.
 *
 * Controlled by feature flag `sdd_auto_advance` and a per-chat depth circuit breaker
 * (max 3 consecutive auto-advances without user interaction).
 *
 * Extracted from job-manager.ts to respect the 800 LOC threshold.
 */

import type { Bot } from "grammy";
import { isFeatureEnabled } from "./feature-flags.ts";
import { createLogger } from "./logger.ts";
import { getTracker, type SddPhase, updateStep } from "./pipeline-tracker.ts";

const log = createLogger("sdd-auto-advance");

/** Maximum consecutive auto-advances without user interaction (circuit breaker). */
export const AUTO_ADVANCE_MAX_DEPTH = 3;

// ── Phase-Verdict Mapping ────────────────────────────────────

/**
 * Map of (phase, verdict) pairs that trigger automatic advancement to the next phase.
 * Only clean "success" verdicts are auto-advanceable. Ambiguous or failure verdicts
 * require user decision (GO_WITH_CHANGES, NO-GO, CHANGES_REQUESTED, PIVOT, DROP).
 */
const AUTO_ADVANCE_MAP: Record<string, SddPhase | null> = {
  "explore:GO": "discuss",
  "spec:OK": "challenge",
  "challenge:GO": "implement",
  "implement:OK": "review",
  "review:APPROVED": "doc",
};

/**
 * Determine the next SDD phase for auto-advancement based on current phase and verdict.
 * Returns null if the combination is not auto-advanceable (user decision required).
 */
export function getNextSddPhase(phase: string, verdict: string): SddPhase | null {
  return AUTO_ADVANCE_MAP[`${phase}:${verdict}`] ?? null;
}

// ── Depth Tracking (Circuit Breaker) ─────────────────────────

/**
 * Per-chat auto-advance depth counter. Tracks consecutive auto-advances
 * without user interaction. Resets when user clicks a callback button.
 * Key format: "chatId:threadId" or "chatId:main".
 */
const autoAdvanceDepth = new Map<string, number>();

function autoAdvanceKey(chatId: number | string, threadId?: number): string {
  return `${chatId}:${threadId ?? "main"}`;
}

/**
 * Get the current auto-advance depth for a chat/thread.
 */
export function getAutoAdvanceDepth(chatId: number | string, threadId?: number): number {
  return autoAdvanceDepth.get(autoAdvanceKey(chatId, threadId)) ?? 0;
}

/**
 * Reset the auto-advance depth counter for a chat/thread.
 * Call this when the user interacts manually (e.g., clicks a callback button).
 */
export function resetAutoAdvanceDepth(chatId: number | string, threadId?: number): void {
  autoAdvanceDepth.delete(autoAdvanceKey(chatId, threadId));
}

/**
 * Increment and return the new auto-advance depth for a chat/thread.
 */
function incrementAutoAdvanceDepth(chatId: number | string, threadId?: number): number {
  const key = autoAdvanceKey(chatId, threadId);
  const current = autoAdvanceDepth.get(key) ?? 0;
  const next = current + 1;
  autoAdvanceDepth.set(key, next);
  return next;
}

/**
 * Clear depth counters (for testing only).
 */
export function _clearDepthForTests(): void {
  autoAdvanceDepth.clear();
}

// ── Auto-Advance Agent Builder ───────────────────────────────

/**
 * Build the agent function for auto-advance. Uses lazy imports to avoid circular dependencies.
 * Returns null for phases that cannot be auto-advanced.
 */
async function buildAutoAdvanceAgentFn(
  phase: SddPhase,
  name: string,
  chatId: number,
  threadId?: number,
): Promise<(() => Promise<string>) | null> {
  // Lazy import to avoid circular deps and reduce startup cost
  const { runSddExplore, runSddSpec, runSddChallenge, runSddImplement, runSddReview, runSddDoc } =
    await import("./sdd-agents.ts");

  switch (phase) {
    case "explore":
      return () => runSddExplore(name, chatId, threadId);
    case "challenge":
      // Challenge needs BotContext — use minimal stub since auto-advance is non-interactive
      return () => runSddChallenge(name, null as unknown as import("./bot-context.ts").BotContext);
    case "implement":
      return () => runSddImplement(name, null as unknown as import("./bot-context.ts").BotContext);
    case "review": {
      // Review needs prUrl from implement step
      const tracker = await getTracker(chatId, threadId);
      const prUrl = tracker?.steps.implement?.prUrl;
      return () =>
        runSddReview(name, null as unknown as import("./bot-context.ts").BotContext, prUrl);
    }
    case "doc":
      return () => runSddDoc(name, null as unknown as import("./bot-context.ts").BotContext);
    case "discuss":
      // Discuss is conversational, not agent-backed — cannot auto-advance into it via job.
      // Instead, we just mark it as ok (user can start typing) and set status.
      return async () => {
        await updateStep(chatId, threadId, "discuss", { status: "ok" });
        return "SDD_DISCUSS_OK: auto-advanced from explore — discussion phase ready";
      };
    case "spec": {
      // Spec needs handoff context — assemble from recent messages
      const tracker = await getTracker(chatId, threadId);
      const { assembleHandoffContext } = await import("./conversation-handoff.ts");
      const handoff = assembleHandoffContext([], {
        pipelineName: name,
        explorationRef: tracker?.steps.explore?.artifact,
      });
      return () =>
        runSddSpec(name, handoff, null as unknown as import("./bot-context.ts").BotContext);
    }
    default:
      return null;
  }
}

// ── Core: tryAutoAdvance ─────────────────────────────────────

/** Verdict regex used to extract verdict from SDD result strings. */
const VERDICT_REGEX =
  /^SDD_\w+_(GO_WITH_CHANGES|NO-GO|GO|OK|FAILED|PIVOT|DROP|APPROVED|CHANGES_REQUESTED):/;

/**
 * Attempt to auto-advance the SDD pipeline after a job completion.
 * Called from job-manager.ts sendJobCompletionNotification.
 *
 * @param job - The completed job
 * @param botInstance - The bot instance for sending messages
 * @param launchFn - The job launch function (to avoid circular import)
 * @returns true if auto-advance was triggered, false otherwise
 */
export async function tryAutoAdvance(
  job: {
    type: string;
    status: string;
    result: string | null;
    chatId: number | string;
    messageThreadId?: number;
  },
  botInstance: Bot | null,
  launchFn: (
    type: string,
    chatId: number | string,
    fn: () => Promise<string>,
    opts?: { messageThreadId?: number },
  ) => Promise<string>,
): Promise<boolean> {
  if (
    job.status !== "completed" ||
    !job.type.startsWith("sdd-") ||
    !isFeatureEnabled("sdd_auto_advance")
  ) {
    return false;
  }

  const typeColonIdx = job.type.indexOf(":");
  if (typeColonIdx === -1) return false;

  const sddPhase = job.type.substring(4, typeColonIdx);
  const sddName = job.type.substring(typeColonIdx + 1);

  // Parse verdict from result
  const verdictMatch = job.result?.match(VERDICT_REGEX);
  if (!verdictMatch) return false;

  const verdict = verdictMatch[1];
  const nextPhase = getNextSddPhase(sddPhase, verdict);
  if (!nextPhase) return false;

  const chatIdNum = typeof job.chatId === "number" ? job.chatId : parseInt(String(job.chatId), 10);
  const depth = getAutoAdvanceDepth(chatIdNum, job.messageThreadId);

  if (depth >= AUTO_ADVANCE_MAX_DEPTH) {
    log.info("SDD auto-advance depth limit reached", {
      phase: sddPhase,
      verdict,
      nextPhase,
      depth,
      name: sddName,
    });
    return false;
  }

  const newDepth = incrementAutoAdvanceDepth(chatIdNum, job.messageThreadId);

  log.info("SDD auto-advance eligible", {
    phase: sddPhase,
    verdict,
    nextPhase,
    depth: newDepth,
    name: sddName,
  });

  try {
    // Send auto-advance notification to user
    if (botInstance) {
      const advanceOpts: Record<string, unknown> = {};
      if (job.messageThreadId) advanceOpts.message_thread_id = job.messageThreadId;

      const depthInfo = newDepth > 1 ? ` (${newDepth}/${AUTO_ADVANCE_MAX_DEPTH})` : "";
      await botInstance.api.sendMessage(
        job.chatId,
        `Auto-avancement : phase ${nextPhase} lancee suite au verdict ${verdict} de la phase precedente.${depthInfo}`,
        advanceOpts,
      );
    }

    // Launch the next phase job
    const nextJobType = `sdd-${nextPhase}:${sddName}`;
    await updateStep(chatIdNum, job.messageThreadId, nextPhase, { status: "running" });

    const agentFn = await buildAutoAdvanceAgentFn(
      nextPhase,
      sddName,
      chatIdNum,
      job.messageThreadId,
    );

    if (agentFn) {
      const jobId = await launchFn(nextJobType, job.chatId, agentFn, {
        messageThreadId: job.messageThreadId,
      });
      await updateStep(chatIdNum, job.messageThreadId, nextPhase, { jobId });
      log.info("SDD auto-advance launched", {
        nextPhase,
        jobId,
        name: sddName,
        depth: newDepth,
      });
    } else {
      log.warn("SDD auto-advance: no agent function for phase", { phase: nextPhase });
      await updateStep(chatIdNum, job.messageThreadId, nextPhase, { status: "pending" });
    }

    return true;
  } catch (advanceErr) {
    log.error("SDD auto-advance failed", {
      error: String(advanceErr),
      nextPhase,
      name: sddName,
    });
    // Rollback step status on failure
    try {
      await updateStep(chatIdNum, job.messageThreadId, nextPhase, { status: "pending" });
    } catch {
      // best-effort rollback
    }
    return false;
  }
}
