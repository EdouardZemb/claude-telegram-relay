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

import { Bot } from "grammy";
import { mkdir } from "fs/promises";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";
import {
  BOT_TOKEN,
  ALLOWED_USER_ID,
  GROUP_ID,
  RELAY_DIR,
  TEMP_DIR,
  UPLOADS_DIR,
  PROJECT_DIR,
  isRateLimited,
  clearStaleState,
  supabase,
  createBotContext,
  type BotContext,
} from "./bot-context.ts";
import { loadComposers } from "./loader.ts";
import { startQueue } from "./notification-queue.ts";
import { initJobManager } from "./job-manager.ts";
import { loadFeedbackRules } from "./feedback-loop.ts";
import { loadPrefs } from "./notification-prefs.ts";

// ============================================================
// LOCK FILE
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function writePidFile(): Promise<void> {
  await writeFile(LOCK_FILE, process.pid.toString());
  console.log(`PID file written (${process.pid})`);
}

async function removePidFile(): Promise<void> {
  try {
    const content = await readFile(LOCK_FILE, "utf-8").catch(() => "");
    if (content.trim() === process.pid.toString()) {
      await unlink(LOCK_FILE).catch(() => {});
    }
  } catch {}
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
      console.log(`Group message: chat_id=${chatId} from=${userId}`);
    }

    if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
      console.log(`Unauthorized: ${userId}`);
      if (ctx.chat?.type === "private") {
        await ctx.reply("This bot is private.");
      }
      return;
    }

    if (ctx.chat && ctx.chat.type !== "private" && GROUP_ID && chatId !== GROUP_ID) {
      console.log(`Ignored group: ${chatId}`);
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
    console.error("Bot error:", err);
    if (ALLOWED_USER_ID) {
      try {
        const errorMsg = `Erreur critique du bot:\n${String(err.error || err).substring(0, 500)}`;
        await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), errorMsg);
      } catch {
        // Can't notify — just log
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
    console.error("TELEGRAM_BOT_TOKEN not set!");
    console.log("\nTo set up:");
    console.log("1. Message @BotFather on Telegram");
    console.log("2. Create a new bot with /newbot");
    console.log("3. Copy the token to .env");
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
  await loadPrefs();

  // Graceful shutdown
  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down gracefully...`);
    try { mainBot?.stop(); } catch {}
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
    } catch {}
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
        console.error("Reminder send error:", error);
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
    console.error("Uncaught exception:", error);
    if (ALLOWED_USER_ID) {
      try {
        await mainBot.api.sendMessage(
          parseInt(ALLOWED_USER_ID),
          `Exception non geree dans le relay:\n${String(error).substring(0, 500)}\n\nLe bot va redemarrer via PM2.`,
        );
      } catch {}
    }
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("Unhandled rejection:", reason);
    if (ALLOWED_USER_ID) {
      try {
        await mainBot.api.sendMessage(
          parseInt(ALLOWED_USER_ID),
          `Rejection non geree:\n${String(reason).substring(0, 500)}`,
        );
      } catch {}
    }
  });

  // Start
  console.log("Starting Claude Telegram Relay...");
  console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
  console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

  if (supabase) {
    loadFeedbackRules(supabase).then((rules) => {
      console.log(`Loaded ${rules.length} feedback rules (${rules.filter(r => r.active).length} active)`);
    }).catch((e) => console.error("Failed to load feedback rules:", e));
  }

  await mainBot.api.deleteWebhook({ drop_pending_updates: true });

  mainBot.start({
    drop_pending_updates: true,
    onStart: () => {
      console.log("Bot is running! (pending updates dropped)");
    },
  });
}
