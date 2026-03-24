/**
 * @module commands/sdd-flow
 * @description Composer for SDD InlineKeyboard callbacks (prefix sdd_) and
 * contextual keyboard construction. Handles the UI layer of the conversational
 * SDD pipeline: button clicks -> tracker update -> job launch.
 *
 * Phase 2 Architecture V2 — independent Composer, auto-loaded by loader.ts.
 */

import { Composer, type Context, InlineKeyboard } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { assembleHandoffContext } from "../conversation-handoff.ts";
import { isJobManagerEnabled, launch } from "../job-manager.ts";
import { createLogger } from "../logger.ts";
import { getRecentMessages } from "../memory.ts";
import { formatStatusBar, getTracker, type SddPhase, updateStep } from "../pipeline-tracker.ts";
import {
  runSddChallenge,
  runSddDoc,
  runSddExplore,
  runSddImplement,
  runSddReview,
  runSddSpec,
} from "../sdd-agents.ts";

const log = createLogger("sdd-flow");

// ── Types ────────────────────────────────────────────────────

export type SddVerdict = "GO" | "PIVOT" | "DROP" | "GO_WITH_CHANGES" | "NO-GO";

// ── Convergence Detection (R10, V19, V20) ────────────────────

/**
 * Convergence signal detected in Claude's response.
 */
export interface ConvergenceSignal {
  /** Raw matched text */
  match: string;
}

/**
 * Detect convergence in Claude's response by regex (R10).
 * The system prompt instructs Claude to produce "Decisions: ..." when conversation converges.
 * Returns non-null when the pattern is found.
 */
export function detectConvergenceInResponse(response: string): ConvergenceSignal | null {
  // Unified pattern: matches "Decisions:" at start of line or after newline (F-DA-2 fix)
  const match = response.match(/(^|\n)Decisions:/);
  if (match) {
    return { match: match[0].trim() };
  }
  return null;
}

// ── Keyboard Construction (R14) ──────────────────────────────

/**
 * Build contextual SDD inline keyboard based on current phase and verdict.
 * Returns undefined if no buttons are applicable (e.g., DROP verdict).
 */
export function buildSddKeyboard(
  phase: string,
  name: string,
  verdict?: string,
): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  let hasButtons = false;

  switch (phase) {
    case "explore":
      if (!verdict) {
        // Initial state: offer explore or skip
        kb.text("Explorer", `sdd_explore:${name}`);
        kb.text("Discuter sans explorer", `sdd_discuss:${name}`);
        hasButtons = true;
      } else if (verdict === "GO") {
        kb.text("Discuter les resultats", `sdd_discuss:${name}`);
        kb.text("Specifier", `sdd_spec:${name}`);
        hasButtons = true;
      } else if (verdict === "PIVOT") {
        kb.text("Re-explorer", `sdd_explore:${name}`);
        kb.text("Discuter", `sdd_discuss:${name}`);
        hasButtons = true;
      } else if (verdict === "DROP") {
        // No action buttons — pipeline is dropped
        return undefined;
      }
      break;

    case "discuss":
      // Post-discussion convergence: offer to formalize
      kb.text("Formaliser en spec", `sdd_spec:${name}`);
      kb.text("Continuer", `sdd_discuss:${name}`);
      hasButtons = true;
      break;

    case "spec":
      // Post-spec: offer challenge or direct implementation
      kb.text("Challenger", `sdd_challenge:${name}`);
      kb.text("Implementer direct", `sdd_implement:${name}`);
      kb.row();
      kb.text("Reviser la spec", `sdd_spec:${name}`);
      hasButtons = true;
      break;

    case "challenge":
      if (verdict === "GO") {
        kb.text("Implementer", `sdd_implement:${name}`);
        hasButtons = true;
      } else if (verdict === "GO_WITH_CHANGES") {
        kb.text("Implementer avec corrections", `sdd_implement:${name}`);
        kb.text("Corriger la spec d'abord", `sdd_spec:${name}`);
        hasButtons = true;
      } else if (verdict === "NO-GO") {
        kb.text("Discuter les findings", `sdd_discuss:${name}`);
        kb.text("Retravailler la spec", `sdd_spec:${name}`);
        hasButtons = true;
        // No [Implementer] button for NO-GO
      }
      break;

    case "implement":
      kb.text("Review", `sdd_review:${name}`);
      kb.text("Corriger", `sdd_implement:${name}`);
      hasButtons = true;
      break;

    case "review":
      kb.text("Documenter", `sdd_doc:${name}`);
      hasButtons = true;
      break;

    case "doc":
      // Terminal phase: no continuation buttons
      return undefined;

    default:
      return undefined;
  }

  return hasButtons ? kb : undefined;
}

// ── SDD Result Prefix Parsing (F-SS-1 coordination) ──────────

