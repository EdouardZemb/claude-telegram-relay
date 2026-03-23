/**
 * @module commands/zz-messages
 * @description Composer for generic message handlers: text, voice, photo, document.
 * Prefixed with "zz-" to ensure it loads after all command handlers.
 * S37: Integrates intent detection -> command routing -> confirmation -> fallback conversation.
 * S45-T4: Document detection in photo + document handlers with extraction/classification pipeline.
 */

import { unlink, writeFile } from "fs/promises";
import { Composer, type Context } from "grammy";
import { join } from "path";
import { formatActionsForLLM } from "../action-registry.ts";
import { recordResponseTime } from "../alerts.ts";
import type { BotContext } from "../bot-context.ts";
import { ALLOWED_USER_ID, BOT_TOKEN, formatDocumentContext, UPLOADS_DIR } from "../bot-context.ts";
import {
  buildSyntheticUpdate,
  checkPendingClarification,
  handleConfirmationCallback,
  routeIntent,
} from "../command-router.ts";
import type { PendingProposal } from "../conversation-session.ts";
import {
  addConstraint,
  addIntent as addSessionIntent,
  addMessage as addSessionMessage,
  extractConstraints,
  formatSessionForIntent,
  getSession,
} from "../conversation-session.ts";
import type { DocumentCreateInput, DocumentSearchResult } from "../documents.ts";
import { checkDuplicate, computeFileHash, createDocument, searchDocuments } from "../documents.ts";
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
import { formatPRDDetail, getPRD } from "../prd.ts";
import {
  buildEnrichedDescription,
  buildRevisionKeyboard,
  buildTriageResponse,
  clearPendingRevision,
  getPendingRevision,
  isPrdWorkflowEnabled,
  chatKey as prdChatKey,
  revisePRD,
  storePendingDescription,
  triageDescription,
} from "../prd-workflow.ts";
import { transcribe } from "../transcribe.ts";
import {
  buildClassificationKeyboard,
  buildDuplicateKeyboard,
  registerPendingClassification,
  storePendingUpload,
} from "./documents.ts";

const log = createLogger("zz-messages");
// ── Proposal detection ───────────────────────────────────────

const PROPOSAL_PATTERNS: Array<{
  regex: RegExp;
  actionExtractor: (m: RegExpMatchArray) => string | null;
}> = [
  {
    regex:
      /tu\s+veux\s+que\s+je\s+(?:lance|cree|genere|fasse|execute|decompose)\s+(?:le|un|une)?\s*(prd|sprint|tache|plan|implementation|backlog|retro)/i,
    actionExtractor: (m) => mapProposalAction(m[1]),
  },
  {
    regex:
      /(?:je\s+(?:peux|pourrais)|on\s+(?:peut|pourrait))\s+(?:lancer|creer|generer|faire|executer|decomposer)\s+(?:le|un|une)?\s*(prd|sprint|tache|plan|implementation|backlog|retro)/i,
    actionExtractor: (m) => mapProposalAction(m[1]),
  },
  {
    regex:
      /on\s+(?:lance|cree|genere|fait)\s+(?:le|un|une)?\s*(prd|sprint|tache|plan|implementation|backlog|retro)\s*\?/i,
    actionExtractor: (m) => mapProposalAction(m[1]),
  },
];

function mapProposalAction(keyword: string | undefined): string | null {
  if (!keyword) return null;
  const map: Record<string, string> = {
    prd: "prd_workflow",
    sprint: "sprint",
    tache: "task",
    plan: "plan",
    implementation: "exec",
    backlog: "backlog",
    retro: "retro",
  };
  return map[keyword.toLowerCase()] || null;
}

/**
 * Detect if Claude's response contains a proposal for an action.
 * Returns a PendingProposal if found, null otherwise.
 */
function detectProposalInResponse(response: string): PendingProposal | null {
  const normalized = response.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const { regex, actionExtractor } of PROPOSAL_PATTERNS) {
    const m = normalized.match(regex) || response.match(regex);
    if (m) {
      const action = actionExtractor(m);
      if (action) {
        // Try to extract args (text after the action keyword)
        const afterMatch = response.substring((m.index || 0) + m[0].length).trim();
        const argsMatch = afterMatch.match(/(?:pour|de|sur)\s+(.+?)(?:\s*[?!.]|$)/i);
        return {
          action,
          args: argsMatch?.[1]?.trim(),
          timestamp: Date.now(),
          sourceMessage: response.substring(0, 200),
        };
      }
    }
  }
  return null;
}

