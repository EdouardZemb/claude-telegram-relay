/**
 * @module commands/zz-messages-pipeline
 * @description Shared message processing pipeline for text and voice handlers.
 * Extracted from zz-messages.ts to keep the module under the 800 LOC threshold (S3).
 * Handles: maturation intercepts, intent detection, context assembly, LLM call, SDD convergence.
 */

import type { Context } from "grammy";
import { formatActionsForLLM } from "../action-registry.ts";
import { spawnClaude } from "../agent.ts";
import type { BotContext } from "../bot-context.ts";
import { ALLOWED_USER_ID, formatDocumentContext } from "../bot-context.ts";
import type { DocumentSearchResult } from "../documents.ts";
import { searchDocuments } from "../documents.ts";
import { isFeatureEnabled } from "../feature-flags.ts";
import { detectIntent, detectIntentWithLLM } from "../intent-detection.ts";
import { createLogger } from "../logger.ts";
import {
  autoRemember,
  classifyMessage,
  getMemoryContext,
  getRecentMessages,
  getRelevantContext,
  processMemoryIntents,
  type ThoughtClassification,
} from "../memory.ts";
import { formatPipelineContextForPrompt, getTracker } from "../pipeline-tracker.ts";
import {
  buildSyntheticUpdate,
  checkPendingClarification,
  isFeatureRequestIntent,
  routeIntent,
  showFeatureRequestConfirmation,
  showFeatureRequestWithAR2,
} from "./command-router.ts";
import { buildSddKeyboard, detectConvergenceInResponse } from "./sdd-flow.ts";

const log = createLogger("zz-messages-pipeline");

// ── Types ────────────────────────────────────────────────────────

/**
 * Options for the shared message processing pipeline.
 * Differences between text and voice are passed via these options.
 */
