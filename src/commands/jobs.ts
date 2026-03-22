/**
 * @module commands/jobs
 * @description Grammy Composer for /jobs command: list running and recent background jobs,
 * cancel a running job. Part of S46 background job system.
 */

import { Composer, type Context } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { cancel, formatJobList, get, isJobManagerEnabled, list } from "../job-manager.ts";
import { createLogger } from "../logger.ts";
import { formatPRDDetail, getPRD } from "../prd.ts";
import { getBacklog, getCurrentSprint, updateTaskStatus } from "../tasks.ts";

const log = createLogger("jobs");
export default function jobsCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  composer.command("jobs", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "jobs");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }

    if (!isJobManagerEnabled()) {
      await ctx.reply(
        "Le job manager n'est pas actif. Utilise /feature enable job_manager pour l'activer.",
        bctx.threadOpts(ctx),
      );
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
        await ctx.reply(
          `Job ${job.id} (${job.type}) est deja termine (${job.status}).`,
          bctx.threadOpts(ctx),
        );
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

    // job_ prefix: existing status check
    if (data.startsWith("job_")) {
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
      return;
    }

    // jc_ prefix: job completion action buttons
    if (!data.startsWith("jc_")) {
      await next();
      return;
    }

    const [action, param] = data.split(":");

    if (action === "jc_done" && param && bctx.supabase) {
      // Mark task as done
      const { data: tasks } = await bctx.supabase
        .from("tasks")
        .select("id, title")
        .ilike("id", `${param}%`)
        .limit(1);
      const task = tasks?.[0];
      if (task) {
        await updateTaskStatus(bctx.supabase, task.id, "done");
        await ctx.answerCallbackQuery({ text: `Tache "${task.title}" terminee !` });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } else {
        await ctx.answerCallbackQuery({ text: "Tache introuvable." });
      }
      return;
    }

    if (action === "jc_backlog" && bctx.supabase) {
      const sprint = await getCurrentSprint(bctx.supabase);
      const backlog = await getBacklog(bctx.supabase, sprint ? { sprint } : undefined);
      if (backlog.length === 0) {
        await ctx.answerCallbackQuery({ text: "Backlog vide." });
      } else {
        await ctx.answerCallbackQuery();
        const lines = backlog
          .slice(0, 10)
          .map(
            (t: any, i: number) =>
              `${i + 1}. P${t.priority} ${t.title} [${t.id.substring(0, 8)}] (${t.status})`,
          );
        const text = `Backlog (${backlog.length} taches):\n\n${lines.join("\n")}`;
        await ctx.reply(text, bctx.threadOpts(ctx));
      }
      return;
    }

    if (action === "jc_prd" && param && bctx.supabase) {
      let callbackAnswered = false;
      try {
        const prd = await getPRD(bctx.supabase, param);
        if (prd) {
          await ctx.answerCallbackQuery();
          callbackAnswered = true;
          const detail = formatPRDDetail(prd);
          const shortId = prd.id.substring(0, 8);

          // Truncate if too long for Telegram (4096 char limit)
          const MAX_DISPLAY = 3800;
          const displayText =
            detail.length > MAX_DISPLAY
              ? detail.substring(0, MAX_DISPLAY) +
                `\n\n... (tronque, utilise /prd ${shortId} pour le texte complet)`
              : detail;

          // Add action buttons for draft PRDs (same as /prd command)
          if (prd.status === "draft") {
            const { InlineKeyboard } = await import("grammy");
            const keyboard = new InlineKeyboard()
              .text("Approuver", `prd_approve:${prd.id}`)
              .text("Rejeter", `prd_reject:${prd.id}`)
              .row()
              .text("Modifier", `prd_revise:${prd.id}`);
            await ctx.reply(displayText, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
          } else {
            await ctx.reply(displayText, bctx.threadOpts(ctx));
          }
        } else {
          await ctx.answerCallbackQuery({ text: "PRD introuvable." });
          callbackAnswered = true;
        }
      } catch (err) {
        log.error("[jobs] jc_prd callback error", { error: String(err) });
        if (!callbackAnswered) {
          try {
            await ctx.answerCallbackQuery({ text: "Erreur lors de l'affichage du PRD." });
          } catch {
            /* already answered */
          }
        }
      }
      return;
    }

    if (action === "jc_task_from_explore") {
      await ctx.answerCallbackQuery({ text: "Utilise /task <titre> pour creer une tache." });
      return;
    }

    await next();
  });

  return composer;
}