// ── Document detection constants ──────────────────────────────

/** MIME types eligible for the document storage pipeline */
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Caption keywords hinting a photo is a document (French + English) */
const DOCUMENT_CAPTION_KEYWORDS = [
  "facture",
  "contrat",
  "recu",
  "ordonnance",
  "document",
  "attestation",
  "certificat",
  "devis",
  "fiche",
  "releve",
  "quittance",
  "bulletin",
  "invoice",
  "receipt",
  "contract",
  "scan",
  "archive",
  "stocke",
  "enregistre",
  "classe",
  "save",
  "store",
];

/** Keywords that need word-boundary matching to avoid false positives */
const DOCUMENT_BOUNDARY_KEYWORDS = ["note", "garde"];

/** Pre-compiled word-boundary regex for boundary keywords */
const DOCUMENT_BOUNDARY_REGEX = new RegExp(`\\b(${DOCUMENT_BOUNDARY_KEYWORDS.join("|")})\\b`, "i");

/** Minimum file size (bytes) heuristic — small photos are likely conversational */
const DOCUMENT_MIN_FILE_SIZE = 50 * 1024; // 50 KB

/**
 * Heuristic: detect whether a photo should be treated as a document.
 * Criteria (any match → document):
 * 1. Caption contains a document keyword
 * 2. File size >= threshold AND no conversational caption
 */
export function isPhotoDocument(caption: string | undefined, fileSize: number): boolean {
  const lowerCaption = (caption || "").toLowerCase();

  // Check caption keywords (substring match)
  for (const kw of DOCUMENT_CAPTION_KEYWORDS) {
    if (lowerCaption.includes(kw)) return true;
  }

  // Check boundary keywords (word-boundary match to avoid false positives)
  if (DOCUMENT_BOUNDARY_REGEX.test(lowerCaption)) return true;

  // Large photo with no caption or very short caption → likely a document scan
  if (fileSize >= DOCUMENT_MIN_FILE_SIZE && lowerCaption.length <= 5) {
    return true;
  }

  return false;
}

