/**
 * @module commands/profile
 * @description Composer for profile & notification commands: /profile, /notify.
 * Includes profile update callback queries (profile_apply, profile_skip).
 */

import { Composer, type Context } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { buildNotifyPrefsKeyboard } from "../inline-menus.ts";
import { formatPrefs, getPrefs, type NotificationType, savePrefs } from "../notification-queue.ts";

export default function profileComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /profile
  composer.command("profile", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "profile");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }

    const profileCtx = bctx.profileContext;
    const response = profileCtx
      ? `Profil charge depuis config/profile.md\n\n${profileCtx.substring(0, 1000)}`
      : "Profil non configure. Edite config/profile.md pour personnaliser.";
    await bctx.sendResponse(ctx, response);
  });

  // /notify
  composer.command("notify", async (ctx) => {
    const args = ctx.match?.trim() || "";

    if (!args || args === "status") {
      const prefs = getPrefs();
      const kb = buildNotifyPrefsKeyboard(prefs);
      await ctx.reply(formatPrefs(prefs), { ...bctx.threadOpts(ctx), reply_markup: kb });
      return;
    }

    const parts = args.split(/\s+/);
    const action = parts[0];

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

    await ctx.reply(
      "Usage: /notify [status|on TYPE|off TYPE|TYPE immediate]",
      bctx.threadOpts(ctx),
    );
  });

  // ── Notify preferences callbacks (notify_ prefix) ────────────
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("notify_")) {
      await next();
      return;
    }

    // Parse callback: notify_{action}:{type}
    const withoutPrefix = data.substring("notify_".length);
    const colonIndex = withoutPrefix.indexOf(":");
    if (colonIndex === -1) {
      await ctx.answerCallbackQuery({ text: "Format invalide." });
      return;
    }

    const action = withoutPrefix.substring(0, colonIndex);
    const type = withoutPrefix.substring(colonIndex + 1) as NotificationType;

    if (!["task", "pr", "idea", "alert"].includes(type)) {
      await ctx.answerCallbackQuery({ text: "Type invalide." });
      return;
    }

    const prefs = getPrefs();

    if (action === "on") {
      prefs.types[type].enabled = true;
      await savePrefs(prefs);
      await ctx.answerCallbackQuery({ text: `${type} active.` });
    } else if (action === "off") {
      prefs.types[type].enabled = false;
      await savePrefs(prefs);
      await ctx.answerCallbackQuery({ text: `${type} desactive.` });
    } else {
      await ctx.answerCallbackQuery({ text: "Action inconnue." });
      return;
    }

    // Update the message with refreshed keyboard
    const updatedPrefs = getPrefs();
    const kb = buildNotifyPrefsKeyboard(updatedPrefs);
    try {
      await ctx.editMessageText(formatPrefs(updatedPrefs), { reply_markup: kb });
    } catch {
      // R5: optional IO -> degrade gracefully
    }
  });

  return composer;
}
