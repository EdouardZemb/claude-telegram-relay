/**
 * @module commands/profile
 * @description Composer for profile & notification commands: /profile, /notify.
 * Includes profile update callback queries (profile_apply, profile_skip).
 */

import { Composer, type Context, InlineKeyboard } from "grammy";
import type { BotContext } from "../bot-context.ts";
import {
  analyzeProfile,
  proposeProfileUpdates,
  applyProfileUpdates,
  formatProfileInsights,
  formatProfileUpdates,
} from "../profile-evolution.ts";
import {
  getPrefs,
  savePrefs,
  formatPrefs,
  type NotificationType,
} from "../notification-prefs.ts";

export default function profileComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /profile
  composer.command("profile", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "profile");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    await ctx.replyWithChatAction("typing");
    const insights = await analyzeProfile(bctx.supabase);
    const updates = proposeProfileUpdates(insights, bctx.profileContext);

    let response = formatProfileInsights(insights);
    if (updates.length > 0) {
      response += "\n\n" + formatProfileUpdates(updates);

      const keyboard = new InlineKeyboard()
        .text("Appliquer les mises a jour", `profile_apply`)
        .row()
        .text("Ignorer", `profile_skip`);
      await bctx.sendResponse(ctx, response);
      await ctx.reply("Appliquer ces modifications au profil ?", { ...bctx.threadOpts(ctx), reply_markup: keyboard });
    } else {
      await bctx.sendResponse(ctx, response);
    }
  });

  // /notify
  composer.command("notify", async (ctx) => {
    const args = ctx.match?.trim() || "";

    if (!args || args === "status") {
      const prefs = getPrefs();
      await ctx.reply(formatPrefs(prefs), bctx.threadOpts(ctx));
      return;
    }

    const parts = args.split(/\s+/);
    const action = parts[0];

    if (action === "quiet" && parts[1]) {
      const match = parts[1].match(/^(\d{1,2})h?-(\d{1,2})h?$/);
      if (!match) {
        await ctx.reply("Format: /notify quiet 22h-8h", bctx.threadOpts(ctx));
        return;
      }
      const prefs = getPrefs();
      prefs.quietStart = parseInt(match[1]);
      prefs.quietEnd = parseInt(match[2]);
      await savePrefs(prefs);
      await ctx.reply(`Quiet hours : ${prefs.quietStart}h - ${prefs.quietEnd}h`, bctx.threadOpts(ctx));
      return;
    }

    if (action === "off" && parts[1]) {
      const type = parts[1] as NotificationType;
      if (!["task", "pr", "idea", "alert"].includes(type)) {
        await ctx.reply("Types valides : task, pr, idea, alert", bctx.threadOpts(ctx));
        return;
      }
      const prefs = getPrefs();
      prefs.types[type].enabled = false;
      await savePrefs(prefs);
      await ctx.reply(`Notifications ${type} desactivees.`, bctx.threadOpts(ctx));
      return;
    }

    if (action === "on" && parts[1]) {
      const type = parts[1] as NotificationType;
      if (!["task", "pr", "idea", "alert"].includes(type)) {
        await ctx.reply("Types valides : task, pr, idea, alert", bctx.threadOpts(ctx));
        return;
      }
      const prefs = getPrefs();
      prefs.types[type].enabled = true;
      await savePrefs(prefs);
      await ctx.reply(`Notifications ${type} activees.`, bctx.threadOpts(ctx));
      return;
    }

    if (parts[1] === "immediate" || action === "immediate") {
      const resolvedType = ["task", "pr", "idea", "alert"].includes(action)
        ? (action as NotificationType)
        : (parts[1] as NotificationType);
      if (!["task", "pr", "idea", "alert"].includes(resolvedType)) {
        await ctx.reply("Types valides : task, pr, idea, alert", bctx.threadOpts(ctx));
        return;
      }
      const prefs = getPrefs();
      prefs.types[resolvedType].immediate = true;
      await savePrefs(prefs);
      await ctx.reply(`Notifications ${resolvedType} en mode immediat.`, bctx.threadOpts(ctx));
      return;
    }

    if (parts[1] === "batch" || action === "batch") {
      const resolvedType = ["task", "pr", "idea", "alert"].includes(action)
        ? (action as NotificationType)
        : (parts[1] as NotificationType);
      if (!["task", "pr", "idea", "alert"].includes(resolvedType)) {
        await ctx.reply("Types valides : task, pr, idea, alert", bctx.threadOpts(ctx));
        return;
      }
      const prefs = getPrefs();
      prefs.types[resolvedType].immediate = false;
      await savePrefs(prefs);
      await ctx.reply(`Notifications ${resolvedType} en mode batch.`, bctx.threadOpts(ctx));
      return;
    }

    await ctx.reply("Usage: /notify [status|quiet Xh-Yh|on TYPE|off TYPE|TYPE immediate|TYPE batch]", bctx.threadOpts(ctx));
  });

  // Profile update callbacks
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("profile_")) { await next(); return; }

    if (data === "profile_apply") {
      if (!bctx.supabase) {
        await ctx.answerCallbackQuery({ text: "Supabase non configure." });
        return;
      }
      const insights = await analyzeProfile(bctx.supabase);
      const updates = proposeProfileUpdates(insights, bctx.profileContext);
      if (updates.length > 0) {
        const applied = applyProfileUpdates(updates);
        if (applied) {
          await bctx.reloadProfile();
          await ctx.answerCallbackQuery({ text: "Profil mis a jour !" });
          await ctx.editMessageText("Profil mis a jour avec succes.");
        } else {
          await ctx.answerCallbackQuery({ text: "Erreur lors de la mise a jour." });
        }
      } else {
        await ctx.answerCallbackQuery({ text: "Aucune mise a jour a appliquer." });
      }
    } else if (data === "profile_skip") {
      await ctx.answerCallbackQuery({ text: "Modifications ignorees." });
      await ctx.editMessageText("Modifications du profil ignorees.");
    }
  });

  return composer;
}