export default function messagesComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // ── Intent confirmation callbacks (S37-04) ─────────────────
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("intent_")) {
      await next();
      return;
    }

    const command = handleConfirmationCallback(ctx, data);
    if (command) {
      await ctx.answerCallbackQuery({ text: "Execution..." });
      await ctx.editMessageText(`Execution : ${command}`);
      // Dispatch the command through the bot's handler pipeline
      const update = buildSyntheticUpdate(ctx, command);
      await bctx.bot.handleUpdate(update as never);
    } else if (data === "intent_cancel") {
      await ctx.answerCallbackQuery({ text: "Annule." });
      await ctx.editMessageText("Action annulee.");
    } else {
      await ctx.answerCallbackQuery({ text: "Action expiree." });
    }
  });

  // ── Common message pipeline (text + voice) ──────────────────

  /**
   * Shared pipeline for text and voice message processing.
   * Extracted to eliminate duplication between text and voice handlers.
   *
   * Differences between text and voice are passed via options:
   * - saveMessageText: pre-formatted string for bctx.saveMessage (text: raw text, voice: "[Voice Xs]: transcription")
   * - includeDocumentSearch: true for text, false for voice
   * - promptPrefix: "" for text (raw input), "[Voice message transcribed]: " for voice
   * - respond: bctx.sendResponse for text, bctx.sendVoiceResponse for voice
   */
  interface MessageInputOptions {
    /** Pre-formatted text for saveMessage (e.g., "hello" or "[Voice 5s]: hello") */
    saveMessageText: string;
    /** Whether to include auto document search in context assembly */
    includeDocumentSearch: boolean;
    /** Prefix for the prompt sent to Claude (e.g., "" or "[Voice message transcribed]: ") */
    promptPrefix: string;
    /** Response function: sendResponse for text, sendVoiceResponse for voice */
    respond: (ctx: Context, text: string) => Promise<void>;
  }

  async function processMessageInput(
    ctx: Context,
    input: string,
    threadId: number | undefined,
    topicName: string | undefined,
    options: MessageInputOptions,
  ): Promise<void> {
    const meta: Record<string, unknown> = {};
    if (threadId) {
      meta.thread_id = threadId;
      if (topicName) meta.topic = topicName;
    }

    await bctx.saveMessage("user", options.saveMessageText, meta);

    // S43: Track conversation session
    const chatId = ctx.chat?.id || 0;
    const session = getSession(chatId, threadId);
    addSessionMessage(session, input);

    // Extract user constraints from the message
    const constraints = extractConstraints(input);
    for (const c of constraints) {
      addConstraint(session, c.type, c.value, c.source);
    }

    // S37: Check if this is a response to a pending clarification
    const clarificationCmd = checkPendingClarification(ctx, input);
    if (clarificationCmd) {
      const update = buildSyntheticUpdate(ctx, clarificationCmd);
      await bctx.bot.handleUpdate(update as never);
      return;
    }

    // PRD Workflow: Check if this is a revision response
    if (isPrdWorkflowEnabled() && bctx.supabase) {
      const ck = prdChatKey(chatId, threadId);
      const pendingRev = getPendingRevision(ck);
      if (pendingRev) {
        clearPendingRevision(ck);
        await ctx.replyWithChatAction("typing");
        try {
          const prd = await getPRD(bctx.supabase, pendingRev.prdId);
          if (prd) {
            const revised = await revisePRD(bctx.supabase, prd, input, pendingRev.constraints);
            if (revised) {
              const detail = formatPRDDetail(revised);
              const keyboard = buildRevisionKeyboard(revised);
              if (detail.length > 4000) {
                await bctx.sendResponse(ctx, detail);
                await ctx.reply("Actions:", { ...bctx.threadOpts(ctx), reply_markup: keyboard });
              } else {
                await ctx.reply(detail, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
              }
            } else {
              await ctx.reply("Erreur lors de la revision du PRD.", bctx.threadOpts(ctx));
            }
          } else {
            await ctx.reply("PRD introuvable.", bctx.threadOpts(ctx));
          }
        } catch (error) {
          log.error("PRD revision error", { error: String(error) });
          await ctx.reply("Erreur lors de la revision du PRD.", bctx.threadOpts(ctx));
        }
        return;
      }
    }

    // Check pending proposal confirmation
    if (session.pendingProposal && Date.now() - session.pendingProposal.timestamp < 5 * 60 * 1000) {
      const trimmed = input
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      const isConfirm =
        /^(oui|ok|vas[- ]?y|go|lance|d'?accord|dac|yes|yep|ouais|parfait|allez|bien\s+sur|evidemment|confirme|j'?approuve|c'?est\s+bon|envoie|fais[- ]le|on\s+y\s+va)/.test(
          trimmed,
        );
      const isReject =
        /^(non|pas|annul|stop|attend|arrete|nan|nope|plus\s+tard|pas\s+maintenant)/.test(trimmed);

      if (isConfirm) {
        const proposal = session.pendingProposal;
        session.pendingProposal = undefined;

        // Fix #1: For prd_workflow, go directly to triage with enriched description
        if (proposal.action === "prd_workflow" && isPrdWorkflowEnabled() && bctx.supabase) {
          const rawDescription =
            proposal.args || session.recentMessages.slice(-3).join("\n") || input;
          const description = buildEnrichedDescription(rawDescription, session);
          const triage = await triageDescription(description, bctx.supabase);
          const { message, keyboard } = buildTriageResponse(rawDescription, triage);
          const ck = prdChatKey(chatId, threadId);
          storePendingDescription(ck, description);
          await ctx.reply(message, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
          return;
        }

        const cmdStr = proposal.args
          ? `/${proposal.action} ${proposal.args}`
          : `/${proposal.action}`;
        const update = buildSyntheticUpdate(ctx, cmdStr);
        await bctx.bot.handleUpdate(update as never);
        return;
      }
      if (isReject) {
        session.pendingProposal = undefined;
        // Fall through to normal conversation
      }
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

    if (regexResult.detected && regexResult.detected.confidence >= 0.8) {
      // PRD Workflow: intercept suggest_prd OR create_prd intent when workflow enabled
      if (
        (regexResult.detected.intent === "suggest_prd" ||
          regexResult.detected.intent === "create_prd") &&
        isPrdWorkflowEnabled() &&
        bctx.supabase
      ) {
        addSessionIntent(
          session,
          regexResult.detected.intent,
          regexResult.detected.command,
          regexResult.detected.confidence,
          true,
        );
        const rawDescription = regexResult.detected.args || input;
        const enrichedDescription = buildEnrichedDescription(rawDescription, session);
        const triage = await triageDescription(enrichedDescription, bctx.supabase);
        const { message, keyboard } = buildTriageResponse(rawDescription, triage);
        const ck = prdChatKey(chatId, threadId);
        storePendingDescription(ck, enrichedDescription);
        await ctx.reply(message, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
        return;
      }
      // High-confidence regex match — route to command
      addSessionIntent(
        session,
        regexResult.detected.intent,
        regexResult.detected.command,
        regexResult.detected.confidence,
        true,
      );
      const routeResult = await routeIntent(ctx, regexResult.detected, routerCtx);
      if (routeResult.handled) return;
    } else {
      // LLM fallback for ambiguous messages — with session context
      const sessionCtx = formatSessionForIntent(session);
      const llmResult = await detectIntentWithLLM(input, {
        callLLM: (prompt) => bctx.callClaude(prompt),
        recentMessages,
        timeoutMs: 15000,
        sessionContext: sessionCtx,
      });
      if (llmResult.detected && llmResult.detected.confidence >= 0.8) {
        // PRD Workflow: intercept suggest_prd or create_prd from LLM
        if (
          (llmResult.detected.command === "prd_workflow" || llmResult.detected.command === "prd") &&
          isPrdWorkflowEnabled() &&
          bctx.supabase
        ) {
          addSessionIntent(
            session,
            llmResult.detected.intent,
            llmResult.detected.command,
            llmResult.detected.confidence,
            true,
          );
          const rawDescription = llmResult.detected.args || input;
          const enrichedDescription = buildEnrichedDescription(rawDescription, session);
          const triage = await triageDescription(enrichedDescription, bctx.supabase);
          const { message, keyboard } = buildTriageResponse(rawDescription, triage);
          const ck = prdChatKey(chatId, threadId);
          storePendingDescription(ck, enrichedDescription);
          await ctx.reply(message, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
          return;
        }
        addSessionIntent(
          session,
          llmResult.detected.intent,
          llmResult.detected.command,
          llmResult.detected.confidence,
          true,
        );
        const routeResult = await routeIntent(ctx, llmResult.detected, routerCtx);
        if (routeResult.handled) return;
      }
    }

    // Conversation fallback with action awareness
    const actionContext = `\nACTIONS DISPONIBLES (tu peux orienter l'utilisateur vers ces commandes si pertinent):\n${formatActionsForLLM()}`;

    const promptText = options.promptPrefix ? `${options.promptPrefix}${input}` : input;
    const documentContext = formatDocumentContext(docResults) || undefined;
    const enrichedPrompt = bctx.buildPrompt(
      promptText,
      relevantContext,
      memoryContext + actionContext,
      recentMessages,
      topicName,
      dynProfile,
      documentContext,
    );
    const rawResponse = await bctx.callClaude(enrichedPrompt, {
      resume: true,
      heartbeat: bctx.heartbeatOpts(ctx),
    });

    const finalResponse = await processMemoryIntents(bctx.supabase, rawResponse);

    // Detect proposals in Claude's response for future confirmation
    const proposal = detectProposalInResponse(finalResponse);
    if (proposal) {
      session.pendingProposal = proposal;
    }

    await bctx.saveMessage("assistant", finalResponse, meta);
    await options.respond(ctx, finalResponse);
  }

  // ── Text messages ──────────────────────────────────────────
  composer.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const messageId = ctx.message.message_id;
    const handlerStart = Date.now();

    const threadId = bctx.getThreadId(ctx);
    const topicName = bctx.getTopicName(ctx);
    log.info(
      `Message: ${text.substring(0, 50)}...${threadId ? ` [topic:${topicName || threadId}]` : ""}`,
    );

    try {
      await ctx.replyWithChatAction("typing");

      await processMessageInput(ctx, text, threadId, topicName, {
        saveMessageText: text,
        includeDocumentSearch: true,
        promptPrefix: "",
        respond: (c, r) => bctx.sendResponse(c, r),
      });

      recordResponseTime(Date.now() - handlerStart);
      bctx.clearError(messageId);
    } catch (error) {
      log.error("Text handler error", { error: String(error) });
      if (!bctx.recordError(messageId)) {
        await ctx
          .reply("Erreur lors du traitement du message. Reessaie.", bctx.threadOpts(ctx))
          .catch(() => {});
      }
    }
  });

  // Voice messages — with full intent detection (same pipeline as text handler)
  composer.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;
    const messageId = ctx.message.message_id;
    const handlerStart = Date.now();
    const threadId = bctx.getThreadId(ctx);
    const topicName = bctx.getTopicName(ctx);
    log.info(
      `Voice message: ${voice.duration}s${threadId ? ` [topic:${topicName || threadId}]` : ""}`,
    );

    try {
      await ctx.replyWithChatAction("typing");

      if (!process.env.VOICE_PROVIDER) {
        await ctx.reply(
          "Voice transcription is not set up yet. " +
            "Run the setup again and choose a voice provider (Groq or local Whisper).",
          bctx.threadOpts(ctx),
        );
        return;
      }

      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());

      const transcription = await transcribe(buffer);
      if (!transcription) {
        await ctx.reply("Could not transcribe voice message.", bctx.threadOpts(ctx));
        return;
      }

      await processMessageInput(ctx, transcription, threadId, topicName, {
        saveMessageText: `[Voice ${voice.duration}s]: ${transcription}`,
        includeDocumentSearch: false,
        promptPrefix: "[Voice message transcribed]: ",
        respond: (c, r) => bctx.sendVoiceResponse(c, r),
      });

      recordResponseTime(Date.now() - handlerStart);
      bctx.clearError(messageId);
    } catch (error) {
      log.error("Voice error", { error: String(error) });
      if (!bctx.recordError(messageId)) {
        await ctx
          .reply("Erreur lors du traitement du vocal. Reessaie.", bctx.threadOpts(ctx))
          .catch(() => {});
      }
    }
  });

  // Photos/Images — S45-T4: detect document vs conversational photo
  composer.on("message:photo", async (ctx) => {
    const messageId = ctx.message.message_id;
    const threadId = bctx.getThreadId(ctx);
    const topicName = bctx.getTopicName(ctx);
    log.info(`Image received${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

    try {
      await ctx.replyWithChatAction("typing");

      const meta: Record<string, unknown> = {};
      if (threadId) {
        meta.thread_id = threadId;
        if (topicName) meta.topic = topicName;
      }

      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const caption = ctx.message.caption;
      const fileSize = photo.file_size || 0;

      // S45-T4: Check if photo should be treated as a document
      if (bctx.supabase && isPhotoDocument(caption, fileSize)) {
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const userId = ctx.from?.id?.toString() || ALLOWED_USER_ID;
        const fileName = `photo_${Date.now()}.jpg`;

        try {
          // Duplicate detection
          const contentHash = computeFileHash(buffer);
          const dupCheck = await checkDuplicate(bctx.supabase, userId, fileName, contentHash);
          if (dupCheck.found && dupCheck.existingDocument) {
            const existing = dupCheck.existingDocument;
            const matchLabel =
              dupCheck.matchType === "content" ? "contenu identique" : "meme nom de fichier";
            const existingDate = new Date(existing.created_at).toLocaleDateString("fr-FR");
            const uploadInput: DocumentCreateInput = {
              userId,
              filePath: fileName,
              fileType: "image/jpeg",
              fileSize,
              buffer,
            };
            const uploadKey = storePendingUpload(ctx.chat?.id || 0, uploadInput);
            const keyboard = buildDuplicateKeyboard(uploadKey);

            await bctx.saveMessage("user", `[Document photo]: ${caption || "photo"}`, meta);
            await ctx.reply(
              `Doublon detecte (${matchLabel}) :\n` +
                `Document existant : ${existing.title || "Sans titre"} [${existing.id.substring(0, 8)}]\n` +
                `Ajoute le : ${existingDate}\n\n` +
                `Veux-tu quand meme l'ajouter ?`,
              { ...bctx.threadOpts(ctx), reply_markup: keyboard },
            );
            bctx.clearError(messageId);
            return;
          }

          const doc = await createDocument(bctx.supabase, {
            userId,
            filePath: fileName,
            fileType: "image/jpeg",
            fileSize,
            buffer,
          });

          await bctx.saveMessage("user", `[Document photo]: ${caption || "photo"}`, meta);

          const catName = (doc.metadata as Record<string, unknown>)?.classification_confidence
            ? doc.description || "non classifie"
            : "non classifie";
          const keyboard = buildClassificationKeyboard(doc.id, catName);

          if (doc.category_id) {
            registerPendingClassification(
              ctx.chat?.id || 0,
              doc.id,
              doc.category_id,
              catName,
              bctx.supabase,
            );
          }

          const extractionFailed2 =
            (doc.metadata as Record<string, unknown>)?.extraction_failed === true;
          const resultText = [
            `Document enregistre [${doc.id.substring(0, 8)}]`,
            doc.title ? `Titre: ${doc.title}` : "",
            doc.description ? `Description: ${doc.description}` : "",
            doc.document_date ? `Date: ${doc.document_date}` : "",
            extractionFailed2
              ? "\nAttention : l'extraction du texte a echoue. Le document est stocke mais non indexe pour la recherche."
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          await ctx.reply(resultText, {
            ...bctx.threadOpts(ctx),
            reply_markup: keyboard,
          });
          bctx.clearError(messageId);
          return;
        } catch (docError) {
          log.error("Document pipeline error on photo, falling back to conversation", {
            error: String(docError),
          });
          // Fall through to conversational photo handling
        }
      }

      // Standard conversational photo handling
      const timestamp = Date.now();
      const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

      const response = await fetch(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
      );
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer));

      const captionText = caption || "Analyze this image.";
      const prompt = `[Image: ${filePath}]\n\n${captionText}`;

      await bctx.saveMessage("user", `[Image]: ${captionText}`, meta);

      const claudeResponse = await bctx.callClaude(prompt, {
        resume: true,
        heartbeat: bctx.heartbeatOpts(ctx),
      });

      await unlink(filePath).catch(() => {});

      const cleanResponse = await processMemoryIntents(bctx.supabase, claudeResponse);
      await bctx.saveMessage("assistant", cleanResponse, meta);
      await bctx.sendResponse(ctx, cleanResponse);
      bctx.clearError(messageId);
    } catch (error) {
      log.error("Image error", { error: String(error) });
      if (!bctx.recordError(messageId)) {
        await ctx
          .reply("Erreur lors du traitement de l'image. Reessaie.", bctx.threadOpts(ctx))
          .catch(() => {});
      }
    }
  });

  // Documents — S45-T4: route storable documents through extraction/classification pipeline
  composer.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const messageId = ctx.message.message_id;
    const threadId = bctx.getThreadId(ctx);
    const topicName = bctx.getTopicName(ctx);
    log.info(`Document: ${doc.file_name}${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

    try {
      await ctx.replyWithChatAction("typing");

      const meta: Record<string, unknown> = {};
      if (threadId) {
        meta.thread_id = threadId;
        if (topicName) meta.topic = topicName;
      }

      const mimeType = doc.mime_type || "";
      const fileName = (doc.file_name || `file_${Date.now()}`).replace(/[/\\]/g, "_");

      // S45-T4: Route eligible MIME types through document storage pipeline
      if (bctx.supabase && DOCUMENT_MIME_TYPES.has(mimeType)) {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const userId = ctx.from?.id?.toString() || ALLOWED_USER_ID;

        try {
          // Duplicate detection
          const contentHash = computeFileHash(buffer);
          const dupCheck = await checkDuplicate(bctx.supabase, userId, fileName, contentHash);
          if (dupCheck.found && dupCheck.existingDocument) {
            const existing = dupCheck.existingDocument;
            const matchLabel =
              dupCheck.matchType === "content" ? "contenu identique" : "meme nom de fichier";
            const existingDate = new Date(existing.created_at).toLocaleDateString("fr-FR");
            const uploadInput: DocumentCreateInput = {
              userId,
              title: ctx.message.caption || undefined,
              filePath: fileName,
              fileType: mimeType,
              fileSize: doc.file_size || buffer.length,
              buffer,
            };
            const uploadKey = storePendingUpload(ctx.chat?.id || 0, uploadInput);
            const keyboard = buildDuplicateKeyboard(uploadKey);

            await bctx.saveMessage(
              "user",
              `[Document: ${fileName}]: ${ctx.message.caption || "fichier"}`,
              meta,
            );
            await ctx.reply(
              `Doublon detecte (${matchLabel}) :\n` +
                `Document existant : ${existing.title || "Sans titre"} [${existing.id.substring(0, 8)}]\n` +
                `Ajoute le : ${existingDate}\n\n` +
                `Veux-tu quand meme l'ajouter ?`,
              { ...bctx.threadOpts(ctx), reply_markup: keyboard },
            );
            bctx.clearError(messageId);
            return;
          }

          const createdDoc = await createDocument(bctx.supabase, {
            userId,
            title: ctx.message.caption || undefined,
            filePath: fileName,
            fileType: mimeType,
            fileSize: doc.file_size || buffer.length,
            buffer,
          });

          await bctx.saveMessage(
            "user",
            `[Document: ${fileName}]: ${ctx.message.caption || "fichier"}`,
            meta,
          );

          const catName = createdDoc.description || "non classifie";
          const keyboard = buildClassificationKeyboard(createdDoc.id, catName);

          if (createdDoc.category_id) {
            registerPendingClassification(
              ctx.chat?.id || 0,
              createdDoc.id,
              createdDoc.category_id,
              catName,
              bctx.supabase,
            );
          }

          const extractionFailed =
            (createdDoc.metadata as Record<string, unknown>)?.extraction_failed === true;
          const resultText = [
            `Document enregistre [${createdDoc.id.substring(0, 8)}]`,
            createdDoc.title ? `Titre: ${createdDoc.title}` : "",
            createdDoc.description ? `Description: ${createdDoc.description}` : "",
            createdDoc.document_date ? `Date: ${createdDoc.document_date}` : "",
            `Type: ${mimeType}`,
            extractionFailed
              ? "\nAttention : l'extraction du texte a echoue. Le document est stocke mais non indexe pour la recherche."
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          await ctx.reply(resultText, {
            ...bctx.threadOpts(ctx),
            reply_markup: keyboard,
          });
          bctx.clearError(messageId);
          return;
        } catch (docError) {
          log.error("Document pipeline error, falling back to Claude analysis", {
            error: String(docError),
          });
          // Fall through to standard Claude analysis
        }
      }

      // Standard Claude analysis for non-storable document types
      const file = await ctx.getFile();
      const timestamp = Date.now();
      const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

      const response = await fetch(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
      );
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer));

      const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
      const prompt = `[File: ${filePath}]\n\n${caption}`;

      await bctx.saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, meta);

      const claudeResponse = await bctx.callClaude(prompt, {
        resume: true,
        heartbeat: bctx.heartbeatOpts(ctx),
      });

      await unlink(filePath).catch(() => {});

      const cleanResponse = await processMemoryIntents(bctx.supabase, claudeResponse);
      await bctx.saveMessage("assistant", cleanResponse, meta);
      await bctx.sendResponse(ctx, cleanResponse);
      bctx.clearError(messageId);
    } catch (error) {
      log.error("Document error", { error: String(error) });
      if (!bctx.recordError(messageId)) {
        await ctx
          .reply("Erreur lors du traitement du document. Reessaie.", bctx.threadOpts(ctx))
          .catch(() => {});
      }
    }
  });

  return composer;
}
