/**
 * @module commands/profile
 * @description Composer for profile & notification commands: /profile, /notify.
 * Includes profile update callback queries (profile_apply, profile_skip).
 */

import { Composer, type Context } from "grammy";
import type { BotContext } from "../bot-context.ts";
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
      await ctx.reply(formatPrefs(prefs), bctx.threadOpts(ctx));
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

  return composer;
}
