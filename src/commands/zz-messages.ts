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
import { recordResponseTime } from "../alerts.ts";
import type { BotContext } from "../bot-context.ts";
import { ALLOWED_USER_ID, BOT_TOKEN, UPLOADS_DIR } from "../bot-context.ts";
import type { DocumentCreateInput } from "../documents.ts";
import { checkDuplicate, computeFileHash, createDocument } from "../documents.ts";
import { createLogger } from "../logger.ts";
import { processMemoryIntents } from "../memory.ts";
import { transcribe } from "../transcribe.ts";
import {
  buildSyntheticUpdate,
  handleConfirmationCallback,
  handleFeatureRequestCallback,
} from "./command-router.ts";
import {
  buildClassificationKeyboard,
  buildDuplicateKeyboard,
  registerPendingClassification,
  storePendingUpload,
} from "./documents.ts";
import { processMessageInput } from "./zz-messages-pipeline.ts";

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

  // ── Feature request confirmation callbacks ───────────────────
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("feature_request_")) {
      await next();
      return;
    }

    const command = handleFeatureRequestCallback(ctx, data, undefined);
    if (command) {
      await ctx.answerCallbackQuery({ text: "Lancement de l'exploration..." });
      await ctx.editMessageText(`Exploration lancee : ${command}`);
      const update = buildSyntheticUpdate(ctx, command);
      await bctx.bot.handleUpdate(update as never);
    } else if (data === "feature_request_cancel") {
      await ctx.answerCallbackQuery({ text: "OK, pas d'exploration." });
      await ctx.editMessageText("Pas de souci, on continue la conversation.");
    } else {
      await ctx.answerCallbackQuery({ text: "Demande expiree." });
    }
  });

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

      await processMessageInput(
        ctx,
        text,
        threadId,
        topicName,
        {
          saveMessageText: text,
          includeDocumentSearch: true,
          promptPrefix: "",
          respond: (c, r) => bctx.sendResponse(c, r),
        },
        bctx,
      );

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

      await processMessageInput(
        ctx,
        transcription,
        threadId,
        topicName,
        {
          saveMessageText: `[Voice ${voice.duration}s]: ${transcription}`,
          includeDocumentSearch: false,
          promptPrefix: "[Voice message transcribed]: ",
          respond: (c, r) => bctx.sendVoiceResponse(c, r),
        },
        bctx,
      );

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
