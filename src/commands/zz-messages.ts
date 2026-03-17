/**
 * @module commands/zz-messages
 * @description Composer for generic message handlers: text, voice, photo, document.
 * Prefixed with "zz-" to ensure it loads after all command handlers.
 * S37: Integrates intent detection -> command routing -> confirmation -> fallback conversation.
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
import { isFeatureEnabled } from "../feature-flags.ts";
import { detectIntent, detectIntentWithLLM, formatIntentSuggestion } from "../intent-detection.ts";
import { routeIntent, checkPendingClarification, handleConfirmationCallback } from "../command-router.ts";
import { formatActionsForLLM } from "../action-registry.ts";
import {
  getSession,
  addMessage as addSessionMessage,
  addIntent as addSessionIntent,
  extractConstraints,
  addConstraint,
  formatSessionForIntent,
  cleanupExpiredSessions,
  hasActiveSession,
} from "../conversation-session.ts";

export default function messagesComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // ── Intent confirmation callbacks (S37-04) ─────────────────
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("intent_")) { await next(); return; }

    const command = handleConfirmationCallback(ctx, data);
    if (command) {
      await ctx.answerCallbackQuery({ text: "Execution..." });
      await ctx.editMessageText(`Execution : ${command}`);
      // Send the resolved command as a message for Grammy to route
      const chatId = ctx.callbackQuery.message?.chat?.id;
      const threadId = (ctx.callbackQuery.message as any)?.message_thread_id;
      if (chatId) {
        const opts: Record<string, unknown> = {};
        if (threadId) opts.message_thread_id = threadId;
        await bctx.bot.api.sendMessage(chatId, command, opts);
      }
    } else if (data === "intent_cancel") {
      await ctx.answerCallbackQuery({ text: "Annule." });
      await ctx.editMessageText("Action annulee.");
    } else {
      await ctx.answerCallbackQuery({ text: "Action expiree." });
    }
  });

  // ── Text messages ──────────────────────────────────────────
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

      // S43: Track conversation session
      const chatId = ctx.chat?.id || 0;
      let session: ReturnType<typeof getSession> | undefined;
      if (isFeatureEnabled("conversation_sessions")) {
        session = getSession(chatId, threadId);
        addSessionMessage(session, text);

        // Extract user constraints from the message
        const constraints = extractConstraints(text);
        for (const c of constraints) {
          addConstraint(session, c.type, c.value, c.source);
        }
      }

      // S37: Check if this is a response to a pending clarification
      if (isFeatureEnabled("intent_detection")) {
        const clarificationCmd = checkPendingClarification(ctx, text);
        if (clarificationCmd) {
          // Send the resolved command for Grammy to route
          const chatId = ctx.chat?.id;
          if (chatId) {
            const opts: Record<string, unknown> = {};
            if (threadId) opts.message_thread_id = threadId;
            await bctx.bot.api.sendMessage(chatId, clarificationCmd, opts);
          }
          return;
        }
      }

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

      // S37: Intent detection + routing (behind feature flag)
      if (isFeatureEnabled("intent_detection")) {
        // Two-tier: regex fast path, then LLM fallback for ambiguous
        const regexResult = detectIntent(text);

        if (regexResult.detected && regexResult.detected.confidence >= 0.8) {
          // High-confidence regex match — route to command
          if (session) addSessionIntent(session, regexResult.detected.intent, regexResult.detected.command, regexResult.detected.confidence, true);
          const routeResult = await routeIntent(ctx, regexResult.detected, {
            supabase: bctx.supabase,
            getThreadId: bctx.getThreadId,
            threadOpts: bctx.threadOpts,
          });
          if (routeResult.handled) return;
        } else if (isFeatureEnabled("llm_router")) {
          // LLM fallback for ambiguous messages — S43: with session context
          const sessionCtx = session ? formatSessionForIntent(session) : undefined;
          const llmResult = await detectIntentWithLLM(text, {
            callLLM: (prompt) => bctx.callClaude(prompt),
            recentMessages,
            timeoutMs: 5000,
            sessionContext: sessionCtx,
          });
          if (llmResult.detected && llmResult.detected.confidence >= 0.8) {
            if (session) addSessionIntent(session, llmResult.detected.intent, llmResult.detected.command, llmResult.detected.confidence, true);
            const routeResult = await routeIntent(ctx, llmResult.detected, {
              supabase: bctx.supabase,
              getThreadId: bctx.getThreadId,
              threadOpts: bctx.threadOpts,
            });
            if (routeResult.handled) return;
          }
        } else if (regexResult.detected) {
          // Medium-confidence regex — just suggest (original behavior)
          const suggestion = formatIntentSuggestion(regexResult);
          if (suggestion) {
            await ctx.reply(suggestion, bctx.threadOpts(ctx));
          }
        }
      }

      // S37-07: Conversation fallback with action awareness
      const actionContext = isFeatureEnabled("intent_detection")
        ? `\nACTIONS DISPONIBLES (tu peux orienter l'utilisateur vers ces commandes si pertinent):\n${formatActionsForLLM()}`
        : "";

      const enrichedPrompt = bctx.buildPrompt(text, relevantContext, memoryContext + actionContext, recentMessages, topicName, dynProfile);
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
