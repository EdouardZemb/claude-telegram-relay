/**
 * @module relay
 * @description Main bot entrypoint. Creates the bot, loads Composer modules from
 * src/commands/, and handles startup/shutdown. All commands and message handlers
 * are registered via Composers — see src/commands/*.ts.
 */

/**
 * Claude Code Telegram Relay
 *
 * Modular relay that connects Telegram to Claude Code CLI.
 * Commands live in src/commands/*.ts as Grammy Composers.
 *
 * Run: bun run src/relay.ts
 */

import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { Bot } from "grammy";
import { join } from "path";
import {
  ALLOWED_USER_ID,
  BOT_TOKEN,
  type BotContext,
  clearStaleState,
  createBotContext,
  GROUP_ID,
  isRateLimited,
  PROJECT_DIR,
  RELAY_DIR,
  TEMP_DIR,
  UPLOADS_DIR,
} from "./bot-context.ts";
import { initJobManager } from "./job-manager.ts";
import { loadComposers } from "./loader.ts";
import { createLogger } from "./logger.ts";
import { startQueue } from "./notification-queue.ts";
import { initPipelineTracker } from "./pipeline-tracker.ts";

const log = createLogger("relay");

// ============================================================
// LOCK FILE
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function writePidFile(): Promise<void> {
  await writeFile(LOCK_FILE, process.pid.toString());
  log.info(`PID file written (${process.pid})`);
}

async function removePidFile(): Promise<void> {
  try {
    const content = await readFile(LOCK_FILE, "utf-8").catch(() => "");
    if (content.trim() === process.pid.toString()) {
      await unlink(LOCK_FILE).catch(() => {});
    }
  } catch {} // R6: optional IO → degrade gracefully
}

// ============================================================
// BOT FACTORY
// ============================================================

// Module-level reference for E2E and main
let _bctx: BotContext | null = null;

export async function createBot(token: string): Promise<Bot> {
  const bot = new Bot(token);

  // Security middleware: only authorized user, rate limiting
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();

    if (ctx.chat && ctx.chat.type !== "private") {
      log.info(`Group message: chat_id=${chatId} from=${userId}`);
    }

    if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
      log.warn(`Unauthorized: ${userId}`);
      if (ctx.chat?.type === "private") {
        await ctx.reply("This bot is private.");
      }
      return;
    }

    if (ctx.chat && ctx.chat.type !== "private" && GROUP_ID && chatId !== GROUP_ID) {
      log.info(`Ignored group: ${chatId}`);
      return;
    }

    if (isRateLimited()) {
      await ctx.reply("Trop de messages. Attends un peu avant de renvoyer.");
      return;
    }

    await next();
  });

  // Create shared context and load all Composers
  _bctx = await createBotContext(bot);
  await loadComposers(bot, _bctx);

  // Global error handler
  bot.catch(async (err) => {
    log.error(`Bot error: ${err}`);
    if (ALLOWED_USER_ID) {
      try {
        const errorMsg = `Erreur critique du bot:\n${String(err.error || err).substring(0, 500)}`;
        await bot.api.sendMessage(parseInt(ALLOWED_USER_ID, 10), errorMsg);
      } catch {
        // R7: optional feature → skip
      }
    }
  });

  return bot;
}

// ============================================================
// MAIN (only runs when executed directly, not when imported)
// ============================================================

if (import.meta.main) {
  if (!BOT_TOKEN) {
    log.error("TELEGRAM_BOT_TOKEN not set!");
    log.info("To set up:");
    log.info("1. Message @BotFather on Telegram");
    log.info("2. Create a new bot with /newbot");
    log.info("3. Copy the token to .env");
    process.exit(1);
  }

  // Create directories
  await mkdir(TEMP_DIR, { recursive: true });
  await mkdir(UPLOADS_DIR, { recursive: true });

  // Write PID file
  await writePidFile();

  // Create and configure bot
  const mainBot = await createBot(BOT_TOKEN);
  await startQueue(mainBot);
  initJobManager(mainBot);
  await initPipelineTracker();

  // Graceful shutdown
  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down gracefully...`);
    try {
      mainBot?.stop();
    } catch {} // R6: optional IO → degrade gracefully
    await removePidFile();
    process.exit(0);
  }

  process.on("exit", () => {
    try {
      const fs = require("fs");
      const content = fs.readFileSync(LOCK_FILE, "utf-8").trim();
      if (content === process.pid.toString()) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch {} // R6: optional IO → degrade gracefully
  });
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // Periodic cleanup of stale rate limit and error state
  setInterval(clearStaleState, 300_000);

  // Reminder scheduler
  setInterval(async () => {
    if (!_bctx) return;
    const now = Date.now();
    const due = _bctx.reminders.filter((r) => r.triggerAt <= now);
    if (due.length === 0) return;

    for (const r of due) {
      try {
        const opts: Record<string, unknown> = {};
        if (r.threadId) opts.message_thread_id = r.threadId;
        await mainBot.api.sendMessage(r.chatId, `Rappel: ${r.text}`, opts);
      } catch (error) {
        log.error(`Reminder send error: ${error}`);
      }
    }

    // Remove fired reminders
    const remaining = _bctx.reminders.filter((r) => r.triggerAt > now);
    _bctx.reminders.length = 0;
    _bctx.reminders.push(...remaining);
    await _bctx.saveReminders();
  }, 30_000);

  // Catch uncaught exceptions and notify
  process.on("uncaughtException", async (error) => {
    log.error(`Uncaught exception: ${error}`);
    if (ALLOWED_USER_ID) {
      try {
        await mainBot.api.sendMessage(
          parseInt(ALLOWED_USER_ID, 10),
          `Exception non geree dans le relay:\n${String(error).substring(0, 500)}\n\nLe bot va redemarrer via PM2.`,
        );
      } catch {} // R7: optional feature → skip
    }
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    log.error(`Unhandled rejection: ${reason}`);
    if (ALLOWED_USER_ID) {
      try {
        await mainBot.api.sendMessage(
          parseInt(ALLOWED_USER_ID, 10),
          `Rejection non geree:\n${String(reason).substring(0, 500)}`,
        );
      } catch {} // R7: optional feature → skip
    }
  });

  // Start
  log.info("Starting Claude Telegram Relay...");
  log.info(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
  log.info(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

  await mainBot.api.deleteWebhook({ drop_pending_updates: true });

  mainBot.start({
    drop_pending_updates: true,
    onStart: () => {
      log.info("Bot is running! (pending updates dropped)");
    },
  });
}
