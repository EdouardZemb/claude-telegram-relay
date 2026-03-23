/**
 * @module commands/quality
 * @description Composer for quality & improvement commands: /metrics, /retro, /patterns, /alerts, /cost.
 * Includes retro validation callback queries (retro_accept_all, retro_reject).
 */

import { Composer, type Context, InlineKeyboard } from "grammy";
import { formatAlerts, runAllChecks } from "../alerts.ts";
import { getAgentForCommand } from "../bmad-agents.ts";
import type { BotContext } from "../bot-context.ts";
import { formatCostSummary, getSprintCostSummary, getTotalCost } from "../cost-tracking.ts";
import { loadFeedbackRules, processRetroFeedback } from "../feedback-loop.ts";
import { createLogger } from "../logger.ts";
import { analyzePatterns, formatPatterns } from "../patterns.ts";
import { getCurrentSprint } from "../tasks.ts";
import {
  acceptRetroActions,
  applyWorkflowSuggestions,
  collectSprintMetrics,
  formatMetrics,
  formatMetricsComparison,
  formatRetro,
  generateRetroData,
  getAllSprintMetrics,
  getRetro,
  getSprintMetrics,
  saveRetro,
} from "../workflow.ts";

const log = createLogger("quality");
export default function qualityComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /metrics
  composer.command("metrics", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "metrics");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const arg = ctx.match?.trim();

    if (arg === "all" || arg === "compare") {
      const all = await getAllSprintMetrics(bctx.supabase);
      await bctx.sendResponse(ctx, formatMetricsComparison(all));
      return;
    }

    const sprintId = arg || (await getCurrentSprint(bctx.supabase));
    if (!sprintId) {
      await ctx.reply(
        "Aucun sprint actif. Usage: /metrics S11 ou /metrics all",
        bctx.threadOpts(ctx),
      );
      return;
    }

    await collectSprintMetrics(bctx.supabase, sprintId);
    const metrics = await getSprintMetrics(bctx.supabase, sprintId);
    if (!metrics) {
      await ctx.reply("Aucune metrique disponible pour ce sprint.", bctx.threadOpts(ctx));
      return;
    }
    await bctx.sendResponse(ctx, formatMetrics(metrics));
  });

  // /retro
  composer.command("retro", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "retro");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const arg = ctx.match?.trim();
    const sprintId = arg || (await getCurrentSprint(bctx.supabase));
    if (!sprintId) {
      await ctx.reply("Aucun sprint actif. Usage: /retro S11", bctx.threadOpts(ctx));
      return;
    }

    const existing = await getRetro(bctx.supabase, sprintId);
    if (existing) {
      await bctx.sendResponse(ctx, formatRetro(existing));
      return;
    }

    await ctx.reply(`Generation de la retro pour ${sprintId}...`, bctx.threadOpts(ctx));
    await ctx.replyWithChatAction("typing");

    await collectSprintMetrics(bctx.supabase, sprintId);
    const retroData = await generateRetroData(bctx.supabase, sprintId);

    if (!retroData) {
      await ctx.reply("Pas assez de donnees pour generer une retro.", bctx.threadOpts(ctx));
      return;
    }

    const patternAnalysis = await analyzePatterns(bctx.supabase);

    const smAgent = getAgentForCommand("retro");
    const agentPrefix = smAgent
      ? `Tu es ${smAgent.name}, ${smAgent.title} (${smAgent.icon}). ${smAgent.communicationStyle}\n\n`
      : "";
    const retroPrompt = [
      agentPrefix +
        "Analyse les donnees suivantes pour generer une retrospective de sprint structuree.",
      "Reponds UNIQUEMENT en JSON valide, sans markdown, sans commentaires.",
      "",
      `Sprint: ${sprintId}`,
      `Metriques: ${JSON.stringify(retroData.metrics)}`,
      `Stats workflow: ${JSON.stringify(retroData.workflowStats)}`,
      `Taches (${retroData.tasks.length}): ${JSON.stringify(retroData.tasks.map((t) => ({ title: (t as { title?: unknown }).title, status: (t as { status?: unknown }).status, priority: (t as { priority?: unknown }).priority })))}`,
      patternAnalysis.patterns.length > 0
        ? `Patterns detectes automatiquement: ${JSON.stringify(patternAnalysis.patterns.map((p) => p.description))}`
        : "",
      patternAnalysis.suggestions.length > 0
        ? `Suggestions workflow automatiques: ${JSON.stringify(patternAnalysis.suggestions.map((s) => ({ action: s.action, priority: s.priority, target_step: s.target_step, suggested_change: s.suggested_change })))}`
        : "",
      "",
      "Format JSON attendu:",
      '{"what_worked": ["..."], "what_didnt": ["..."], "patterns_detected": ["..."], "actions_proposed": [{"action": "...", "priority": "high|medium|low", "target_step": "optional_step_id", "suggested_change": "optional_change"}]}',
      "Inclus les suggestions workflow automatiques dans actions_proposed en conservant target_step et suggested_change.",
    ].join("\n");

    try {
      const analysis = await bctx.callClaude(retroPrompt, { heartbeat: bctx.heartbeatOpts(ctx) });
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        await ctx.reply("Erreur: impossible de parser la retro generee.", bctx.threadOpts(ctx));
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      await saveRetro(bctx.supabase, sprintId, {
        what_worked: parsed.what_worked || [],
        what_didnt: parsed.what_didnt || [],
        patterns_detected: parsed.patterns_detected || [],
        actions_proposed: parsed.actions_proposed || [],
        raw_analysis: analysis,
      });

      const retro = await getRetro(bctx.supabase, sprintId);
      await bctx.sendResponse(ctx, formatRetro(retro));

      if (parsed.actions_proposed?.length > 0) {
        const keyboard = new InlineKeyboard()
          .text("Valider toutes les actions", `retro_accept_all:${sprintId}`)
          .row()
          .text("Rejeter", `retro_reject:${sprintId}`);
        await ctx.reply("Valider les actions proposees ?", {
          ...bctx.threadOpts(ctx),
          reply_markup: keyboard,
        });
      }
    } catch (error) {
      log.error("Retro generation error", { error: String(error) });
      await ctx.reply("Erreur lors de la generation de la retro.", bctx.threadOpts(ctx));
    }
  });

  // /patterns
  composer.command("patterns", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "patterns");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    await ctx.replyWithChatAction("typing");
    const analysis = await analyzePatterns(bctx.supabase);
    await bctx.sendResponse(ctx, formatPatterns(analysis));
  });

  // /alerts
  composer.command("alerts", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "alerts");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const arg = ctx.match?.trim();
    const sprintId = arg || (await getCurrentSprint(bctx.supabase)) || undefined;

    await ctx.replyWithChatAction("typing");
    const alerts = await runAllChecks(bctx.supabase, sprintId);
    await bctx.sendResponse(ctx, formatAlerts(alerts));
  });

  // /cost
  composer.command("cost", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "cost");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const arg = ctx.match?.trim();

    if (arg === "total" || arg === "all") {
      const total = await getTotalCost(bctx.supabase);
      await bctx.sendResponse(
        ctx,
        `Couts totaux\n\nTokens: ${total.totalTokens}\nCout estime: $${total.totalCostUsd.toFixed(4)}\nExecutions: ${total.executions}`,
      );
      return;
    }

    const sprintId = arg || (await getCurrentSprint(bctx.supabase));
    if (!sprintId) {
      await ctx.reply("Aucun sprint actif. Usage: /cost S22 ou /cost total", bctx.threadOpts(ctx));
      return;
    }

    await ctx.replyWithChatAction("typing");
    const summary = await getSprintCostSummary(bctx.supabase, sprintId);
    await bctx.sendResponse(ctx, formatCostSummary(summary));
  });

  // Retro validation callbacks
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("retro_")) {
      await next();
      return;
    }

    if (!bctx.supabase) {
      await ctx.answerCallbackQuery({ text: "Supabase non configure." });
      return;
    }

    const [action, sprintId] = data.split(":");
    if (!sprintId) {
      await ctx.answerCallbackQuery({ text: "Sprint ID manquant." });
      return;
    }

    if (action === "retro_accept_all") {
      const retro = await getRetro(bctx.supabase, sprintId);
      if (retro?.actions_proposed) {
        await acceptRetroActions(bctx.supabase, sprintId, retro.actions_proposed);

        const feedbackResult = await processRetroFeedback(bctx.supabase, {
          sprint_id: sprintId,
          what_didnt: retro.what_didnt || [],
          patterns_detected: retro.patterns_detected || [],
          actions_proposed: retro.actions_proposed,
        });
        log.info(
          `Feedback loop: ${feedbackResult.newRules} new rules, ${feedbackResult.updatedRules} updated`,
        );

        await loadFeedbackRules(bctx.supabase);

        const workflowChanges = applyWorkflowSuggestions(retro.actions_proposed);

        let message = `Retro ${sprintId} : toutes les actions ont ete validees.`;
        if (workflowChanges.length > 0) {
          message += `\n\nModifications appliquees :\n${workflowChanges.map((c) => `  ${c}`).join("\n")}`;
        } else {
          message += " Elles seront prises en compte dans le prochain sprint.";
        }

        await ctx.answerCallbackQuery({ text: "Actions validees !" });
        await ctx.editMessageText(message);
      }
    } else if (action === "retro_reject") {
      await ctx.answerCallbackQuery({ text: "Actions rejetees." });
      await ctx.editMessageText(
        `Retro ${sprintId} : actions rejetees. Tu peux relancer /retro ${sprintId} pour regenerer.`,
      );
    }
  });

  return composer;
}