/**
 * Parse SDD job result prefix for verdict extraction.
 * Format: SDD_{PHASE}_{VERDICT}: ...
 * Used by getCompletionKeyboard in job-manager.ts.
 */
export function parseSddResultPrefix(result: string): { phase: string; verdict: string } | null {
  const match = result.match(/^SDD_(\w+)_(\w[\w-]*?):/);
  if (!match) return null;
  return { phase: match[1].toLowerCase(), verdict: match[2] };
}

// ── Composer ──────────────────────────────────────────────────

export default function sddFlowComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // Guard: only handle sdd_ prefixed callbacks (R9)
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("sdd_")) {
      await next();
      return;
    }

    // Parse callback: sdd_{action}:{name}
    // Use split with limit to handle names containing ":" (F-EC-3)
    const withoutPrefix = data.substring(4); // strip "sdd_"
    const colonIndex = withoutPrefix.indexOf(":");
    if (colonIndex === -1) {
      await ctx.answerCallbackQuery({ text: "Format de callback invalide." });
      return;
    }

    const action = withoutPrefix.substring(0, colonIndex);
    const name = withoutPrefix.substring(colonIndex + 1);

    const chatId = ctx.chat?.id || 0;
    const threadId = ctx.callbackQuery.message?.message_thread_id;

    // Check tracker exists and is not expired (R4)
    const tracker = await getTracker(chatId, threadId);
    if (!tracker) {
      await ctx.answerCallbackQuery({ text: "Pipeline inconnu ou expire." });
      try {
        await ctx.reply(
          "Pipeline inconnu ou expire. Utilisez les commandes /dev-* pour demarrer un nouveau pipeline.",
          bctx.threadOpts(ctx),
        );
      } catch {
        // R5: optional IO -> degrade gracefully
      }
      return;
    }

    await ctx.answerCallbackQuery();

    // Handle SDD callbacks (R13)
    switch (action) {
      case "discuss": {
        // sdd_discuss: conversational phase, no job launch (R13)
        await updateStep(chatId, threadId, "discuss", { status: "ok" });
        await ctx.reply(
          "Phase discussion activee. Continuez la conversation pour affiner les decisions.",
          bctx.threadOpts(ctx),
        );
        break;
      }

      case "explore":
      case "spec":
      case "challenge":
      case "implement":
      case "review":
      case "doc": {
        // Agent-backed phases: launch via job-manager (R9, R13)
        const jobType = `sdd-${action}:${name}`;
        const phase = action as SddPhase;

        await updateStep(chatId, threadId, phase, { status: "running" });

        try {
          if (!isJobManagerEnabled()) {
            await ctx.reply(
              "Le job manager n'est pas actif. Utilisez les commandes /dev-* en attendant.",
              bctx.threadOpts(ctx),
            );
            await updateStep(chatId, threadId, phase, { status: "pending" });
            return;
          }

          // Build agent function — handoff assembled in callback (R9)
          let agentFn: () => Promise<string>;

          if (action === "explore") {
            agentFn = () => runSddExplore(name, chatId, threadId);
          } else if (action === "spec") {
            // Assemble handoff before launch (R9, F-DA-6)
            const recentMsgs = await getRecentMessages(bctx.supabase);
            const msgLines = recentMsgs ? recentMsgs.split("\n").filter(Boolean) : [];
            const handoff = assembleHandoffContext(msgLines, {
              pipelineName: name,
              explorationRef: tracker.steps.explore?.artifact,
            });
            agentFn = () => runSddSpec(name, handoff, bctx);
          } else if (action === "challenge") {
            agentFn = () => runSddChallenge(name, bctx);
          } else if (action === "implement") {
            agentFn = () => runSddImplement(name, bctx);
          } else if (action === "doc") {
            agentFn = () => runSddDoc(name, bctx);
          } else {
            // review
            agentFn = () => runSddReview(name, bctx);
          }

          const jobId = await launch(jobType, chatId, agentFn, { messageThreadId: threadId });
          await updateStep(chatId, threadId, phase, { jobId });

          // Display status bar (V21, F-SS-5)
          const updatedTracker = await getTracker(chatId, threadId);
          const statusBar = updatedTracker ? formatStatusBar(updatedTracker) : "";
          await ctx.reply(
            `Job lance ${jobType} (id: ${jobId})\n${statusBar || `Pipeline: ${name}`}`,
            bctx.threadOpts(ctx),
          );
        } catch (error) {
          log.error("SDD job launch error", { error: String(error), action, name });
          await updateStep(chatId, threadId, phase, { status: "failed" });
          await ctx.reply(`Erreur lors du lancement du job ${jobType}.`, bctx.threadOpts(ctx));
        }
        break;
      }

      default:
        log.warn("Unknown SDD callback action", { action, name });
        await ctx.reply(`Action SDD inconnue: ${action}`, bctx.threadOpts(ctx));
    }
  });

  return composer;
}
