/**
 * @module commands/zz-messages
 * @description Composer for generic message handlers: text, voice, photo, document.
 * Prefixed with "zz-" to ensure it loads after all command handlers.
 */

import { Composer, type Context, InputFile } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { BOT_TOKEN, UPLOADS_DIR } from "../bot-context.ts";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { transcribe } from "../transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentMessages,
  classifyMessage,
  autoRemember,
} from "../memory.ts";
import { recordResponseTime } from "../alerts.ts";

export default function messagesComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // Text messages
  composer.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const messageId = ctx.message.message_id;
    const handlerStart = Date.now();

    const threadId = bctx.getThreadId(ctx);
    const topicName = bctx.getTopicName(ctx);
    console.log(`Message: ${text.substring(0, 50)}...${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

    try {
      await ctx.replyWithChatAction("typing");

      const meta: Record<string, unknown> = {};
      if (threadId) {
        meta.thread_id = threadId;
        if (topicName) meta.topic = topicName;
      }

      await bctx.saveMessage("user", text, meta);

      const [relevantContext, memoryContext, recentMessages, dynProfile, classification] = await Promise.all([
        getRelevantContext(bctx.supabase, text),
        getMemoryContext(bctx.supabase),
        getRecentMessages(bctx.supabase),
        bctx.getDynamicProfile(),
        classifyMessage(bctx.supabase, text, "user"),
      ]);

      if (classification?.is_memorable) {
        autoRemember(bctx.supabase, text, classification).catch(() => {});
      }

      const enrichedPrompt = bctx.buildPrompt(text, relevantContext, memoryContext, recentMessages, topicName, dynProfile);
      const rawResponse = await bctx.callClaude(enrichedPrompt, { resume: true, heartbeat: bctx.heartbeatOpts(ctx) });

      const response = await processMemoryIntents(bctx.supabase, rawResponse);

      await bctx.saveMessage("assistant", response, meta);
      await bctx.sendResponse(ctx, response);
      recordResponseTime(Date.now() - handlerStart);
      bctx.clearError(messageId);
    } catch (error) {
      console.error("Text handler error:", error);
      if (!bctx.recordError(messageId)) {
        await ctx.reply("Erreur lors du traitement du message. Reessaie.", bctx.threadOpts(ctx)).catch(() => {});
      }
    }
  });

  // Voice messages
  composer.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;
    const messageId = ctx.message.message_id;
    const threadId = bctx.getThreadId(ctx);
    const topicName = bctx.getTopicName(ctx);
    console.log(`Voice message: ${voice.duration}s${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

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

      const meta: Record<string, unknown> = {};
      if (threadId) {
        meta.thread_id = threadId;
        if (topicName) meta.topic = topicName;
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

      await bctx.saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, meta);

      const [relevantContext, memoryContext, recentMessages, dynProfile, classification] = await Promise.all([
        getRelevantContext(bctx.supabase, transcription),
        getMemoryContext(bctx.supabase),
        getRecentMessages(bctx.supabase),
        bctx.getDynamicProfile(),
        classifyMessage(bctx.supabase, transcription, "user"),
      ]);

      if (classification?.is_memorable) {
        autoRemember(bctx.supabase, transcription, classification).catch(() => {});
      }

      const enrichedPrompt = bctx.buildPrompt(
        `[Voice message transcribed]: ${transcription}`,
        relevantContext,
        memoryContext,
        recentMessages,
        topicName,
        dynProfile,
      );
      const rawResponse = await bctx.callClaude(enrichedPrompt, { resume: true, heartbeat: bctx.heartbeatOpts(ctx) });
      const claudeResponse = await processMemoryIntents(bctx.supabase, rawResponse);

      await bctx.saveMessage("assistant", claudeResponse, meta);
      await bctx.sendVoiceResponse(ctx, claudeResponse);
      bctx.clearError(messageId);
    } catch (error) {
      console.error("Voice error:", error);
      if (!bctx.recordError(messageId)) {
        await ctx.reply("Erreur lors du traitement du vocal. Reessaie.", bctx.threadOpts(ctx)).catch(() => {});
      }
    }
  });

  // Photos/Images
  composer.on("message:photo", async (ctx) => {
    const messageId = ctx.message.message_id;
    const threadId = bctx.getThreadId(ctx);
    const topicName = bctx.getTopicName(ctx);
    console.log(`Image received${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

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

      const timestamp = Date.now();
      const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

      const response = await fetch(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
      );
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer));

      const caption = ctx.message.caption || "Analyze this image.";
      const prompt = `[Image: ${filePath}]\n\n${caption}`;

      await bctx.saveMessage("user", `[Image]: ${caption}`, meta);

      const claudeResponse = await bctx.callClaude(prompt, { resume: true, heartbeat: bctx.heartbeatOpts(ctx) });

      await unlink(filePath).catch(() => {});

      const cleanResponse = await processMemoryIntents(bctx.supabase, claudeResponse);
      await bctx.saveMessage("assistant", cleanResponse, meta);
      await bctx.sendResponse(ctx, cleanResponse);
      bctx.clearError(messageId);
    } catch (error) {
      console.error("Image error:", error);
      if (!bctx.recordError(messageId)) {
        await ctx.reply("Erreur lors du traitement de l'image. Reessaie.", bctx.threadOpts(ctx)).catch(() => {});
      }
    }
  });

  // Documents
  composer.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const messageId = ctx.message.message_id;
    const threadId = bctx.getThreadId(ctx);
    const topicName = bctx.getTopicName(ctx);
    console.log(`Document: ${doc.file_name}${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

    try {
      await ctx.replyWithChatAction("typing");

      const meta: Record<string, unknown> = {};
      if (threadId) {
        meta.thread_id = threadId;
        if (topicName) meta.topic = topicName;
      }

      const file = await ctx.getFile();
      const timestamp = Date.now();
      const fileName = doc.file_name || `file_${timestamp}`;
      const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

      const response = await fetch(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
      );
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer));

      const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
      const prompt = `[File: ${filePath}]\n\n${caption}`;

      await bctx.saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, meta);

      const claudeResponse = await bctx.callClaude(prompt, { resume: true, heartbeat: bctx.heartbeatOpts(ctx) });

      await unlink(filePath).catch(() => {});

      const cleanResponse = await processMemoryIntents(bctx.supabase, claudeResponse);
      await bctx.saveMessage("assistant", cleanResponse, meta);
      await bctx.sendResponse(ctx, cleanResponse);
      bctx.clearError(messageId);
    } catch (error) {
      console.error("Document error:", error);
      if (!bctx.recordError(messageId)) {
        await ctx.reply("Erreur lors du traitement du document. Reessaie.", bctx.threadOpts(ctx)).catch(() => {});
      }
    }
  });

  return composer;
}