export interface MessageInputOptions {
  /** Pre-formatted text for saveMessage (e.g., "hello" or "[Voice 5s]: hello") */
  saveMessageText: string;
  /** Whether to include auto document search in context assembly */
  includeDocumentSearch: boolean;
  /** Prefix for the prompt sent to Claude (e.g., "" or "[Voice message transcribed]: ") */
  promptPrefix: string;
  /** Response function: sendResponse for text, sendVoiceResponse for voice */
  respond: (ctx: Context, text: string) => Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────

const VNC_URL = "http://192.168.1.129:6080/vnc.html";

// ── Core pipeline ────────────────────────────────────────────────

/**
 * Shared pipeline for text and voice message processing.
 * Extracted from zz-messages.ts to reduce LOC (S3).
 *
 * Differences between text and voice are passed via options:
 * - saveMessageText: pre-formatted string for bctx.saveMessage
 * - includeDocumentSearch: true for text, false for voice
 * - promptPrefix: "" for text, "[Voice message transcribed]: " for voice
 * - respond: bctx.sendResponse for text, bctx.sendVoiceResponse for voice
 */
export async function processMessageInput(
  ctx: Context,
  input: string,
  threadId: number | undefined,
  topicName: string | undefined,
  options: MessageInputOptions,
  bctx: BotContext,
): Promise<void> {
  const meta: Record<string, unknown> = {};
  if (threadId) {
    meta.thread_id = threadId;
    if (topicName) meta.topic = topicName;
  }

  await bctx.saveMessage("user", options.saveMessageText, meta);

  // Maturation clarify: intercept messages when a Socratic question is pending
  const { checkMaturationClarify } = await import("../maturation/clarify.ts");
  const matRun = await checkMaturationClarify(ctx.chat?.id ?? 0, threadId);
  if (matRun) {
    const { handleClarifyResponse } = await import("../maturation/clarify.ts");
    const clarifyResult = await handleClarifyResponse(matRun, input, bctx.callClaude);
    if (clarifyResult.status === "waiting" && clarifyResult.question) {
      await bctx.sendResponseHtml(ctx, `\u2753 ${clarifyResult.question}`);
    } else if (clarifyResult.status === "done") {
      await bctx.sendResponseHtml(
        ctx,
        "\u2705 Clarification terminee. Reprise de la maturation...",
      );
      const { resumeMaturationAfterClarify } = await import("./maturation.ts");
      await resumeMaturationAfterClarify(
        matRun,
        clarifyResult.enrichedInput ?? matRun.rawInput,
        ctx.chat?.id ?? 0,
        threadId,
        bctx,
      );
    }
    return;
  }

  // Maturation checkpoint: intercept free-text response when "Autre" was clicked
  const { checkMaturationCheckpoint } = await import("../maturation/checkpoint.ts");
  const matCheckpoint = await checkMaturationCheckpoint(ctx.chat?.id ?? 0, threadId);
  if (matCheckpoint?.pendingCheckpoint?.awaitingFreeText) {
    const { handleCheckpointResponse } = await import("../maturation/checkpoint.ts");
    const cpResult = await handleCheckpointResponse(matCheckpoint, input);
    await bctx.sendResponseHtml(
      ctx,
      `\u2705 Decision enregistree. ${cpResult.action === "RE-EXPLORE" ? "Re-exploration en cours..." : "Pipeline continue..."}`,
    );
    const { resumeMaturationAfterCheckpoint } = await import("./maturation.ts");
    await resumeMaturationAfterCheckpoint(
      matCheckpoint,
      cpResult.action,
      ctx.chat?.id ?? 0,
      threadId,
      bctx,
    );
    return;
  }

  // S37: Check if this is a response to a pending clarification
  const clarificationCmd = checkPendingClarification(ctx, input);
  if (clarificationCmd) {
    const update = buildSyntheticUpdate(ctx, clarificationCmd);
    await bctx.bot.handleUpdate(update as never);
    return;
  }

  // Context assembly (document search only for text messages)
  const userId = ctx.from?.id?.toString() || ALLOWED_USER_ID;
  const contextPromises: [
    Promise<string>,
    Promise<string>,
    Promise<string>,
    Promise<string>,
    Promise<ThoughtClassification | null>,
    Promise<DocumentSearchResult[]>,
  ] = [
    getRelevantContext(bctx.supabase, input),
    getMemoryContext(bctx.supabase),
    getRecentMessages(bctx.supabase),
    bctx.getDynamicProfile(),
    classifyMessage(bctx.supabase, input, "user"),
    options.includeDocumentSearch && isFeatureEnabled("auto_document_search") && bctx.supabase
      ? Promise.race([
          searchDocuments(bctx.supabase, input, userId, { matchCount: 3, matchThreshold: 0.5 }),
          new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 5000)),
        ])
      : Promise.resolve([]),
  ];
  const [relevantContext, memoryContext, recentMessages, dynProfile, classification, docResults] =
    await Promise.all(contextPromises);

  if (classification?.is_memorable) {
    autoRemember(bctx.supabase, input, classification).catch(() => {});
  }

  // S37: Intent detection + routing (two-tier: regex fast path, then LLM fallback)
  const regexResult = detectIntent(input);

  const routerCtx = {
    supabase: bctx.supabase,
    getThreadId: bctx.getThreadId,
    threadOpts: bctx.threadOpts,
    dispatchCommand: async (sourceCtx: Context, command: string) => {
      const update = buildSyntheticUpdate(sourceCtx, command);
      await bctx.bot.handleUpdate(update as never);
    },
  };

  // Feature request interception: AR2 gate (if enabled) or standard confirmation
  if (regexResult.detected && isFeatureRequestIntent(regexResult.detected)) {
    const subject = regexResult.detected.args || input;
    if (isFeatureEnabled("ar2_gate_enabled")) {
      await showFeatureRequestWithAR2(ctx, subject, bctx.threadOpts(ctx), bctx.callClaude);
    } else {
      await showFeatureRequestConfirmation(ctx, subject, bctx.threadOpts(ctx));
    }
    return;
  }

  if (regexResult.detected && regexResult.detected.confidence >= 0.8) {
    // High-confidence regex match — route to command
    const routeResult = await routeIntent(ctx, regexResult.detected, routerCtx);
    if (routeResult.handled) return;
  } else {
    // LLM fallback for ambiguous messages
    const llmResult = await detectIntentWithLLM(input, {
      callLLM: (prompt) => bctx.callClaude(prompt),
      recentMessages,
      timeoutMs: 15000,
    });

    // Feature request interception from LLM fallback
    if (llmResult.detected && isFeatureRequestIntent(llmResult.detected)) {
      const subject = llmResult.detected.args || input;
      if (isFeatureEnabled("ar2_gate_enabled")) {
        await showFeatureRequestWithAR2(ctx, subject, bctx.threadOpts(ctx), bctx.callClaude);
      } else {
        await showFeatureRequestConfirmation(ctx, subject, bctx.threadOpts(ctx));
      }
      return;
    }

    if (llmResult.detected && llmResult.detected.confidence >= 0.8) {
      const routeResult = await routeIntent(ctx, llmResult.detected, routerCtx);
      if (routeResult.handled) return;
    }
  }

  // Conversation fallback with action awareness
  const actionContext = `\nACTIONS DISPONIBLES (tu peux orienter l'utilisateur vers ces commandes si pertinent):\n${formatActionsForLLM()}`;

  // Pipeline context injection: enrich prompt with SDD pipeline state when active
  const chatId = ctx.chat?.id || 0;
  const tracker = await getTracker(chatId, threadId);
  const pipelineContext = formatPipelineContextForPrompt(tracker);

  const promptText = options.promptPrefix ? `${options.promptPrefix}${input}` : input;
  const documentContext = formatDocumentContext(docResults) || undefined;
  const enrichedMemoryContext = pipelineContext
    ? pipelineContext + "\n" + memoryContext + actionContext
    : memoryContext + actionContext;
  const enrichedPrompt = bctx.buildPrompt(
    promptText,
    relevantContext,
    enrichedMemoryContext,
    recentMessages,
    topicName,
    dynProfile,
    documentContext,
  );
  const rawResponse = await bctx.callClaude(enrichedPrompt, {
    resume: true,
    heartbeat: bctx.heartbeatOpts(ctx),
  });

  // Browser delegation: if Claude signals [BROWSE: ...], spawn Claude Code with Chrome
  const browseMatch = rawResponse.match(/\[BROWSE:\s*(.+?)\]/s);
  if (browseMatch) {
    const browseInstruction = browseMatch[1].trim();
    log.info(`Browser delegation detected: ${browseInstruction.substring(0, 80)}...`);
    await options.respond(
      ctx,
      `Navigation en cours... Si un captcha apparait, interviens ici :\n${VNC_URL}`,
    );
    await ctx.replyWithChatAction("typing");
    try {
      const browseStart = Date.now();
      const browseResult = await spawnClaude({
        prompt:
          browseInstruction +
          "\nIMPORTANT: Si tu rencontres un captcha ou une verification anti-bot, " +
          "dis-le clairement dans ta reponse et attends 30 secondes avant de reessayer " +
          "(l'utilisateur peut intervenir manuellement via noVNC).",
        chrome: true,
        effort: "high",
        timeout: 180_000,
      });
      const elapsed = ((Date.now() - browseStart) / 1000).toFixed(0);
      log.info(
        `Browser result: exit=${browseResult.exitCode} stdout=${browseResult.stdout.length}b stderr=${browseResult.stderr.length}b elapsed=${elapsed}s`,
      );
      if (browseResult.exitCode !== 0) {
        log.error(`Browser stderr: ${browseResult.stderr.substring(0, 500)}`);
      }
      const browseResponse = browseResult.stdout.trim() || "Aucun résultat du navigateur.";
      await bctx.saveMessage("assistant", browseResponse, meta);
      await options.respond(ctx, browseResponse);
    } catch (browseError) {
      log.error("Browser delegation failed", { error: String(browseError) });
      await options.respond(ctx, "La navigation web a échoué. Réessaie dans quelques instants.");
    }
    return;
  }

  const finalResponse = await processMemoryIntents(bctx.supabase, rawResponse);

  await bctx.saveMessage("assistant", finalResponse, meta);
  await options.respond(ctx, finalResponse);

  // SDD convergence detection: if Claude signals decisions, offer SDD keyboard (R10, R11)
  const convergence = detectConvergenceInResponse(finalResponse);
  if (convergence) {
    if (tracker) {
      const keyboard = buildSddKeyboard("discuss", tracker.name);
      if (keyboard) {
        await ctx.reply("Convergence detectee. Actions disponibles :", {
          ...bctx.threadOpts(ctx),
          reply_markup: keyboard,
        });
      }
    }
  }
}
