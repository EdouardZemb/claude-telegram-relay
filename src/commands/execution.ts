/**
 * @module execution
 * @description Grammy Composer handling task execution commands: /exec, /orchestrate,
 * /autopipeline. Delegates to sub-agent execution, multi-agent orchestration pipelines,
 * and autonomous end-to-end pipeline respectively.
 */

import { Composer, Context, InlineKeyboard } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { executeTask } from "../agent.ts";
import { updateTaskStatus } from "../tasks.ts";
import { buildStoryFile, enrichTaskWithStory, formatStoryPreview } from "../story-files.ts";
import { checkGatesWithOverrides, clearGateOverrides } from "../gates.ts";
import {
  orchestrate,
  formatOrchestrationResult,
  DEFAULT_PIPELINE,
  QUICK_PIPELINE,
  REVIEW_PIPELINE,
  type AgentRole,
} from "../orchestrator.ts";
import { runAutoPipeline, formatPipelineResult } from "../auto-pipeline.ts";
import { WorkflowTracker } from "../workflow.ts";
import { resolveProjectContext } from "../projects.ts";
import { buildTaskContext } from "../document-sharding.ts";
import { enqueue } from "../notification-queue.ts";
import { findLatestPipelineRun } from "../pipeline-state.ts";
import { getSession, buildConversationContext, hasActiveSession } from "../conversation-session.ts";

