/**
 * @module commands/quality
 * @description Composer for quality & improvement commands: /metrics, /retro, /patterns, /alerts, /cost.
 * Includes retro validation callback queries (retro_accept_all, retro_reject).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { Composer, type Context, InlineKeyboard } from "grammy";
import { formatAlerts, runAllChecks } from "../alerts.ts";
import type { BotContext } from "../bot-context.ts";
import { formatCostSummary, getSprintCostSummary, getTotalCost } from "../llm-ops.ts";
import { createLogger } from "../logger.ts";
import { getCurrentSprint } from "../tasks.ts";

const log = createLogger("quality");

// ── Sprint Metrics & Retro (inlined from workflow.ts) ────────

interface SprintMetrics {
  id: string;
  sprint_id: string;
  tasks_planned: number;
  tasks_completed: number;
  completion_rate: number;
  avg_delivery_hours: number | null;
  first_pass_rate: number | null;
  incidents_count: number;
  rework_count: number;
  retro_actions_proposed: number;
  retro_actions_accepted: number;
  sprint_started_at: string | null;
  sprint_ended_at: string | null;
  total_tokens: number;
  total_cost_usd: number;
  agent_executions: number;
  project_id: string | null;
  created_at: string;
}

interface RetroRow {
  id: string;
  sprint_id: string;
  what_worked: string[];
  what_didnt: string[];
  patterns_detected: string[];
  actions_proposed: Array<{ action: string; priority: string }>;
  actions_accepted: Array<{ action: string; priority: string }>;
  raw_analysis: string | null;
  validated_at: string | null;
  project_id: string | null;
  created_at: string;
}

async function collectSprintMetrics(supabase: SupabaseClient, sprintId: string): Promise<boolean> {
  const { data: tasks, error: tasksError } = await supabase
    .from("tasks")
    .select("id, status, created_at, completed_at")
    .eq("sprint", sprintId);
  if (tasksError || !tasks) {
    log.error("collectSprintMetrics tasks error", { error: String(tasksError) });
    return false;
  }
  const planned = tasks.length;
  const completed = tasks.filter((t: { status: string }) => t.status === "done").length;
  const deliveryTimes = tasks
    .filter(
      (t: { status: string; completed_at: string | null }) => t.status === "done" && t.completed_at,
    )
    .map((t: { created_at: string; completed_at: string | null }) => {
      return (
        (new Date(t.completed_at!).getTime() - new Date(t.created_at).getTime()) / (1000 * 60 * 60)
      );
    });
  const avgDeliveryHours =
    deliveryTimes.length > 0
      ? deliveryTimes.reduce((a: number, b: number) => a + b, 0) / deliveryTimes.length
      : null;
  const { data: logs } = await supabase
    .from("workflow_logs")
    .select("had_rework, checkpoint_result")
    .eq("sprint_id", sprintId);
  const reworkCount = logs?.filter((l: { had_rework: boolean | null }) => l.had_rework).length ?? 0;
  const taskIds = tasks.map((t: { id: string }) => t.id);
  const { data: reviewLogs } = await supabase
    .from("workflow_logs")
    .select("task_id, had_rework")
    .eq("step_to", "review")
    .in("task_id", taskIds.length > 0 ? taskIds : ["none"]);
  const reviewedTasks = new Set(
    reviewLogs?.map((l: { task_id: string | null }) => l.task_id) ?? [],
  );
  const firstPassTasks =
    reviewLogs?.filter((l: { had_rework: boolean | null }) => !l.had_rework) ?? [];
  const firstPassRate =
    reviewedTasks.size > 0 ? (firstPassTasks.length / reviewedTasks.size) * 100 : null;
  const { data: costData } = await supabase
    .from("cost_tracking")
    .select("tokens_input, tokens_output, cost_usd")
    .eq("sprint_id", sprintId);
  let totalTokens = 0;
  let totalCostUsd = 0;
  const agentExecutions = costData?.length ?? 0;
  for (const row of costData ?? []) {
    totalTokens += (row.tokens_input || 0) + (row.tokens_output || 0);
    totalCostUsd += Number(row.cost_usd) || 0;
  }
  const { error: upsertError } = await supabase.from("sprint_metrics").upsert(
    {
      sprint_id: sprintId,
      tasks_planned: planned,
      tasks_completed: completed,
      avg_delivery_hours: avgDeliveryHours ? Math.round(avgDeliveryHours * 100) / 100 : null,
      first_pass_rate: firstPassRate ? Math.round(firstPassRate * 100) / 100 : null,
      rework_count: reworkCount,
      sprint_ended_at: new Date().toISOString(),
      total_tokens: totalTokens,
      total_cost_usd: Math.round(totalCostUsd * 10000) / 10000,
      agent_executions: agentExecutions,
    },
    { onConflict: "sprint_id" },
  );
  if (upsertError) {
    log.error("collectSprintMetrics upsert error", { error: String(upsertError) });
    return false;
  }
  return true;
}

async function getSprintMetrics(
  supabase: SupabaseClient,
  sprintId: string,
): Promise<SprintMetrics | null> {
  const { data, error } = await supabase
    .from("sprint_metrics")
    .select("*")
    .eq("sprint_id", sprintId)
    .single();
  if (error) return null;
  return data;
}

async function getAllSprintMetrics(supabase: SupabaseClient): Promise<SprintMetrics[]> {
  const { data, error } = await supabase
    .from("sprint_metrics")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return [];
  return data ?? [];
}

function formatMetrics(metrics: SprintMetrics): string {
  if (!metrics) return "Pas de metriques disponibles pour ce sprint.";
  const lines = [
    `Metriques Sprint ${metrics.sprint_id}`,
    "",
    `Taches: ${metrics.tasks_completed}/${metrics.tasks_planned} (${metrics.completion_rate ?? 0}%)`,
  ];
  if (metrics.avg_delivery_hours !== null)
    lines.push(`Temps moyen de livraison: ${metrics.avg_delivery_hours}h`);
  if (metrics.first_pass_rate !== null)
    lines.push(`Taux premier passage: ${metrics.first_pass_rate}%`);
  if (metrics.rework_count > 0) lines.push(`Retouches: ${metrics.rework_count}`);
  if (metrics.incidents_count > 0) lines.push(`Incidents: ${metrics.incidents_count}`);
  if (metrics.total_tokens > 0 || metrics.total_cost_usd > 0) {
    lines.push(
      `Tokens: ${metrics.total_tokens || 0} (~$${(metrics.total_cost_usd || 0).toFixed(4)})`,
    );
    if (metrics.agent_executions > 0) lines.push(`Executions agent: ${metrics.agent_executions}`);
  }
  if (metrics.sprint_ended_at)
    lines.push(`Cloture: ${new Date(metrics.sprint_ended_at).toLocaleDateString("fr-FR")}`);
  return lines.join("\n");
}

function formatMetricsComparison(metricsList: SprintMetrics[]): string {
  if (metricsList.length === 0) return "Pas de metriques disponibles.";
  const lines = ["Evolution des sprints", ""];
  for (const m of metricsList) {
    const rate = m.completion_rate ?? 0;
    const bar = "=".repeat(Math.round(rate / 5)) + " " + rate + "%";
    lines.push(`${m.sprint_id}: ${bar} (${m.tasks_completed}/${m.tasks_planned})`);
  }
  return lines.join("\n");
}

async function generateRetroData(
  supabase: SupabaseClient,
  sprintId: string,
): Promise<{
  metrics: SprintMetrics | null;
  workflowStats: {
    totalTransitions: number;
    reworkCount: number;
    avgStepDuration: Record<string, number>;
    checkpointResults: Record<string, number>;
  };
  tasks: Record<string, unknown>[];
} | null> {
  const metrics = await getSprintMetrics(supabase, sprintId);
  const { data: logs } = await supabase
    .from("workflow_logs")
    .select("*")
    .eq("sprint_id", sprintId)
    .order("created_at", { ascending: true });
  const { data: tasks } = await supabase.from("tasks").select("*").eq("sprint", sprintId);
  const totalTransitions = logs?.length ?? 0;
  const reworkCount = logs?.filter((l: { had_rework: boolean | null }) => l.had_rework).length ?? 0;
  const stepDurations: Record<string, number[]> = {};
  for (const entry of logs ?? []) {
    if (entry.duration_seconds && entry.step_from !== entry.step_to) {
      if (!stepDurations[entry.step_from]) stepDurations[entry.step_from] = [];
      stepDurations[entry.step_from].push(entry.duration_seconds);
    }
  }
  const avgStepDuration: Record<string, number> = {};
  for (const [step, durations] of Object.entries(stepDurations)) {
    avgStepDuration[step] = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  }
  const checkpointResults: Record<string, number> = {};
  for (const entry of logs ?? []) {
    if (entry.checkpoint_result)
      checkpointResults[entry.checkpoint_result] =
        (checkpointResults[entry.checkpoint_result] ?? 0) + 1;
  }
  return {
    metrics,
    workflowStats: { totalTransitions, reworkCount, avgStepDuration, checkpointResults },
    tasks: tasks ?? [],
  };
}

async function saveRetro(
  supabase: SupabaseClient,
  sprintId: string,
  retro: {
    what_worked: string[];
    what_didnt: string[];
    patterns_detected: string[];
    actions_proposed: Array<{ action: string; priority: string }>;
    raw_analysis: string;
  },
): Promise<boolean> {
  const { error } = await supabase.from("retros").upsert(
    {
      sprint_id: sprintId,
      what_worked: retro.what_worked,
      what_didnt: retro.what_didnt,
      patterns_detected: retro.patterns_detected,
      actions_proposed: retro.actions_proposed,
      raw_analysis: retro.raw_analysis,
    },
    { onConflict: "sprint_id" },
  );
  if (error) {
    log.error("saveRetro error", { error: String(error) });
    return false;
  }
  return true;
}

async function acceptRetroActions(
  supabase: SupabaseClient,
  sprintId: string,
  acceptedActions: Array<{ action: string; priority: string }>,
): Promise<boolean> {
  const { error } = await supabase
    .from("retros")
    .update({ actions_accepted: acceptedActions, validated_at: new Date().toISOString() })
    .eq("sprint_id", sprintId);
  if (error) {
    log.error("acceptRetroActions error", { error: String(error) });
    return false;
  }
  return true;
}

async function getRetro(supabase: SupabaseClient, sprintId: string): Promise<RetroRow | null> {
  const { data, error } = await supabase
    .from("retros")
    .select("*")
    .eq("sprint_id", sprintId)
    .single();
  if (error) return null;
  return data;
}

function formatRetro(retro: RetroRow | null): string {
  if (!retro) return "Pas de retro disponible pour ce sprint.";
  const lines = [`Retro Sprint ${retro.sprint_id}`, ""];
  if (retro.what_worked?.length > 0) {
    lines.push("Ce qui a bien marche :");
    for (const item of retro.what_worked) lines.push(`  + ${item}`);
    lines.push("");
  }
  if (retro.what_didnt?.length > 0) {
    lines.push("Ce qui a coince :");
    for (const item of retro.what_didnt) lines.push(`  - ${item}`);
    lines.push("");
  }
  if (retro.patterns_detected?.length > 0) {
    lines.push("Patterns detectes :");
    for (const item of retro.patterns_detected) lines.push(`  ~ ${item}`);
    lines.push("");
  }
  if (retro.actions_proposed?.length > 0) {
    lines.push("Actions proposees :");
    for (const action of retro.actions_proposed) {
      const status = retro.actions_accepted?.some(
        (a: { action: string }) => a.action === action.action,
      )
        ? "[OK]"
        : "[ ]";
      lines.push(`  ${status} ${action.action} (${action.priority})`);
    }
  }
  return lines.join("\n");
}
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

    const retroPrompt = [
      "Analyse les donnees suivantes pour generer une retrospective de sprint structuree.",
      "Reponds UNIQUEMENT en JSON valide, sans markdown, sans commentaires.",
      "",
      `Sprint: ${sprintId}`,
      `Metriques: ${JSON.stringify(retroData.metrics)}`,
      `Stats workflow: ${JSON.stringify(retroData.workflowStats)}`,
      `Taches (${retroData.tasks.length}): ${JSON.stringify(retroData.tasks.map((t) => ({ title: (t as { title?: unknown }).title, status: (t as { status?: unknown }).status, priority: (t as { priority?: unknown }).priority })))}`,
      "",
      "Format JSON attendu:",
      '{"what_worked": ["..."], "what_didnt": ["..."], "patterns_detected": ["..."], "actions_proposed": [{"action": "...", "priority": "high|medium|low", "target_step": "optional_step_id", "suggested_change": "optional_change"}]}',
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

        const message = `Retro ${sprintId} : toutes les actions ont ete validees. Elles seront prises en compte dans le prochain sprint.`;

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
