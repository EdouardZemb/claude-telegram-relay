/**
 * @module commands/exploration
 * @description Grammy Composer handling the /explore command.
 * Architecture V2: launches SDD exploration (Phase 0) via sdd-agents.ts
 * to produce a structured EXPLORE-{name}.md with 3 axes + verdict GO/PIVOT/DROP.
 */

import { Composer, type Context } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { isJobManagerEnabled, launch as launchJob } from "../job-manager.ts";
import { createLogger } from "../logger.ts";
import { createPipeline, getTracker, toPipelineName, updateStep } from "../pipeline-tracker.ts";
import { runSddExplore } from "../sdd-agents.ts";
import { syncTaskStatusForPhase } from "../sdd-task-sync.ts";
import { addTask, getTaskById } from "../tasks.ts";

const log = createLogger("exploration");

/**
 * Parse --task <id> flag from /explore input.
 * Returns { query, taskId } where taskId is undefined if no --task flag.
 */
export function parseExploreArgs(input: string): { query: string; taskId?: string } {
  const taskMatch = input.match(/--task\s+(\S+)/);
  const taskId = taskMatch?.[1];
  const query = input.replace(/--task\s+\S+/, "").trim();
  return { query, taskId };
}

export default function explorationCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /explore — launch SDD exploration (Phase 0) via sdd-agents
  composer.command("explore", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "explore");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }

    const rawInput = ctx.match?.trim();
    if (!rawInput) {
      await ctx.reply(
        "Usage: /explore <sujet a explorer>\n\n" +
          "Lance une exploration structuree (3 axes + verdict GO/PIVOT/DROP).\n" +
          "Produit un artefact docs/explorations/EXPLORE-{name}.md\n\n" +
          "Options:\n" +
          "  --task <id>  Lier a une tache existante du backlog",
        bctx.threadOpts(ctx),
      );
      return;
    }

    const { query, taskId: linkedTaskId } = parseExploreArgs(rawInput);
    if (!query) {
      await ctx.reply("Le sujet d'exploration est requis.", bctx.threadOpts(ctx));
      return;
    }

    const chatId = ctx.chat?.id || 0;
    const threadId = bctx.getThreadId(ctx);
    const pipelineName = toPipelineName(query);

    // Guard: if tracker < 1h, warn user
    const existingTracker = await getTracker(chatId, threadId);
    if (existingTracker) {
      const ageMs = Date.now() - new Date(existingTracker.updatedAt).getTime();
      if (ageMs < 60 * 60 * 1000) {
        await ctx.reply(
          `Pipeline SDD "${existingTracker.name}" actif (< 1h). Il sera remplace par la nouvelle exploration.`,
          bctx.threadOpts(ctx),
        );
      }
    }

    // Resolve task: link to existing or create new
    let resolvedTaskId: string | undefined;
    try {
      if (linkedTaskId) {
        // Link to existing task via --task <id>
        const existingTask = bctx.supabase ? await getTaskById(bctx.supabase, linkedTaskId) : null;
        if (existingTask) {
          resolvedTaskId = existingTask.id;
          log.info("Pipeline linked to existing task", { pipelineName, taskId: resolvedTaskId });
        } else {
          await ctx.reply(
            `Tache "${linkedTaskId}" introuvable. Le pipeline sera cree sans lien de tache.`,
            bctx.threadOpts(ctx),
          );
        }
      } else {
        // Auto-create a new task for this pipeline
        const task = bctx.supabase
          ? await addTask(bctx.supabase, `[SDD] ${query}`, {
              description: `Pipeline SDD: ${pipelineName}`,
              tags: ["sdd-pipeline"],
              sdd_pipeline_name: pipelineName,
            })
          : null;
        if (task) {
          resolvedTaskId = task.id;
          log.info("Auto-created task for pipeline", { pipelineName, taskId: resolvedTaskId });
        }
      }
    } catch (error) {
      // Best-effort: pipeline creation continues without task link
      log.warn("Failed to create/link task for pipeline", {
        pipelineName,
        error: String(error),
      });
    }

    await createPipeline(chatId, threadId, pipelineName, { taskId: resolvedTaskId });

    if (isJobManagerEnabled()) {
      const jobId = await launchJob(
        `sdd-explore:${pipelineName}`,
        chatId,
        () => runSddExplore(pipelineName, chatId, threadId, bctx.supabase),
        { messageThreadId: threadId },
      );

      await updateStep(chatId, threadId, "explore", { status: "running", jobId });

      await ctx.reply(
        `Exploration SDD lancee: "${pipelineName}" (job ${jobId})\nSujet: ${query}`,
        bctx.threadOpts(ctx),
      );
    } else {
      await ctx.reply(`Exploration en cours: ${query}`, bctx.threadOpts(ctx));
      try {
        const result = await runSddExplore(pipelineName, chatId, threadId, bctx.supabase);
        await updateStep(chatId, threadId, "explore", {
          status: "ok",
          summary: result.substring(0, 200),
        });
        // Sync linked task status (best-effort)
        if (resolvedTaskId && bctx.supabase) {
          await syncTaskStatusForPhase(bctx.supabase, resolvedTaskId, "explore", "ok");
        }
        await bctx.sendResponse(ctx, result);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        await updateStep(chatId, threadId, "explore", {
          status: "failed",
          summary: msg.substring(0, 200),
        });
        await ctx.reply(`Exploration echouee:\n${msg.substring(0, 2000)}`, bctx.threadOpts(ctx));
      }
    }
  });

  return composer;
}