export default function execution(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /exec — execute a task from the backlog using a sub-agent
  composer.command("exec", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "exec");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const idPrefix = ctx.match?.trim();
    if (!idPrefix) {
      await ctx.reply("Usage: /exec <id> (premiers caracteres de l'ID de la tache)", bctx.threadOpts(ctx));
      return;
    }

    const { data: allExecTasks } = await bctx.supabase
      .from("tasks")
      .select("*")
      .in("status", ["backlog", "in_progress"]);

    const matches = (allExecTasks || []).filter((t: { id: string }) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      await ctx.reply(`Aucune tache trouvee avec l'ID "${idPrefix}".`, bctx.threadOpts(ctx));
      return;
    }
    if (matches.length > 1) {
      await ctx.reply(`Plusieurs taches correspondent. Sois plus precis:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`, bctx.threadOpts(ctx));
      return;
    }

    const task = matches[0];

    // BMad Gate Check — enforce gates before execution
    const gateFailure = await checkGatesWithOverrides(bctx.supabase, task);
    if (gateFailure) {
      const keyboard = gateFailure.overridable
        ? new InlineKeyboard()
            .text("Forcer le bypass", `gate_override:${task.id}:${gateFailure.gate}`)
            .text("Annuler", `gate_cancel:${task.id}`)
        : undefined;
      await ctx.reply(
        `GATE BLOQUEE\n\n${gateFailure.gate}\n${gateFailure.reason}`,
        { ...bctx.threadOpts(ctx), reply_markup: keyboard }
      );
      return;
    }

    // Enrich task with sharded document context
    const execProject = await resolveProjectContext(bctx.supabase, ctx.message?.message_thread_id);
    if (execProject?.id) {
      const shardedContext = await buildTaskContext(bctx.supabase, task.title, execProject.id, 3000);
      if (shardedContext) {
        task.description = (task.description || "") + "\n\nCONTEXTE DOCUMENTS:\n" + shardedContext;
      }
    }

    // Enrich task with story file (BMad structured specs)
    if (bctx.supabase) {
      const story = buildStoryFile(task);
      const enriched = await enrichTaskWithStory(bctx.supabase, task.id, story);
      if (enriched) {
        // Reload task with persisted story data
        const { data: refreshed } = await bctx.supabase
          .from("tasks")
          .select("*")
          .eq("id", task.id)
          .single();
        if (refreshed) {
          Object.assign(task, refreshed);
        }
        const preview = formatStoryPreview(story);
        await ctx.reply(`Story file generee:\n${preview}`, bctx.threadOpts(ctx));
      }
    }

    await ctx.reply(`Lancement de l'agent pour: ${task.title}\nCa peut prendre quelques minutes...`, bctx.threadOpts(ctx));

    // Workflow tracking
    const tracker = new WorkflowTracker(bctx.supabase, {
      taskId: task.id,
      sprintId: task.sprint || undefined,
      startStep: "request",
    });

    // Log transition: request -> execution
    await tracker.transition("execution", { agent_notes: `Exec lance pour: ${task.title}` });

    // Periodic heartbeat so user knows the agent is still running
    let heartbeatCount = 0;
    const heartbeat = setInterval(async () => {
      heartbeatCount++;
      const elapsed = heartbeatCount * 2;
      try {
        await ctx.reply(`Agent en cours... (${elapsed} min)`, bctx.threadOpts(ctx));
      } catch {}
    }, 120_000); // Every 2 minutes

    const result = await executeTask(bctx.supabase, task, async (msg) => {
      await ctx.reply(msg, bctx.threadOpts(ctx));
    });

    clearInterval(heartbeat);

    if (result.success) {
      // Log transition: execution -> review
      await tracker.transition("review", {
        checkpoint_result: "pass",
        agent_notes: `Agent termine avec succes`,
      });

      const duration = Math.round(result.durationMs / 1000);
      const summary = result.output.length > 3000
        ? result.output.substring(result.output.length - 3000)
        : result.output;
      const prLine = result.prUrl ? `\n\nPR: ${result.prUrl}` : "";
      const ciLine = result.ciPassed === false
        ? `\n\nCI echouee: ${result.ciDetails || "voir la PR"}\nTache en statut "review" — a corriger avant merge.`
        : result.ciPassed === true
        ? "\n\nCI OK"
        : "";
      await bctx.sendResponse(ctx, `Tache terminee en ${duration}s: ${task.title}${prLine}${ciLine}\n\n${summary}`);

      // Log transition: review -> closure (if CI passed)
      if (result.ciPassed !== false) {
        await tracker.transition("closure", {
          checkpoint_result: result.ciPassed ? "pass" : "skipped",
          agent_notes: result.ciPassed ? "CI OK, tache cloturee" : "Pas de CI, tache cloturee",
        });
      } else {
        await tracker.logCheckpoint("fail", `CI echouee: ${result.ciDetails || "details dans la PR"}`);
      }

      // Proactive notifications to other topics
      if (result.prUrl) {
        const branchName = `feature/${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50)}`;
        const ts = new Date().toLocaleTimeString("fr-FR", {
          hour: "2-digit", minute: "2-digit",
          timeZone: process.env.USER_TIMEZONE || "Europe/Paris",
        });
        await enqueue({
          type: "pr",
          severity: "normal",
          message: [`[${ts}] PR creee`, task.title, `Branche: ${branchName}`, result.prUrl].join("\n"),
          data: { prUrl: result.prUrl },
        });
      }
      if (result.ciPassed !== false) {
        const ts = new Date().toLocaleTimeString("fr-FR", {
          hour: "2-digit", minute: "2-digit",
          timeZone: process.env.USER_TIMEZONE || "Europe/Paris",
        });
        await enqueue({
          type: "task",
          severity: "normal",
          message: `[${ts}] Tache terminee: ${task.title} [${task.id.substring(0, 8)}]`,
          data: { taskId: task.id, taskStatus: "done" },
        });
      }
    } else {
      // Log failure
      await tracker.logCheckpoint("fail", result.error || "Execution echouee");
      const errMsg = result.error || result.output || "Erreur inconnue";
      await bctx.sendResponse(ctx, `Echec de la tache: ${task.title}\n\nErreur:\n${errMsg.substring(0, 2000)}`);
    }

    // Clear gate overrides after execution
    await clearGateOverrides(bctx.supabase, task.id);
  });

  // /orchestrate — run a task through a multi-agent pipeline
  composer.command("orchestrate", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "orchestrate");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const args = ctx.match?.trim() || "";
    // Parse: /orchestrate <taskId> [pipeline] [--blackboard] [--resume [sessionId]]
    // pipeline: "full" (default), "quick", "review", or comma-separated agent IDs
    const useBlackboard = args.includes("--blackboard");
    const useResume = args.includes("--resume");
    // Extract explicit session ID after --resume if present
    const resumeMatch = args.match(/--resume\s+([^\s-]\S*)/);
    const explicitResumeId = resumeMatch ? resumeMatch[1] : undefined;
    const cleanArgs = args
      .replace(/--blackboard/g, "")
      .replace(/--resume\s+\S*/g, "")
      .replace(/--resume/g, "")
      .trim();
    const parts = cleanArgs.split(/\s+/);
    const idPrefix = parts[0];
    const pipelineArg = parts[1] || "full";

    if (!idPrefix) {
      await ctx.reply(
        "Usage: /orchestrate <id> [pipeline] [--blackboard] [--resume]\n\n" +
        "Pipelines disponibles:\n" +
        "  full — Analyst -> PM -> Architect -> Dev -> QA (defaut)\n" +
        "  quick — Dev -> QA\n" +
        "  review — QA -> Architect\n" +
        "  custom — ex: /orchestrate abc pm,dev,qa\n\n" +
        "Options:\n" +
        "  --blackboard — Active le blackboard SDD (gates, verifier, tracabilite)\n" +
        "  --resume [sessionId] — Reprendre depuis le dernier echec (ou un sessionId specifique)",
        bctx.threadOpts(ctx)
      );
      return;
    }

    // Find task
    const { data: allOrchTasks } = await bctx.supabase
      .from("tasks")
      .select("*")
      .in("status", ["backlog", "in_progress"]);

    const orchMatches = (allOrchTasks || []).filter((t: { id: string }) => t.id.startsWith(idPrefix));

    if (orchMatches.length === 0) {
      await ctx.reply(`Aucune tache trouvee avec l'ID "${idPrefix}".`, bctx.threadOpts(ctx));
      return;
    }
    if (orchMatches.length > 1) {
      await ctx.reply(
        `Plusieurs taches correspondent:\n${orchMatches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`,
        bctx.threadOpts(ctx)
      );
      return;
    }

    const task = orchMatches[0];

    // Resolve pipeline
    let pipeline: AgentRole[];
    const validAgents: AgentRole[] = ["analyst", "pm", "architect", "dev", "qa", "sm"];
    if (pipelineArg === "full") {
      pipeline = [...DEFAULT_PIPELINE];
    } else if (pipelineArg === "quick") {
      pipeline = [...QUICK_PIPELINE];
    } else if (pipelineArg === "review") {
      pipeline = [...REVIEW_PIPELINE];
    } else {
      // Custom: comma-separated agent IDs
      const customAgents = pipelineArg.split(",").map((s) => s.trim().toLowerCase());
      const invalid = customAgents.filter((a) => !validAgents.includes(a as AgentRole));
      if (invalid.length > 0) {
        await ctx.reply(
          `Agents inconnus: ${invalid.join(", ")}\nAgents valides: ${validAgents.join(", ")}`,
          bctx.threadOpts(ctx)
        );
        return;
      }
      pipeline = customAgents as AgentRole[];
    }

    // S33: Resolve resume session ID
    let resumeSessionId: string | undefined;
    if (useResume) {
      if (explicitResumeId) {
        resumeSessionId = explicitResumeId;
      } else {
        const found = await findLatestPipelineRun(bctx.supabase, task.id);
        if (found) {
          resumeSessionId = found;
        } else {
          await ctx.reply("Aucun pipeline echoue a reprendre pour cette tache.", bctx.threadOpts(ctx));
          return;
        }
      }
    }

    const bbLabel = useBlackboard ? "\nBlackboard: actif (gates + verifier)" : "";
    const resumeLabel = resumeSessionId ? `\nResume: ${resumeSessionId}` : "";
    await ctx.reply(
      `Orchestration lancee pour: ${task.title}\nPipeline: ${pipeline.join(" -> ")}${bbLabel}${resumeLabel}\nCa peut prendre plusieurs minutes...`,
      bctx.threadOpts(ctx)
    );

    // S43: Inject conversation context if session is active
    let convCtx: string | undefined;
    const chatId = ctx.chat?.id || 0;
    const threadId = bctx.getThreadId(ctx);
    if (hasActiveSession(chatId, threadId)) {
      const session = getSession(chatId, threadId);
      convCtx = buildConversationContext(session);
    }

    // Mark task as in_progress before orchestration
    await updateTaskStatus(bctx.supabase, task.id, "in_progress");

    const result = await orchestrate(bctx.supabase, task, {
      pipeline,
      stopOnFailure: true,
      useBlackboard,
      resumeSessionId,
      conversationContext: convCtx || undefined,
      onProgress: async (msg) => {
        await ctx.reply(msg, bctx.threadOpts(ctx));
      },
    });

    // Update task status based on result
    if (result.success) {
      await updateTaskStatus(bctx.supabase, task.id, "done");
    }

    const formatted = formatOrchestrationResult(result);
    await bctx.sendResponse(ctx, formatted);
  });

  // /autopipeline — run a task through the full automated BMad pipeline
  composer.command("autopipeline", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "autopipeline");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const args = ctx.match?.trim() || "";
    const parts = args.split(/\s+/);
    const idPrefix = parts[0];
    const mode = parts[1] || "full"; // "full" (default, with analysis) or "fast" (skip analysis)

    if (!idPrefix) {
      await ctx.reply(
        "Usage: /autopipeline <id> [full|fast]\n\n" +
        "Modes:\n" +
        "  full — Gate -> Story -> Analyst+PM+Architect -> Dev -> Review (defaut)\n" +
        "  fast — Gate -> Story -> Dev -> Review (sans analyse)",
        bctx.threadOpts(ctx)
      );
      return;
    }

    const { data: allAutoTasks } = await bctx.supabase
      .from("tasks")
      .select("*")
      .in("status", ["backlog", "in_progress"]);

    const autoMatches = (allAutoTasks || []).filter((t: { id: string }) => t.id.startsWith(idPrefix));

    if (autoMatches.length === 0) {
      await ctx.reply(`Aucune tache trouvee avec l'ID "${idPrefix}".`, bctx.threadOpts(ctx));
      return;
    }
    if (autoMatches.length > 1) {
      await ctx.reply(
        `Plusieurs taches correspondent:\n${autoMatches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`,
        bctx.threadOpts(ctx)
      );
      return;
    }

    const task = autoMatches[0];

    await ctx.reply(
      `AUTO-PIPELINE lance pour: ${task.title}\nMode: ${mode}\nLe pipeline tourne en autonomie. Notifications a chaque phase.`,
      bctx.threadOpts(ctx)
    );

    const result = await runAutoPipeline(bctx.supabase, task, {
      includeAnalysis: mode === "full",
      onProgress: async (msg) => {
        await ctx.reply(msg, bctx.threadOpts(ctx));
      },
    });

    const formatted = formatPipelineResult(result);
    await bctx.sendResponse(ctx, formatted);
  });

  return composer;
}
