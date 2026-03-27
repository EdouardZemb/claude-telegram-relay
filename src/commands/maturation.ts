/**
 * @module commands/maturation
 * @description Grammy Composer handling the /idea command.
 * Launches the maturation pipeline (understand → explore → confront → synthesize → advocate)
 * via job-manager, with inline keyboard for validate/modify/reject.
 */

import { Composer, type Context, InlineKeyboard } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { escapeHtml } from "../bot-context.ts";
import { createLogger } from "../logger.ts";
import { initRun, loadRunMeta, saveRunMeta } from "../maturation/documents.ts";
import { handlePhaseResult } from "../maturation/engine.ts";
import {
  runAdvocatePhase,
  runConfrontPhase,
  runExplorePhase,
  runSynthesizePhase,
  runUnderstandPhase,
} from "../maturation/phases.ts";
import {
  ALL_MATURATION_PHASES,
  createEmptyRun,
  type MaturationRun,
  PHASE_LABELS,
  toMaturationName,
} from "../maturation/types.ts";

const log = createLogger("maturation");

// ── Status symbols ─────────────────────────────────────────────

const STATUS_SYMBOLS: Record<string, string> = {
  pending: "\u25CB", // ○
  running: "\u25D4", // ◔
  ok: "\u25CF", // ●
  failed: "\u2717", // ✗
  skipped: "\u2013", // –
};

// ── Exported helpers ───────────────────────────────────────────

/**
 * Extracts the description from a "/idea <description>" string.
 * Returns null if the description is empty or only whitespace.
 */
export function parseIdeaCommand(text: string): string | null {
  const match = text.match(/^\/idea\s+([\s\S]+)/);
  if (!match) return null;
  const description = match[1].trim();
  return description.length > 0 ? description : null;
}

/**
 * Builds an inline keyboard with 3 buttons: Valider, Modifier, Rejeter.
 */
export function buildValidationKeyboard(runId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Valider", `mat_validate:${runId}`)
    .text("✏️ Modifier", `mat_modify:${runId}`)
    .text("❌ Rejeter", `mat_reject:${runId}`);
}

/**
 * Builds an HTML-formatted status bar showing all pipeline phases with symbols.
 */
export function buildMaturationStatusBar(run: MaturationRun): string {
  const parts: string[] = [];

  for (const phase of ALL_MATURATION_PHASES) {
    const step = run.steps[phase];
    const symbol = STATUS_SYMBOLS[step.status] ?? STATUS_SYMBOLS.pending;
    const label = escapeHtml(PHASE_LABELS[phase]);
    parts.push(`${symbol} ${label}`);
  }

  let bar = parts.join(" · ");
  if (run.iteration > 0) {
    bar += ` <i>(iteration ${run.iteration})</i>`;
  }
  return bar;
}

/**
 * Formats a full summary of a maturation run for Telegram (HTML).
 */
