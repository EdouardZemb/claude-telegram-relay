/**
 * @module commands/jobs
 * @description Grammy Composer for /jobs command: list running and recent background jobs,
 * cancel a running job. Part of S46 background job system.
 */

import { Composer, Context } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { list, get, cancel, formatJobList, isJobManagerEnabled } from "../job-manager.ts";

export default function jobsCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  composer.command("jobs", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "jobs");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }

    if (!isJobManagerEnabled()) {
      await ctx.reply("Le job manager n'est pas actif. Utilise /feature enable job_manager pour l'activer.", bctx.threadOpts(ctx));
      return;
    }

    const input = ctx.match?.trim() || "";
    const parts = input.split(/\s+/);
    const sub = parts[0]?.toLowerCase();

    // /jobs cancel <id>
    if (sub === "cancel" && parts[1]) {
      const job = await cancel(parts[1]);
      if (!job) {
        await ctx.reply(`Aucun job trouve avec l'ID "${parts[1]}".`, bctx.threadOpts(ctx));
        return;
      }
      if (job.error === "cancelled") {
        await ctx.reply(`Job ${job.id} (${job.type}) annule.`, bctx.threadOpts(ctx));
      } else {
        await ctx.reply(`Job ${job.id} (${job.type}) est deja termine (${job.status}).`, bctx.threadOpts(ctx));
      }
      return;
    }

    // /jobs <id> — show single job detail
    if (sub && sub !== "list" && sub.length >= 4) {
      const job = await get(sub);
      if (job) {
        const lines = [
          `Job ${job.id}`,
          `Type: ${job.type}`,
          `Statut: ${job.status}`,
          `Demarre: ${job.startedAt}`,
        ];
        if (job.taskId) lines.push(`Tache: ${job.taskId.substring(0, 8)}`);
        if (job.completedAt) lines.push(`Termine: ${job.completedAt}`);
        if (job.result) lines.push(`Resultat: ${job.result}`);
        if (job.error) lines.push(`Erreur: ${job.error}`);
        await ctx.reply(lines.join("\n"), bctx.threadOpts(ctx));
        return;
      }
    }

    // /jobs — list all
    const { running, recent } = await list();
    await ctx.reply(formatJobList(running, recent), bctx.threadOpts(ctx));
  });

  // Callback query for job status check from inline buttons
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("job_")) { await next(); return; }

    const [action, jobId] = data.split(":");
    if (action === "job_status" && jobId) {
      const job = await get(jobId);
      if (job) {
        await ctx.answerCallbackQuery({
          text: `${job.type}: ${job.status}${job.result ? " — " + job.result.substring(0, 100) : ""}`,
          show_alert: true,
        });
      } else {
        await ctx.answerCallbackQuery({ text: "Job introuvable." });
      }
    } else {
      await next();
    }
  });

  return composer;
}
