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

const log = createLogger("exploration");

export default function explorationCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /explore — launch SDD exploration (Phase 0) via sdd-agents
  composer.command("explore", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "explore");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }

    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply(
        "Usage: /explore <sujet a explorer>\n\n" +
          "Lance une exploration structuree (3 axes + verdict GO/PIVOT/DROP).\n" +
          "Produit un artefact docs/explorations/EXPLORE-{name}.md",
        bctx.threadOpts(ctx),
      );
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

    await createPipeline(chatId, threadId, pipelineName);

    if (isJobManagerEnabled()) {
      const jobId = await launchJob(
        `sdd-explore:${pipelineName}`,
        chatId,
        () => runSddExplore(pipelineName, chatId, threadId),
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
        const result = await runSddExplore(pipelineName, chatId, threadId);
        await updateStep(chatId, threadId, "explore", {
          status: "ok",
          summary: result.substring(0, 200),
        });
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