export function formatRunSummary(run: MaturationRun): string {
  const lines: string[] = [
    `<b>Maturation: ${escapeHtml(run.name)}</b>`,
    `<i>${escapeHtml(run.rawInput)}</i>`,
    "",
    buildMaturationStatusBar(run),
    "",
  ];

  for (const phase of ALL_MATURATION_PHASES) {
    const step = run.steps[phase];
    if (step.status === "pending") continue;
    const symbol = STATUS_SYMBOLS[step.status] ?? STATUS_SYMBOLS.pending;
    const label = escapeHtml(PHASE_LABELS[phase]);
    const line = `${symbol} <b>${label}</b>`;
    if (step.verdict) {
      lines.push(`${line}: ${escapeHtml(step.verdict)}`);
    } else {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

// ── Pipeline orchestration ─────────────────────────────────────

type OnProgress = (msg: string) => Promise<void>;

/**
 * Runs the maturation pipeline phases sequentially.
 * Phases: understand → (clarify?) → explore → confront → synthesize → advocate
 * Returns "MATURATION_READY:{name}:{id}" on success or "MATURATION_FAILED:{phase}:{name}" on failure.
 * If advocate loops back (currentPhase becomes explore), recursively calls itself.
 */
export async function runMaturationPipeline(
  run: MaturationRun,
  onProgress: OnProgress,
  bctx: BotContext,
): Promise<string> {
  const phases = [
    { name: "understand" as const, fn: runUnderstandPhase },
    { name: "explore" as const, fn: runExplorePhase },
    { name: "confront" as const, fn: runConfrontPhase },
    { name: "synthesize" as const, fn: runSynthesizePhase },
    { name: "advocate" as const, fn: runAdvocatePhase },
  ];

  // If currentPhase is "clarify", start the Socratic loop and pause the pipeline
  if (run.currentPhase === "clarify") {
    const { startClarification } = await import("../maturation/clarify.ts");
    const result = await startClarification(run, bctx.callClaude);
    if (result) {
      // Question sent — pipeline pauses, message handler takes over
      await onProgress(buildMaturationStatusBar(run));
      await onProgress(`\u2753 ${result.question}`);
      return `MATURATION_CLARIFYING:${run.name}:${run.id}`;
    }
    // Clarifier said DONE immediately — continue to explore
    log.info("clarify skipped by clarifier agent", { runId: run.id });
  }

  for (const { name: phaseName, fn: phaseFn } of phases) {
    // Skip if step is already done or not the current phase
    const step = run.steps[phaseName];
    if (step.status === "skipped" || step.status === "ok") continue;
    // Only run the current phase
    if (run.currentPhase !== phaseName) continue;

    // Mark as running
    run.steps[phaseName].status = "running";
    run.steps[phaseName].startedAt = new Date().toISOString();
    run.updatedAt = new Date().toISOString();
    await saveRunMeta(run);
    await onProgress(buildMaturationStatusBar(run));

    log.info("running maturation phase", { runId: run.id, phase: phaseName });

    let result: import("../maturation/engine.ts").PhaseResult;
    try {
      result = await phaseFn(run);
    } catch (err) {
      log.error("phase threw", { runId: run.id, phase: phaseName, error: String(err) });
      result = { status: "failed" as const, documents: [] };
    }

    // Apply result to run state machine
    run = handlePhaseResult(run, phaseName, result);
    await saveRunMeta(run);

    if (result.status === "failed") {
      await onProgress(buildMaturationStatusBar(run));
      return `MATURATION_FAILED:${phaseName}:${run.name}`;
    }

    await onProgress(buildMaturationStatusBar(run));

    // Post-synthesize checkpoint: pause if open questions found
    if (phaseName === "synthesize" && result.status === "ok") {
      const { startCheckpoint } = await import("../maturation/checkpoint.ts");
      const { readDocument } = await import("../maturation/documents.ts");
      const specContent = (await readDocument(run.id, "SPEC-UNIFIEE")) ?? "";
      const cp = await startCheckpoint(run, specContent, "synthesize", bctx.callClaude);
      if (cp) {
        const recLabel = cp.recommendation === "RE-EXPLORE" ? "Re-explorer" : "Continuer";
        await onProgress(
          `\u26A0\uFE0F <b>Decision requise</b> (synthese)\n\n${cp.summary}\n\n<i>Recommandation : ${recLabel}</i>`,
        );
        return `MATURATION_CHECKPOINT:${run.name}:${run.id}`;
      }
    }

    // If understand triggered clarify, pause the pipeline for Socratic loop
    if (phaseName === "understand" && run.currentPhase === "clarify") {
      const { startClarification } = await import("../maturation/clarify.ts");
      const clarifyResult = await startClarification(run, bctx.callClaude);
      if (clarifyResult) {
        await onProgress(buildMaturationStatusBar(run));
        await onProgress(`\u2753 ${clarifyResult.question}`);
        return `MATURATION_CLARIFYING:${run.name}:${run.id}`;
      }
      // Clarifier said DONE immediately — continue to explore
      log.info("clarify skipped by clarifier agent", { runId: run.id });
    }

    // Post-advocate checkpoint: pause if showstopper found
    if (phaseName === "advocate" && result.status === "ok") {
      const { startCheckpoint } = await import("../maturation/checkpoint.ts");
      const { readDocument } = await import("../maturation/documents.ts");
      const advocateContent = (await readDocument(run.id, "DEVILS-ADVOCATE")) ?? "";
      const cp = await startCheckpoint(run, advocateContent, "advocate", bctx.callClaude);
      if (cp) {
        const recLabel = cp.recommendation === "RE-EXPLORE" ? "Re-explorer" : "Continuer";
        await onProgress(
          `\u26A0\uFE0F <b>Decision requise</b> (advocate)\n\n${cp.summary}\n\n<i>Recommandation : ${recLabel}</i>`,
        );
        return `MATURATION_CHECKPOINT:${run.name}:${run.id}`;
      }
      // No showstopper — if state machine triggered loop-back, recurse
      if (run.currentPhase === "explore") {
        return await runMaturationPipeline(run, onProgress, bctx);
      }
    }
  }

  return `MATURATION_READY:${run.name}:${run.id}`;
}

/**
 * Resumes the maturation pipeline after clarification is complete.
 * Re-runs the understander with enriched input, then continues explore → advocate.
 */
export async function resumeMaturationAfterClarify(
  run: MaturationRun,
  enrichedInput: string,
  chatId: number | string,
  threadId: number | undefined,
  bctx: BotContext,
): Promise<void> {
  const { launch, sendProgressMessage } = await import("../job-manager.ts");

  await launch(
    `maturation-resume:${run.name}`,
    chatId,
    async () => {
      const onProgress: OnProgress = async (msg: string) => {
        await sendProgressMessage(chatId, threadId, msg);
      };

      // Re-run understander with enriched input
      run.rawInput = enrichedInput;
      run.steps.understand.status = "pending";
      await saveRunMeta(run);

      await onProgress("Comprehension enrichie en cours...");
      const { runUnderstandPhase } = await import("../maturation/phases.ts");
      const result = await runUnderstandPhase(run);
      const { handlePhaseResult } = await import("../maturation/engine.ts");
      run = handlePhaseResult(run, "understand", result);
      // Force skip clarify after re-run (already clarified)
      run.steps.clarify.status = "ok";
      run.currentPhase = "explore";
      await saveRunMeta(run);

      if (result.status === "failed") {
        return `MATURATION_FAILED:understand-v2:${run.name}`;
      }

      return await runMaturationPipeline(run, onProgress, bctx);
    },
    { messageThreadId: threadId },
  );
}

/**
 * Resumes the maturation pipeline after a checkpoint decision.
 * RE-EXPLORE: resets explore→advocate phases and increments iteration.
 * CONTINUE: advances currentPhase based on checkpoint source.
 */
export async function resumeMaturationAfterCheckpoint(
  run: MaturationRun,
  action: "CONTINUE" | "RE-EXPLORE",
  chatId: number | string,
  threadId: number | undefined,
  bctx: BotContext,
): Promise<void> {
  const { launch, sendProgressMessage } = await import("../job-manager.ts");

  if (action === "RE-EXPLORE") {
    const resetPhases: Array<"explore" | "confront" | "synthesize" | "advocate"> = [
      "explore",
      "confront",
      "synthesize",
      "advocate",
    ];
    for (const p of resetPhases) {
      run.steps[p].status = "pending";
      run.steps[p].documents = [];
      run.steps[p].verdict = undefined;
      run.steps[p].score = undefined;
      run.steps[p].startedAt = undefined;
      run.steps[p].completedAt = undefined;
    }
    run.currentPhase = "explore";
    run.iteration += 1;
    await saveRunMeta(run);
    log.info("checkpoint RE-EXPLORE: resetting to explore", {
      runId: run.id,
      iteration: run.iteration,
    });
  } else {
    // CONTINUE: advance to next phase based on checkpoint source
    if (run.resolvedCheckpoints?.length) {
      const lastCp = run.resolvedCheckpoints[run.resolvedCheckpoints.length - 1];
      if (lastCp.source === "synthesize") {
        run.currentPhase = "advocate";
      } else {
        run.currentPhase = "validate";
      }
    }
    await saveRunMeta(run);
    log.info("checkpoint CONTINUE: advancing", { runId: run.id, phase: run.currentPhase });
  }

  await launch(
    `maturation-checkpoint:${run.name}`,
    chatId,
    async () => {
      const onProgress: OnProgress = async (msg: string) => {
        await sendProgressMessage(chatId, threadId, msg);
      };
      return await runMaturationPipeline(run, onProgress, bctx);
    },
    { messageThreadId: threadId },
  );
}

// ── Composer factory ───────────────────────────────────────────

export default function maturationCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();
  const { sendResponseHtml, getThreadId } = bctx;

  // /idea <description> — launch maturation pipeline
  composer.command("idea", async (ctx) => {
    const rawInput = ctx.message?.text ?? "";
    const description = parseIdeaCommand(rawInput);

    if (!description) {
      await ctx.reply(
        "Usage: /idea <description>\n\nEx: /idea Export CSV des taches",
        bctx.threadOpts(ctx),
      );
      return;
    }

    const chatId = ctx.chat?.id ?? 0;
    const threadId = getThreadId(ctx);
    const name = toMaturationName(description);

    // Create run
    const run = createEmptyRun(chatId, threadId, name, description);
    await initRun(run);

    const statusBar = buildMaturationStatusBar(run);
    await sendResponseHtml(
      ctx,
      `<b>Maturation lancee</b>\n<code>${escapeHtml(name)}</code>\n\n${statusBar}`,
    );

    // Lazy import to avoid circular deps
    const { launch, isJobManagerEnabled, sendProgressMessage } = await import("../job-manager.ts");

    if (!isJobManagerEnabled()) {
      await sendResponseHtml(ctx, "⚠️ Job manager desactive. Pipeline non lance.");
      return;
    }

    const jobId = await launch(
      "maturation",
      chatId,
      async () => {
        const onProgress: OnProgress = async (msg: string) => {
          await sendProgressMessage(chatId, threadId, msg);
        };
        return await runMaturationPipeline(run, onProgress, bctx);
      },
      { messageThreadId: threadId },
    );

    log.info("maturation job launched", { jobId, runId: run.id, name });
  });

  // mat_validate callback
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    if (
      !data.startsWith("mat_validate:") &&
      !data.startsWith("mat_modify:") &&
      !data.startsWith("mat_reject:")
    ) {
      await next();
      return;
    }

    await ctx.answerCallbackQuery();

    const [action, runId] = data.split(":");

    const run = await loadRunMeta(runId);
    if (!run) {
      await ctx.reply("Run introuvable.", bctx.threadOpts(ctx));
      return;
    }

    if (action === "mat_validate") {
      await sendResponseHtml(
        ctx,
        `<b>Maturation validee</b>\n<code>${escapeHtml(run.name)}</code>\n\n${formatRunSummary(run)}`,
      );
    } else if (action === "mat_modify") {
      await sendResponseHtml(
        ctx,
        `<b>Modification demandee</b>\n<code>${escapeHtml(run.name)}</code>\n\nEnvoyez la description modifiee avec /idea pour relancer.`,
      );
    } else if (action === "mat_reject") {
      await sendResponseHtml(
        ctx,
        `<b>Maturation rejetee</b>\n<code>${escapeHtml(run.name)}</code>`,
      );
    }
  });

  // Checkpoint callbacks
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    if (!data.startsWith("mat_cp_opt:") && !data.startsWith("mat_cp_other:")) {
      await next();
      return;
    }

    await ctx.answerCallbackQuery();
    const threadId = getThreadId(ctx);

    if (data.startsWith("mat_cp_other:")) {
      const runId = data.split(":")[1];
      const run = await loadRunMeta(runId);
      if (!run?.pendingCheckpoint) {
        await ctx.reply("Checkpoint expire.", bctx.threadOpts(ctx));
        return;
      }
      run.pendingCheckpoint.awaitingFreeText = true;
      await saveRunMeta(run);
      await sendResponseHtml(
        ctx,
        `${run.pendingCheckpoint.summary}\n\nEnvoyez votre reponse en texte libre.`,
      );
      return;
    }

    // mat_cp_opt:{runId}:{index}
    const parts = data.split(":");
    const runId = parts[1];
    const optIndex = parseInt(parts[2], 10);

    const run = await loadRunMeta(runId);
    if (!run?.pendingCheckpoint) {
      await ctx.reply("Checkpoint expire.", bctx.threadOpts(ctx));
      return;
    }

    const choice = run.pendingCheckpoint.options[optIndex] ?? `Option ${optIndex + 1}`;
    const { handleCheckpointResponse } = await import("../maturation/checkpoint.ts");
    const cpResult = await handleCheckpointResponse(run, choice);

    await sendResponseHtml(ctx, `\u2705 Decision enregistree : <b>${escapeHtml(choice)}</b>`);
    await resumeMaturationAfterCheckpoint(run, cpResult.action, ctx.chat!.id, threadId, bctx);
  });

  return composer;
}
