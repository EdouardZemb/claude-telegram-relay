/**
 * @module commands/help
 * @description Grammy Composer module handling informational commands:
 * /help, /workflow, /agents, /status, /monitor. These are read-only commands
 * that display bot capabilities, system health, and production monitoring.
 */

import { execSync } from "child_process";
import { Composer, type Context } from "grammy";
import { cpus, freemem, hostname, loadavg, uptime as osUptime, totalmem } from "os";
import { formatMonitoringStats } from "../alerts.ts";
import type { BotContext } from "../bot-context.ts";
import { RELAY_START_TIME } from "../bot-context.ts";
import {
  buildCategoryKeyboard,
  buildMainMenuKeyboard,
  getActionsForCategory,
  MENU_CATEGORIES,
} from "../inline-menus.ts";
import { formatLlmOpsSnapshot, getLlmOpsSnapshot } from "../llm-ops.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("help");
export default function helpCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();
  const { commandGuard, threadOpts, sendResponse, supabase } = bctx;

  // /help — interactive command menu with inline keyboard
  composer.command("help", async (ctx) => {
    const menuText = [
      "COMMANDES",
      "",
      "Choisis une categorie pour voir les commandes disponibles.",
      "Tu peux aussi envoyer un texte ou vocal pour discuter librement.",
    ].join("\n");
    const kb = buildMainMenuKeyboard();
    await ctx.reply(menuText, { ...threadOpts(ctx), reply_markup: kb });
  });

  // ── Menu callback handlers (menu_ prefix) ───────────────────
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("menu_")) {
      await next();
      return;
    }

    await ctx.answerCallbackQuery();

    if (data === "menu_back") {
      // Return to main menu
      const menuText = [
        "COMMANDES",
        "",
        "Choisis une categorie pour voir les commandes disponibles.",
      ].join("\n");
      const kb = buildMainMenuKeyboard();
      try {
        await ctx.editMessageText(menuText, { reply_markup: kb });
      } catch {
        await ctx.reply(menuText, { ...bctx.threadOpts(ctx), reply_markup: kb });
      }
      return;
    }

    if (data.startsWith("menu_cat:")) {
      // Show category sub-menu
      const catId = data.substring("menu_cat:".length);
      const cat = MENU_CATEGORIES.find((c) => c.id === catId);
      if (!cat) return;

      const actions = getActionsForCategory(catId);
      const lines = [`${cat.label}`, "", cat.description, ""];
      for (const a of actions) {
        lines.push(`${a.usage} -- ${a.description}`);
      }

      const kb = buildCategoryKeyboard(catId);
      try {
        await ctx.editMessageText(lines.join("\n"), { reply_markup: kb });
      } catch {
        await ctx.reply(lines.join("\n"), { ...bctx.threadOpts(ctx), reply_markup: kb });
      }
      return;
    }

    if (data.startsWith("menu_cmd:")) {
      // Execute command via synthetic update
      const command = data.substring("menu_cmd:".length);
      try {
        await ctx.editMessageText(`Execution: /${command}`);
      } catch {
        // R5: optional IO -> degrade gracefully
      }
      // Build synthetic update to dispatch command
      const chatId = ctx.chat?.id || 0;
      const userId = ctx.from?.id || 0;
      const threadId = ctx.callbackQuery.message?.message_thread_id;
      const syntheticUpdate = {
        update_id: 0,
        message: {
          message_id: ctx.callbackQuery.message?.message_id || 0,
          from: { id: userId, is_bot: false, first_name: ctx.from?.first_name || "" },
          chat: { id: chatId, type: ctx.chat?.type || "private" },
          date: Math.floor(Date.now() / 1000),
          text: `/${command}`,
          entities: [{ offset: 0, length: command.length + 1, type: "bot_command" }],
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
      };
      await bctx.bot.handleUpdate(syntheticUpdate as never);
      return;
    }

    await next();
  });

  // /workflow — show BMad workflow overview
  composer.command("workflow", async (ctx) => {
    const workflow = [
      "WORKFLOW — Pipeline de Developpement",
      "",
      "Le pipeline SDD (Spec-Driven Development) orchestre les phases :",
      "",
      "1. EXPLORATION (optionnel)",
      "   /explore pour investiguer avant de specifier",
      "",
      "2. SPECIFICATION",
      "   Specification formelle avec V-criteres",
      "",
      "3. CHALLENGE ADVERSARIAL",
      "   3 agents paralleles verifient la spec",
      "",
      "4. IMPLEMENTATION TDD",
      "   Test Architect -> Implementer -> Tester",
      "",
      "5. REVIEW & DOCUMENTATION",
      "   Revue de code + mise a jour docs",
      "",
      "SUIVI",
      "  /retro pour analyser le sprint",
      "  /metrics pour les donnees quantitatives",
    ].join("\n");
    await ctx.reply(workflow, threadOpts(ctx));
  });

  // /status — server health and system info
  composer.command("status", async (ctx) => {
    const blocked = commandGuard(ctx, "status");
    if (blocked) {
      await ctx.reply(blocked, threadOpts(ctx));
      return;
    }
    try {
      const uptimeSec = Math.round((Date.now() - RELAY_START_TIME) / 1000);
      const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
      const memUsed = Math.round((totalmem() - freemem()) / 1024 / 1024);
      const memTotal = Math.round(totalmem() / 1024 / 1024);
      const memPct = Math.round((1 - freemem() / totalmem()) * 100);
      const load = loadavg();

      const parts = [
        `Serveur: ${hostname()}`,
        `Uptime bot: ${uptimeStr}`,
        `Uptime systeme: ${Math.floor(osUptime() / 3600)}h`,
        `CPU: ${cpus().length} cores, load ${load[0].toFixed(1)} / ${load[1].toFixed(1)} / ${load[2].toFixed(1)}`,
        `Memoire: ${memUsed}/${memTotal} MB (${memPct}%)`,
      ];

      // PM2 services
      try {
        const pm2Output = execSync("npx pm2 jlist 2>/dev/null", { timeout: 5000 }).toString();
        const pm2Apps = JSON.parse(pm2Output);
        parts.push("");
        parts.push("Services PM2:");
        for (const app of pm2Apps) {
          const status = app.pm2_env?.status || "unknown";
          const restarts = app.pm2_env?.restart_time || 0;
          const mem = Math.round((app.monit?.memory || 0) / 1024 / 1024);
          parts.push(`  ${app.name}: ${status} (${mem}MB, ${restarts} restarts)`);
        }
      } catch {
        // R8: business error → log.warn
        log.warn("status: pm2 list unavailable");
      }

      // Message count today
      if (supabase) {
        const today = new Date().toISOString().split("T")[0];
        const { count } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .gte("created_at", today);
        parts.push("");
        parts.push(`Messages aujourd'hui: ${count ?? 0}`);
      }

      await sendResponse(ctx, parts.join("\n"));
    } catch (error) {
      log.error("Status error", { error: String(error) });
      await ctx.reply("Erreur lors de la recuperation du statut.", threadOpts(ctx));
    }
  });

  // /monitor — production monitoring stats
  composer.command("monitor", async (ctx) => {
    const blocked = commandGuard(ctx, "monitor");
    if (blocked) {
      await ctx.reply(blocked, threadOpts(ctx));
      return;
    }

    const parts = [formatMonitoringStats()];

    // LLM-Ops monitoring snapshot
    if (supabase) {
      try {
        const llmOpsSnapshot = await getLlmOpsSnapshot(supabase);
        parts.push("", formatLlmOpsSnapshot(llmOpsSnapshot));
      } catch {
        // R8: business error → log.warn
        log.warn("monitor: llm-ops snapshot unavailable");
      }
    }

    await ctx.reply(parts.join("\n"), threadOpts(ctx));
  });

  return composer;
}
