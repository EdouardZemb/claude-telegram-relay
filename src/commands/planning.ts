/**
 * @module commands/planning
 * @description Grammy Composer module for planning commands:
 * /plan (decompose request into subtasks), /prd (PRD management),
 * /planify (proactive backlog analysis). Also handles PRD-related
 * callback queries (prd_approve, prd_reject, prd_revise).
 */

import { Composer, Context, InlineKeyboard } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { decomposeTask } from "../agent.ts";
import { addTask, getCurrentSprint } from "../tasks.ts";
import { buildStoryFile, enrichTaskWithStory } from "../story-files.ts";
import {
  generatePRD,
  savePRD,
  getPRD,
  getPRDs,
  updatePRDStatus,
  formatPRDList,
  formatPRDDetail,
} from "../prd.ts";
import { WorkflowTracker } from "../workflow.ts";
import { resolveProjectContext } from "../projects.ts";
import { shardDocument } from "../document-sharding.ts";
import {
  analyzeBacklog as analyzeBacklogProactive,
  formatPlannerResult as formatPlannerResultTg,
} from "../proactive-planner.ts";
import { launch as launchJob, isJobManagerEnabled } from "../job-manager.ts";

export default function planningCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /plan — decompose a request into subtasks
  composer.command("plan", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "plan");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const request = ctx.match?.trim();
    if (!request) {
      await ctx.reply("Usage: /plan description de ce que tu veux realiser", bctx.threadOpts(ctx));
      return;
    }

    // Resolve project context
    const currentProject = await resolveProjectContext(bctx.supabase, ctx.message?.message_thread_id);
    const projectSlug = currentProject?.slug || "telegram-relay";

    // ── Plan function (shared between sync/async) ──────────────
    const planFn = async (): Promise<string> => {
      const currentSprint = currentProject?.current_sprint || await getCurrentSprint(bctx.supabase!);
      const tracker = new WorkflowTracker(bctx.supabase!, {
        sprintId: currentSprint || undefined,
        startStep: "request",
      });
      await tracker.transition("decomposition", { agent_notes: `Plan demande: ${request.substring(0, 100)}` });

      const subtasks = await decomposeTask(request);

      if (subtasks.length === 0) {
        await tracker.logCheckpoint("fail", "Aucune sous-tache generee");
        throw new Error("Impossible de decomposer cette demande. Reformule ou ajoute plus de details.");
      }

      await tracker.logCheckpoint("pass", `${subtasks.length} sous-taches generees`);
      await tracker.transition("validation", { agent_notes: `${subtasks.length} sous-taches proposees` });

      const added = [];
      for (const st of subtasks) {
        const task = await addTask(bctx.supabase!, st.title, {
          description: st.description,
          priority: st.priority,
          project: projectSlug,
          project_id: currentProject?.id,
        });
        if (task) {
          if (st.acceptance_criteria) {
            await bctx.supabase!.from("tasks").update({
              acceptance_criteria: st.acceptance_criteria,
            }).eq("id", task.id);
            task.acceptance_criteria = st.acceptance_criteria;
          }
          const story = buildStoryFile(task);
          await enrichTaskWithStory(bctx.supabase!, task.id, story);
          added.push(task);
        }
      }

      const lines = added.map((t, i) => {
        const acCount = (t.acceptance_criteria || "").split("\n").filter((l: string) => l.trim()).length;
        return `${i + 1}. P${t.priority} ${t.title} [${t.id.substring(0, 8)}]${acCount > 0 ? ` (${acCount} ACs)` : ""}`;
      });
      return `${added.length} taches ajoutees au backlog avec story files:\n\n${lines.join("\n")}\n\nUtilise /exec <id> pour lancer l'execution d'une tache.`;
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const jobId = await launchJob("plan", chatId, planFn);
      await ctx.reply(`Job lance plan (id: ${jobId})\nRequete: ${request.substring(0, 100)}`, bctx.threadOpts(ctx));
    } else {
      await ctx.reply("Decomposition en cours...", bctx.threadOpts(ctx));
      try {
        const resultMsg = await planFn();
        await bctx.sendResponse(ctx, resultMsg);
      } catch (error: any) {
        await ctx.reply(error.message || "Erreur lors de la decomposition.", bctx.threadOpts(ctx));
      }
    }
  });

  // /prd — generate a PRD from a description, or list existing PRDs
  composer.command("prd", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "prd");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const input = ctx.match?.trim();

    // Resolve project context
    const currentProject = await resolveProjectContext(bctx.supabase, ctx.message?.message_thread_id);
    const projectSlug = currentProject?.slug || "telegram-relay";

    // /prd without args → list PRDs for current project
    if (!input) {
      const prds = await getPRDs(bctx.supabase, { project: projectSlug });
      await bctx.sendResponse(ctx, formatPRDList(prds));
      return;
    }

    // /prd <id> (8 chars or less, looks like a UUID prefix) → show detail
    if (input.length <= 8 && /^[a-f0-9]+$/.test(input)) {
      const prd = await getPRD(bctx.supabase, input);
      if (!prd) {
        await ctx.reply(`Aucun PRD trouve avec l'ID "${input}".`, bctx.threadOpts(ctx));
        return;
      }
      const detail = formatPRDDetail(prd);
      // Send with validation buttons if still draft
      if (prd.status === "draft") {
        const keyboard = new InlineKeyboard()
          .text("Approuver", `prd_approve:${prd.id}`)
          .text("Rejeter", `prd_reject:${prd.id}`)
          .row()
          .text("Modifier", `prd_revise:${prd.id}`);
        // Split if too long for a single message with keyboard
        if (detail.length > 4000) {
          await bctx.sendResponse(ctx, detail);
          await ctx.reply("Actions:", { ...bctx.threadOpts(ctx), reply_markup: keyboard });
        } else {
          await ctx.reply(detail, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
        }
      } else {
        await bctx.sendResponse(ctx, detail);
      }
      return;
    }

    // /prd <description> → generate new PRD
    const prdCreateFn = async (): Promise<string> => {
      const generated = await generatePRD(input!, projectSlug);
      if (!generated) {
        throw new Error("Impossible de generer le PRD. Reformule ou ajoute plus de details.");
      }

      const prd = await savePRD(bctx.supabase!, generated, {
        project: projectSlug,
        requested_by: ctx.from?.first_name || "unknown",
      });

      if (!prd) {
        throw new Error("Erreur lors de la sauvegarde du PRD.");
      }

      const currentProjectForShard = await resolveProjectContext(bctx.supabase!, ctx.message?.message_thread_id);
      await shardDocument(bctx.supabase!, {
        id: prd.id,
        title: prd.title,
        content: prd.content,
        type: "prd",
        project_id: currentProjectForShard?.id,
      });

      return `PRD_CREATED:${prd.id}`;
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const jobId = await launchJob("prd", chatId, prdCreateFn);
      await ctx.reply(`Job lance prd (id: ${jobId})\nDescription: ${input!.substring(0, 100)}`, bctx.threadOpts(ctx));
    } else {
      await ctx.reply("Generation du PRD en cours...", bctx.threadOpts(ctx));
      try {
        const resultTag = await prdCreateFn();
        const prdId = resultTag.replace("PRD_CREATED:", "");
        const prd = await getPRD(bctx.supabase!, prdId);
        if (prd) {
          const detail = formatPRDDetail(prd);
          const keyboard = new InlineKeyboard()
            .text("Approuver", `prd_approve:${prd.id}`)
            .text("Rejeter", `prd_reject:${prd.id}`)
            .row()
            .text("Modifier", `prd_revise:${prd.id}`);
          if (detail.length > 4000) {
            await bctx.sendResponse(ctx, detail);
            await ctx.reply("Actions:", { ...bctx.threadOpts(ctx), reply_markup: keyboard });
          } else {
            await ctx.reply(detail, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
          }
        }
      } catch (error: any) {
        await ctx.reply(error.message || "Erreur lors de la generation du PRD.", bctx.threadOpts(ctx));
      }
    }
  });

  // /planify — proactive backlog analysis and reordering
  composer.command("planify", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "planify");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const arg = ctx.match?.trim();
    const sprintId = arg || await getCurrentSprint(bctx.supabase) || undefined;

    const planifyFn = async (): Promise<string> => {
      const result = await analyzeBacklogProactive(bctx.supabase!, sprintId);
      return formatPlannerResultTg(result);
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const jobId = await launchJob("planify", chatId, planifyFn);
      await ctx.reply(`Job lance planify (id: ${jobId})`, bctx.threadOpts(ctx));
    } else {
      await ctx.replyWithChatAction("typing");
      const resultMsg = await planifyFn();
      await bctx.sendResponse(ctx, resultMsg);
    }
  });

  // PRD callback query handler (approve, reject, revise)
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    if (!data.startsWith("prd_")) {
      await next();
      return;
    }

    if (!bctx.supabase) {
      await ctx.answerCallbackQuery({ text: "Supabase non configure." });
      return;
    }

    const [action, prdId] = data.split(":");
    if (!prdId) {
      await ctx.answerCallbackQuery({ text: "ID manquant." });
      return;
    }

    if (action === "prd_approve") {
      const updated = await updatePRDStatus(bctx.supabase, prdId, "approved");
      if (updated) {
        await ctx.answerCallbackQuery({ text: "PRD approuve !" });
        await ctx.editMessageText(
          `PRD APPROUVE: ${updated.title} [${updated.id.substring(0, 8)}]\n\nLe PRD est maintenant pret pour l'implementation. Utilise /plan pour decomposer en taches.`
        );
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur." });
      }
    } else if (action === "prd_reject") {
      const updated = await updatePRDStatus(bctx.supabase, prdId, "rejected");
      if (updated) {
        await ctx.answerCallbackQuery({ text: "PRD rejete." });
        await ctx.editMessageText(
          `PRD REJETE: ${updated.title} [${updated.id.substring(0, 8)}]\n\nCree un nouveau PRD avec /prd si tu veux reprendre.`
        );
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur." });
      }
    } else if (action === "prd_revise") {
      await ctx.answerCallbackQuery({ text: "Envoie tes modifications." });
      await ctx.editMessageText(
        `PRD en revision [${prdId.substring(0, 8)}]\n\nDecris les modifications souhaitees dans un message. Je regenererai le PRD avec tes retours.`
      );
    }
  });

  return composer;
}
