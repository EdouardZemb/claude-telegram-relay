/**
 * @module commands/zz-messages
 * @description Composer for generic message handlers: text, voice, photo, document.
 * Prefixed with "zz-" to ensure it loads after all command handlers.
 * S37: Integrates intent detection -> command routing -> confirmation -> fallback conversation.
 * S45-T4: Document detection in photo + document handlers with extraction/classification pipeline.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { unlink, writeFile } from "fs/promises";
import { Composer, type Context, InlineKeyboard } from "grammy";
import { join } from "path";
import { type ActionDefinition, formatActionsForLLM, getAction } from "../action-registry.ts";
import { recordResponseTime } from "../alerts.ts";
import type { BotContext } from "../bot-context.ts";
import { ALLOWED_USER_ID, BOT_TOKEN, formatDocumentContext, UPLOADS_DIR } from "../bot-context.ts";
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
import { type DetectedIntent, detectIntent, detectIntentWithLLM } from "../intent-detection.ts";
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
import { transcribe } from "../transcribe.ts";
import {
  buildClassificationKeyboard,
  buildDuplicateKeyboard,
  registerPendingClassification,
  storePendingUpload,
} from "./documents.ts";
import { buildSddKeyboard, detectConvergenceInResponse } from "./sdd-flow.ts";

const log = createLogger("zz-messages");

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

// ── Command Router (inlined from command-router.ts) ──────────────

interface RouteResult {
  handled: boolean;
  pendingAction?: string;
}

interface RouterContext {
  supabase: SupabaseClient | null;
  getThreadId: (ctx: Context) => number | undefined;
  threadOpts: (ctx: Context) => { message_thread_id?: number };
  dispatchCommand: (ctx: Context, command: string) => Promise<void>;
}

interface PendingConfirmation {
  command: string;
  args: string;
  timestamp: number;
}

interface PendingClarification {
  command: string;
  missingParam: string;
  timestamp: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();
const pendingClarifications = new Map<string, PendingClarification>();
const CONFIRMATION_TTL_MS = 60_000;
const CLARIFICATION_TTL_MS = 60_000;

function confirmationKey(ctx: Context): string {
  const chatId = ctx.chat?.id || 0;
  const threadId = (ctx.message as { message_thread_id?: number })?.message_thread_id || 0;
  return `${chatId}:${threadId}`;
}

async function resolveTaskId(
  supabase: SupabaseClient | null,
  text: string,
): Promise<string | undefined> {
  if (!supabase) return undefined;
  const idMatch = text.match(/\b([a-f0-9]{4,8})\b/);
  if (idMatch) return idMatch[1];
  if (/\b(la|cette|ma)\s+tache\b/i.test(text)) {
    const { data } = await supabase
      .from("tasks")
      .select("id, title")
      .eq("status", "in_progress")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (data?.[0]) return data[0].id.substring(0, 8);
  }
  if (/\b(derniere|precedente)\s+tache\b/i.test(text)) {
    const { data } = await supabase
      .from("tasks")
      .select("id, title")
      .neq("status", "done")
      .order("created_at", { ascending: false })
      .limit(1);
    if (data?.[0]) return data[0].id.substring(0, 8);
  }
  return undefined;
}

async function resolveSprintId(supabase: SupabaseClient | null): Promise<string | undefined> {
  if (!supabase) return undefined;
  const { data } = await supabase
    .from("tasks")
    .select("sprint")
    .not("sprint", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.sprint || undefined;
}

function buildClarificationQuestion(action: ActionDefinition, paramName: string): string {
  switch (paramName) {
    case "taskId":
      return `Quelle tache veux-tu ${actionVerb(action.command)} ? Donne-moi l'ID ou les premiers caracteres.`;
    case "title":
      return "Quel titre pour la tache ?";
    case "request":
      return "Que veux-tu planifier ? Decris-moi ce que tu veux realiser.";
    case "taskCount":
      return "Combien de taches dans le sprint ?";
    case "time":
      return "A quelle heure ? (ex: 14h30, ou 2h pour dans 2 heures)";
    case "text":
      return "Quel texte pour le rappel ?";
    default:
      return `Quel ${paramName} ?`;
  }
}

function actionVerb(command: string): string {
  switch (command) {
    case "exec":
      return "executer";
    case "start":
      return "demarrer";
    case "done":
      return "terminer";
    default:
      return "traiter";
  }
}

async function routeIntent(
  ctx: Context,
  intent: DetectedIntent,
  rctx: RouterContext,
): Promise<RouteResult> {
  const action = intent.action || getAction(intent.command);
  if (!action) return { handled: false };
  if (action.requiresSupabase && !rctx.supabase) return { handled: false };

  let args = intent.args || "";
  const missingParams = action.params.filter((p) => p.required && !args.trim());

  if (missingParams.length > 0) {
    const paramName = missingParams[0].name;
    if (paramName === "taskId") {
      const resolved = await resolveTaskId(rctx.supabase, ctx.message?.text || "");
      if (resolved) args = resolved;
    } else if (paramName === "sprintId") {
      const resolved = await resolveSprintId(rctx.supabase);
      if (resolved) args = resolved;
    }
    if (!args.trim() && missingParams[0].required) {
      const key = confirmationKey(ctx);
      pendingClarifications.set(key, {
        command: action.command,
        missingParam: paramName,
        timestamp: Date.now(),
      });
      const question = buildClarificationQuestion(action, paramName);
      await ctx.reply(question, rctx.threadOpts(ctx));
      return { handled: true };
    }
  }

  if (action.risk === "high") {
    const key = confirmationKey(ctx);
    pendingConfirmations.set(key, { command: action.command, args, timestamp: Date.now() });
    const cmdStr = args ? `/${action.command} ${args}` : `/${action.command}`;
    const keyboard = new InlineKeyboard()
      .text("Confirmer", `intent_confirm:${action.command}`)
      .text("Annuler", "intent_cancel");
    await ctx.reply(
      `Action detectee : ${cmdStr}\n${action.description}\n\nConfirmer l'execution ?`,
      { ...rctx.threadOpts(ctx), reply_markup: keyboard },
    );
    return { handled: true, pendingAction: action.command };
  }

  const cmdStr = args ? `/${action.command} ${args}` : `/${action.command}`;
  await ctx.reply(cmdStr, rctx.threadOpts(ctx));
  await rctx.dispatchCommand(ctx, cmdStr);
  return { handled: true };
}

function checkPendingClarification(ctx: Context, text: string): string | null {
  const key = confirmationKey(ctx);
  const pending = pendingClarifications.get(key);
  if (!pending) return null;
  if (Date.now() - pending.timestamp > CLARIFICATION_TTL_MS) {
    pendingClarifications.delete(key);
    return null;
  }
  pendingClarifications.delete(key);
  return `/${pending.command} ${text.trim()}`;
}

function handleConfirmationCallback(ctx: Context, data: string): string | null {
  if (data === "intent_cancel") {
    const key = confirmationKey(ctx);
    pendingConfirmations.delete(key);
    return null;
  }
  if (data.startsWith("intent_confirm:")) {
    const chatId = ctx.callbackQuery?.message?.chat?.id || 0;
    const threadId =
      (ctx.callbackQuery?.message as { message_thread_id?: number })?.message_thread_id || 0;
    const key = `${chatId}:${threadId}`;
    const pending = pendingConfirmations.get(key);
    if (!pending || Date.now() - pending.timestamp > CONFIRMATION_TTL_MS) {
      pendingConfirmations.delete(key);
      return null;
    }
    pendingConfirmations.delete(key);
    return pending.args ? `/${pending.command} ${pending.args}` : `/${pending.command}`;
  }
  return null;
}

let _syntheticUpdateCounter = 0;

function buildSyntheticUpdate(ctx: Context, command: string): Record<string, unknown> {
  const slashEnd = command.indexOf(" ");
  const cmdLength = slashEnd !== -1 ? slashEnd : command.length;
  const chat = ctx.chat || ctx.callbackQuery?.message?.chat;
  const from = ctx.from || ctx.callbackQuery?.from;
  type MsgWithThread = { message_thread_id?: number };
  const threadId =
    (ctx.message as MsgWithThread)?.message_thread_id ||
    (ctx.callbackQuery?.message as MsgWithThread)?.message_thread_id;
  _syntheticUpdateCounter++;
  return {
    update_id: Date.now() + _syntheticUpdateCounter,
    message: {
      message_id: Date.now() + _syntheticUpdateCounter,
      from,
      chat,
      date: Math.floor(Date.now() / 1000),
      text: command,
      entities: [{ type: "bot_command", offset: 0, length: cmdLength }],
      ...(threadId ? { message_thread_id: threadId } : {}),
    },
  };
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

    await bctx.saveMessage("assistant", finalResponse, meta);
    await options.respond(ctx, finalResponse);

    // SDD convergence detection: if Claude signals decisions, offer SDD keyboard (R10, R11)
    const convergence = detectConvergenceInResponse(finalResponse);
    if (convergence) {
      const { getTracker } = await import("../pipeline-tracker.ts");
      const tracker = await getTracker(chatId, threadId);
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
