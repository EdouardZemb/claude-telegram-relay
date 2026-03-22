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
import { launch as launchJob, isJobManagerEnabled } from "../job-manager.ts";

// F-DA-1: Map of session keys -> resolve callbacks for adversarial challenge pause/resume
const challengeResolvers = new Map<string, (shouldContinue: boolean) => void>();

export default function execution(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // F-DA-1: Callback handler for adversarial challenge resume/abort buttons
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("challenge_resume:") || data.startsWith("challenge_abort:")) {
      const sessionKey = data.replace("challenge_resume:", "").replace("challenge_abort:", "");
      const resolver = challengeResolvers.get(sessionKey);

      if (resolver) {
        const shouldContinue = data.startsWith("challenge_resume:");
        challengeResolvers.delete(sessionKey);
        resolver(shouldContinue);

        await ctx.answerCallbackQuery({
          text: shouldContinue ? "Pipeline repris." : "Pipeline abandonne.",
        });
        await ctx.reply(
          shouldContinue
            ? "Pipeline repris apres challenge adversarial."
            : "Pipeline abandonne suite au challenge adversarial.",
          bctx.threadOpts(ctx)
        );
      } else {
        await ctx.answerCallbackQuery({ text: "Session expiree." });
      }
      return;
    }

    await next();
  });

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
        { ...bctx.threadOpts(ctx), ...(keyboard !== undefined ? { reply_markup: keyboard } : {}) }
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

    // ── Background job wrapper (S46) ────────────────────────────
    const execFn = async (progressFn: (msg: string) => Promise<void>): Promise<string> => {
      const tracker = new WorkflowTracker(bctx.supabase!, {
        taskId: task.id,
        sprintId: task.sprint || undefined,
        startStep: "request",
      });
      await tracker.transition("execution", { agent_notes: `Exec lance pour: ${task.title}` });

      const result = await executeTask(bctx.supabase!, task, progressFn);

      if (result.success) {
        await tracker.transition("review", {
          checkpoint_result: "pass",
          agent_notes: `Agent termine avec succes`,
        });

        const duration = Math.round(result.durationMs / 1000);
        const summary = result.output.length > 3000
          ? result.output.substring(result.output.length - 3000)
          : result.output;
        const prLine = result.prUrl ? `\nPR: ${result.prUrl}` : "";
        const ciLine = result.ciPassed === false
          ? `\nCI echouee: ${result.ciDetails || "voir la PR"}`
          : result.ciPassed === true ? "\nCI OK" : "";

        if (result.ciPassed !== false) {
          await tracker.transition("closure", {
            checkpoint_result: result.ciPassed ? "pass" : "skipped",
            agent_notes: result.ciPassed ? "CI OK, tache cloturee" : "Pas de CI, tache cloturee",
          });
        } else {
          await tracker.logCheckpoint("fail", `CI echouee: ${result.ciDetails || "details dans la PR"}`);
        }

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

        await clearGateOverrides(bctx.supabase!, task.id);
        return `Tache terminee en ${duration}s: ${task.title}${prLine}${ciLine}\n\n${summary}`;
      } else {
        await tracker.logCheckpoint("fail", result.error || "Execution echouee");
        await clearGateOverrides(bctx.supabase!, task.id);
        const errMsg = result.error || result.output || "Erreur inconnue";
        throw new Error(`Echec: ${task.title}\n${errMsg.substring(0, 500)}`);
      }
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const threadId = bctx.getThreadId(ctx);
      const jobId = await launchJob("exec", chatId, () => execFn(async () => {}), { taskId: task.id, messageThreadId: threadId });
      await ctx.reply(`Job lance exec (id: ${jobId})\nTache: ${task.title}`, bctx.threadOpts(ctx));
    } else {
      await ctx.reply(`Lancement de l'agent pour: ${task.title}\nCa peut prendre quelques minutes...`, bctx.threadOpts(ctx));

      let heartbeatCount = 0;
      const heartbeat = setInterval(async () => {
        heartbeatCount++;
        try { await ctx.reply(`Agent en cours... (${heartbeatCount * 2} min)`, bctx.threadOpts(ctx)); } catch {}
      }, 120_000);

      try {
        const resultMsg = await execFn(async (msg) => {
          await ctx.reply(msg, bctx.threadOpts(ctx));
        });
        clearInterval(heartbeat);
        await bctx.sendResponse(ctx, resultMsg);
      } catch (error: any) {
        clearInterval(heartbeat);
        await bctx.sendResponse(ctx, error.message || "Erreur inconnue");
      }
    }
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
    // Parse: /orchestrate <taskId> [pipeline] [--blackboard] [--resume [sessionId]] [--skip-challenge]
    // pipeline: "full" (default), "quick", "review", or comma-separated agent IDs
    const useBlackboard = args.includes("--blackboard");
    const useResume = args.includes("--resume");
    const skipChallenge = args.includes("--skip-challenge"); // F-EC-4: skips P2+E1 together
    // Extract explicit session ID after --resume if present
    const resumeMatch = args.match(/--resume\s+([^\s-]\S*)/);
    const explicitResumeId = resumeMatch ? resumeMatch[1] : undefined;
    const cleanArgs = args
      .replace(/--blackboard/g, "")
      .replace(/--resume\s+\S*/g, "")
      .replace(/--resume/g, "")
      .replace(/--skip-challenge/g, "")
      .trim();
    const parts = cleanArgs.split(/\s+/);
    const idPrefix = parts[0];
    const pipelineArg = parts[1] || "full";

    if (!idPrefix) {
      await ctx.reply(
        "Usage: /orchestrate <id> [pipeline] [--blackboard] [--resume] [--skip-challenge]\n\n" +
        "Pipelines disponibles:\n" +
        "  full — Analyst -> PM -> Architect -> Dev -> QA (defaut)\n" +
        "  quick — Dev -> QA\n" +
        "  review — QA -> Architect\n" +
        "  custom — ex: /orchestrate abc pm,dev,qa\n\n" +
        "Options:\n" +
        "  --blackboard — Active le blackboard SDD (gates, verifier, tracabilite)\n" +
        "  --resume [sessionId] — Reprendre depuis le dernier echec (ou un sessionId specifique)\n" +
        "  --skip-challenge — Bypass le challenge adversarial (P2+E1) meme si le flag est actif",
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

    // S43: Inject conversation context if session is active
    let convCtx: string | undefined;
    const chatId = ctx.chat?.id || 0;
    const threadId = bctx.getThreadId(ctx);
    if (hasActiveSession(chatId, threadId)) {
      const session = getSession(chatId, threadId);
      convCtx = buildConversationContext(session);
    }

    const bbLabel = useBlackboard ? "\nBlackboard: actif (gates + verifier)" : "";
    const resumeLabel = resumeSessionId ? `\nResume: ${resumeSessionId}` : "";
    const challengeLabel = skipChallenge ? "\nChallenge: desactive (--skip-challenge)" : "";

    // ── Background job wrapper (S46) ────────────────────────────
    const orchestrateFn = async (progressFn: (msg: string) => Promise<void>): Promise<string> => {
      await updateTaskStatus(bctx.supabase!, task.id, "in_progress");

      // F-DA-1: Build adversarial pause callback with inline buttons
      const onAdversarialPause = async (adversarialResult: any, impactResult: any): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
          const sessionKey = `challenge_${task.id.substring(0, 8)}_${Date.now()}`;
          const keyboard = new InlineKeyboard()
            .text("Continuer", `challenge_resume:${sessionKey}`)
            .text("Abandonner", `challenge_abort:${sessionKey}`);

          const pauseMsg =
            `CHALLENGE ADVERSARIAL — PAUSE\n\n` +
            `${adversarialResult.stats.bloquants} finding(s) bloquant(s)\n` +
            (impactResult ? `Impact: ${impactResult.risk_level}\n` : "") +
            `\nChoisissez une action:`;

          ctx.reply(pauseMsg, {
            ...bctx.threadOpts(ctx),
            reply_markup: keyboard,
          }).catch((err: any) => console.error("challenge pause reply error:", err));

          // Store the resolve callback for the callback handler
          challengeResolvers.set(sessionKey, resolve);

          // Timeout: auto-continue after 10 minutes
          setTimeout(() => {
            if (challengeResolvers.has(sessionKey)) {
              challengeResolvers.delete(sessionKey);
              resolve(true); // Auto-continue on timeout
            }
          }, 10 * 60 * 1000);
        });
      };

      const result = await orchestrate(bctx.supabase!, task, {
        pipeline,
        stopOnFailure: true,
        useBlackboard,
        resumeSessionId,
        conversationContext: convCtx || undefined,
        onProgress: progressFn,
        skipChallenge,
        onAdversarialPause,
      });

      if (result.success) {
        await updateTaskStatus(bctx.supabase!, task.id, "done");
      }

      return formatOrchestrationResult(result);
    };

    if (isJobManagerEnabled()) {
      const threadId = bctx.getThreadId(ctx);
      const jobId = await launchJob("orchestrate", chatId, () => orchestrateFn(async () => {}), { taskId: task.id, messageThreadId: threadId });
      await ctx.reply(
        `Job lance orchestrate (id: ${jobId})\nTache: ${task.title}\nPipeline: ${pipeline.join(" -> ")}${bbLabel}${resumeLabel}${challengeLabel}`,
        bctx.threadOpts(ctx)
      );
    } else {
      await ctx.reply(
        `Orchestration lancee pour: ${task.title}\nPipeline: ${pipeline.join(" -> ")}${bbLabel}${resumeLabel}${challengeLabel}\nCa peut prendre plusieurs minutes...`,
        bctx.threadOpts(ctx)
      );

      const resultMsg = await orchestrateFn(async (msg) => {
        await ctx.reply(msg, bctx.threadOpts(ctx));
      });
      await bctx.sendResponse(ctx, resultMsg);
    }
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

    // ── Background job wrapper (S46) ────────────────────────────
    const autoPipelineFn = async (progressFn: (msg: string) => Promise<void>): Promise<string> => {
      const result = await runAutoPipeline(bctx.supabase!, task, {
        includeAnalysis: mode === "full",
        onProgress: progressFn,
      });
      return formatPipelineResult(result);
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const threadId = bctx.getThreadId(ctx);
      const jobId = await launchJob("autopipeline", chatId, () => autoPipelineFn(async () => {}), { taskId: task.id, messageThreadId: threadId });
      await ctx.reply(
        `Job lance autopipeline (id: ${jobId})\nTache: ${task.title}\nMode: ${mode}`,
        bctx.threadOpts(ctx)
      );
    } else {
      await ctx.reply(
        `AUTO-PIPELINE lance pour: ${task.title}\nMode: ${mode}\nLe pipeline tourne en autonomie. Notifications a chaque phase.`,
        bctx.threadOpts(ctx)
      );

      const resultMsg = await autoPipelineFn(async (msg) => {
        await ctx.reply(msg, bctx.threadOpts(ctx));
      });
      await bctx.sendResponse(ctx, resultMsg);
    }
  });

  return composer;
}
