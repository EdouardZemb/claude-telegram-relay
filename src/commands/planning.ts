/**
 * @module commands/planning
 * @description Grammy Composer module for planning commands:
 * /plan (decompose request into subtasks), /prd (PRD management),
 * /planify (proactive backlog analysis). Also handles PRD-related
 * callback queries (prd_approve, prd_reject, prd_revise) and
 * PRD-to-Deploy workflow callbacks (prdwf_*).
 */

import { Composer, type Context, InlineKeyboard } from "grammy";
import { decomposeTask } from "../agent.ts";
import type { BotContext } from "../bot-context.ts";
import { getSession } from "../conversation-session.ts";
import { shardDocument } from "../document-sharding.ts";
import { isJobManagerEnabled, launch as launchJob, sendProgressMessage } from "../job-manager.ts";
import {
  formatPRDDetail,
  formatPRDList,
  generatePRD,
  getPRD,
  getPRDs,
  savePRD,
  updatePRDStatus,
} from "../prd.ts";
import {
  buildPreflightResultTag,
  buildRevisionKeyboard,
  buildTriageResponse,
  canRevise,
  chatKey,
  clearPendingDescription,
  clearPendingProtoSpec,
  clearPendingRevision,
  decomposePRDIntoTasks,
  extractSessionConstraints,
  generateAndSavePRD,
  getPendingDescription,
  getPendingProtoSpec,
  getRevisionCount,
  isPrdMaturationEnabled,
  isPrdWorkflowEnabled,
  runPrdPreflightChecks,
  storePendingDescription,
  storePendingProtoSpec,
  storePendingRevision,
  triageDescription,
} from "../prd-workflow.ts";
import {
  analyzeBacklog as analyzeBacklogProactive,
  formatPlannerResult as formatPlannerResultTg,
} from "../proactive-planner.ts";
import { resolveProjectContext } from "../projects.ts";
import { buildStoryFile, enrichTaskWithStory } from "../story-files.ts";
import { addTask, getCurrentSprint } from "../tasks.ts";
import { WorkflowTracker } from "../workflow.ts";

export default function planningCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /prd_workflow — conversational PRD-to-Deploy workflow entry point
  composer.command("prd_workflow", async (ctx) => {
    if (!isPrdWorkflowEnabled()) {
      await ctx.reply(
        "Le workflow PRD-to-Deploy n'est pas active. Utilisez /feature enable prd_to_deploy",
        bctx.threadOpts(ctx),
      );
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const description = ctx.match?.trim();
    if (!description) {
      await ctx.reply(
        "Usage: /prd_workflow description de la fonctionnalite",
        bctx.threadOpts(ctx),
      );
      return;
    }
    await ctx.replyWithChatAction("typing");
    const triage = await triageDescription(description, bctx.supabase);
    const { message, keyboard } = buildTriageResponse(description, triage);
    const cId = ctx.chat?.id || 0;
    const tId = bctx.getThreadId(ctx);
    const ck = chatKey(cId, tId);
    storePendingDescription(ck, description);
    await ctx.reply(message, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
  });

  // /plan — decompose a request into subtasks
  composer.command("plan", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "plan");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
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
    const currentProject = await resolveProjectContext(
      bctx.supabase,
      ctx.message?.message_thread_id,
    );
    const projectSlug = currentProject?.slug || "telegram-relay";

    // ── Plan function (shared between sync/async) ──────────────
    const planFn = async (): Promise<string> => {
      const currentSprint =
        currentProject?.current_sprint || (await getCurrentSprint(bctx.supabase!));
      const tracker = new WorkflowTracker(bctx.supabase!, {
        sprintId: currentSprint || undefined,
        startStep: "request",
      });
      await tracker.transition("decomposition", {
        agent_notes: `Plan demande: ${request.substring(0, 100)}`,
      });

      const subtasks = await decomposeTask(request);

      if (subtasks.length === 0) {
        await tracker.logCheckpoint("fail", "Aucune sous-tache generee");
        throw new Error(
          "Impossible de decomposer cette demande. Reformule ou ajoute plus de details.",
        );
      }

      await tracker.logCheckpoint("pass", `${subtasks.length} sous-taches generees`);
      await tracker.transition("validation", {
        agent_notes: `${subtasks.length} sous-taches proposees`,
      });

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
            await bctx
              .supabase!.from("tasks")
              .update({
                acceptance_criteria: st.acceptance_criteria,
              })
              .eq("id", task.id);
            task.acceptance_criteria = st.acceptance_criteria;
          }
          const story = buildStoryFile(task);
          await enrichTaskWithStory(bctx.supabase!, task.id, story);
          added.push(task);
        }
      }

      const lines = added.map((t, i) => {
        const acCount = (t.acceptance_criteria || "")
          .split("\n")
          .filter((l: string) => l.trim()).length;
        return `${i + 1}. P${t.priority} ${t.title} [${t.id.substring(0, 8)}]${acCount > 0 ? ` (${acCount} ACs)` : ""}`;
      });
      return `${added.length} taches ajoutees au backlog avec story files:\n\n${lines.join("\n")}\n\nUtilise /exec <id> pour lancer l'execution d'une tache.`;
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const threadId = bctx.getThreadId(ctx);
      const jobId = await launchJob("plan", chatId, planFn, { messageThreadId: threadId });
      await ctx.reply(
        `Job lance plan (id: ${jobId})\nRequete: ${request.substring(0, 100)}`,
        bctx.threadOpts(ctx),
      );
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
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const input = ctx.match?.trim();

    // Resolve project context
    const currentProject = await resolveProjectContext(
      bctx.supabase,
      ctx.message?.message_thread_id,
    );
    const projectSlug = currentProject?.slug || "telegram-relay";

    // /prd without args or /prd list → list PRDs for current project
    if (!input || /^(list|lister)$/i.test(input)) {
      const prds = await getPRDs(bctx.supabase, { project: projectSlug });
      if (prds.length === 0) {
        await ctx.reply(
          "Aucun PRD. Utilise /prd <description> pour en créer un.",
          bctx.threadOpts(ctx),
        );
        return;
      }
      const text = formatPRDList(prds);
      const keyboard = new InlineKeyboard();
      for (const prd of prds) {
        const label = prd.title.length > 40 ? prd.title.substring(0, 37) + "..." : prd.title;
        keyboard.text(label, `prd_view:${prd.id}`).row();
      }
      await ctx.reply(text, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
      return;
    }

    // /prd <id> (8 chars or less, looks like a UUID prefix) → show detail
    // Also extract hex ID from longer text (e.g. "le PRD c495951a")
    const hexIdMatch = /^[a-f0-9]{4,8}$/.test(input)
      ? input
      : input.match(/\b([a-f0-9]{4,8})\b/)?.[1];
    if (hexIdMatch) {
      const prd = await getPRD(bctx.supabase, hexIdMatch);
      if (!prd) {
        await ctx.reply(`Aucun PRD trouve avec l'ID "${hexIdMatch}".`, bctx.threadOpts(ctx));
        return;
      }
      const detail = formatPRDDetail(prd);
      // Send with validation buttons if still draft
      if (prd.status === "draft") {
        const keyboard = isPrdWorkflowEnabled()
          ? buildRevisionKeyboard(prd)
          : new InlineKeyboard()
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
      } else if (prd.status === "approved") {
        // Check for backlog tasks tagged with this PRD
        const { data: prdTasks } = await bctx
          .supabase!.from("tasks")
          .select("id")
          .contains("tags", [`prd:${prd.id}`])
          .eq("status", "backlog");
        if (prdTasks && prdTasks.length > 0) {
          const keyboard = new InlineKeyboard().text(
            `Lancer l'implementation (${prdTasks.length} taches)`,
            `prdwf_launch:${prd.id.substring(0, 8)}`,
          );
          if (detail.length > 4000) {
            await bctx.sendResponse(ctx, detail);
            await ctx.reply("Actions:", { ...bctx.threadOpts(ctx), reply_markup: keyboard });
          } else {
            await ctx.reply(detail, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
          }
        } else {
          await bctx.sendResponse(ctx, detail);
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

      const currentProjectForShard = await resolveProjectContext(
        bctx.supabase!,
        ctx.message?.message_thread_id,
      );
      await shardDocument(bctx.supabase!, {
        id: prd.id,
        title: prd.title,
        content: prd.content,
        type: "prd",
        project_id: currentProjectForShard?.id,
      });

      return `PRD_CREATED:${prd.id}|${prd.title}`;
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const threadId = bctx.getThreadId(ctx);
      const jobId = await launchJob("prd", chatId, prdCreateFn, { messageThreadId: threadId });
      await ctx.reply(
        `Job lance prd (id: ${jobId})\nDescription: ${input!.substring(0, 100)}`,
        bctx.threadOpts(ctx),
      );
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
        await ctx.reply(
          error.message || "Erreur lors de la generation du PRD.",
          bctx.threadOpts(ctx),
        );
      }
    }
  });

  // /planify — proactive backlog analysis and reordering
  composer.command("planify", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "planify");
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

    const planifyFn = async (): Promise<string> => {
      const result = await analyzeBacklogProactive(bctx.supabase!, sprintId);
      return formatPlannerResultTg(result);
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const threadId = bctx.getThreadId(ctx);
      const jobId = await launchJob("planify", chatId, planifyFn, { messageThreadId: threadId });
      await ctx.reply(`Job lance planify (id: ${jobId})`, bctx.threadOpts(ctx));
    } else {
      await ctx.replyWithChatAction("typing");
      const resultMsg = await planifyFn();
      await bctx.sendResponse(ctx, resultMsg);
    }
  });

  // ── PRD Workflow Callbacks (prdwf_*) ────────────────────────
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    // Handle PRD workflow callbacks
    if (data.startsWith("prdwf_")) {
      if (!bctx.supabase) {
        await ctx.answerCallbackQuery({ text: "Supabase non configure." });
        return;
      }

      const cId = ctx.chat?.id || 0;
      const tId = ctx.callbackQuery.message?.message_thread_id;
      const ck = chatKey(cId, tId);

      if (data === "prdwf_create") {
        // F1 -> F2: User chose "Creer le PRD"
        await ctx.answerCallbackQuery({ text: "Generation du PRD..." });
        const description = getPendingDescription(ck);
        if (!description) {
          await ctx.editMessageText("Description expirée. Renvoie ta demande.");
          return;
        }

        const currentProject = await resolveProjectContext(bctx.supabase, tId);
        const projectSlug = currentProject?.slug || "telegram-relay";
        const session = getSession(cId, tId);
        const constraints = extractSessionConstraints(session.constraints);

        const prdCreateFn = async (): Promise<string> => {
          const prd = await generateAndSavePRD(
            bctx.supabase!,
            description,
            projectSlug,
            ctx.from?.first_name || "unknown",
            constraints,
            tId,
          );
          if (!prd) throw new Error("Impossible de generer le PRD.");
          return `PRD_CREATED:${prd.id}|${prd.title}`;
        };

        if (isJobManagerEnabled()) {
          const jobId = await launchJob("prd", cId, prdCreateFn, { messageThreadId: tId });
          await ctx.editMessageText(`Generation du PRD en cours... (job: ${jobId})`);
        } else {
          await ctx.editMessageText("Generation du PRD en cours...");
          try {
            const resultTag = await prdCreateFn();
            const prdId = resultTag.replace("PRD_CREATED:", "").split("|")[0];
            const prd = await getPRD(bctx.supabase, prdId);
            if (prd) {
              const detail = formatPRDDetail(prd);
              const keyboard = buildRevisionKeyboard(prd);
              if (detail.length > 4000) {
                await bctx.sendResponse(ctx, detail);
                await ctx.reply("Actions:", { ...bctx.threadOpts(ctx), reply_markup: keyboard });
              } else {
                await ctx.reply(detail, { ...bctx.threadOpts(ctx), reply_markup: keyboard });
              }
              // Update session
              session.activePrdId = prd.id;
              session.prdWorkflowStep = "generation";
            }
          } catch (error: any) {
            await ctx.reply(error.message || "Erreur lors de la generation.", bctx.threadOpts(ctx));
          }
        }
        clearPendingDescription(ck);
        return;
      }

      if (data === "prdwf_task") {
        // F1: User chose "Juste une tache" — create task directly
        await ctx.answerCallbackQuery({ text: "Creation de la tache..." });
        const description = getPendingDescription(ck);
        if (!description) {
          await ctx.editMessageText("Description expiree. Renvoie ta demande.");
          return;
        }

        const currentProject = await resolveProjectContext(bctx.supabase, tId);
        const projectSlug = currentProject?.slug || "telegram-relay";
        const title = description.length > 100 ? description.substring(0, 97) + "..." : description;

        const task = await addTask(bctx.supabase, title, {
          description,
          priority: 3,
          project: projectSlug,
          project_id: currentProject?.id,
        });

        if (task) {
          await ctx.editMessageText(
            `Tache creee : ${task.title} [${task.id.substring(0, 8)}]\n\nUtilise /exec ${task.id.substring(0, 8)} pour lancer l'implementation.`,
          );
        } else {
          await ctx.editMessageText("Erreur lors de la creation de la tache.");
        }
        clearPendingDescription(ck);
        return;
      }

      if (data === "prdwf_cancel") {
        await ctx.answerCallbackQuery({ text: "Annule." });
        await ctx.editMessageText("Workflow annulé.");
        clearPendingDescription(ck);
        clearPendingRevision(ck);
        return;
      }

      if (data.startsWith("prdwf_revise:")) {
        // F3: User wants revision
        const prdId = data.replace("prdwf_revise:", "");
        const prd = await getPRD(bctx.supabase, prdId);
        if (!prd) {
          await ctx.answerCallbackQuery({ text: "PRD introuvable." });
          return;
        }
        if (!canRevise(prd)) {
          await ctx.answerCallbackQuery({ text: "Nombre max de revisions atteint." });
          return;
        }
        const revCount = getRevisionCount(prd);
        const session = getSession(cId, tId);
        const constraints = extractSessionConstraints(session.constraints);
        storePendingRevision(ck, prd.id, constraints);

        await ctx.answerCallbackQuery({ text: "Envoie tes modifications." });
        await ctx.editMessageText(
          `PRD en révision [${prdId.substring(0, 8)}] (${revCount + 1}/${3})\n\nDécris les modifications souhaitées. Je régénérerai le PRD.`,
        );
        return;
      }

      if (data.startsWith("prdwf_launch:")) {
        // F5: User confirms implementation launch — run ALL PRD tasks
        const prdPrefix = data.replace("prdwf_launch:", "");
        const prd = await getPRD(bctx.supabase, prdPrefix);
        if (!prd) {
          await ctx.answerCallbackQuery({ text: "PRD introuvable." });
          return;
        }
        await ctx.answerCallbackQuery({ text: "Lancement..." });

        // Get tasks tagged with this PRD (created by decomposePRDIntoTasks)
        const { data: tasks } = await bctx.supabase
          .from("tasks")
          .select("*")
          .contains("tags", [`prd:${prd.id}`])
          .eq("status", "backlog")
          .order("priority", { ascending: true });

        if (!tasks || tasks.length === 0) {
          await ctx.editMessageText(
            "Aucune tâche en backlog pour ce PRD. Lance /backlog pour vérifier.",
          );
          return;
        }

        // Launch batch pipeline for ALL PRD tasks via job manager
        if (isJobManagerEnabled()) {
          const { runBatchPipeline, formatPipelineResult } = await import("../auto-pipeline.ts");
          // R5: Capture chatId and threadId before closure
          const capturedChatId = cId;
          const capturedThreadId = tId;
          const launchFn = async (): Promise<string> => {
            // R4/R16: onProgress sends one message per completed task
            const onProgress = async (msg: string) => {
              await sendProgressMessage(capturedChatId, capturedThreadId, msg);
            };
            const results = await runBatchPipeline(bctx.supabase!, tasks, {
              autoPipeline: true,
              onProgress,
            });
            const ok = results.filter((r) => r.success).length;
            // R9/R15: Collect failed IDs including non-executed tasks
            const executedIds = new Set(results.map((r) => r.task.id));
            const failedIds = results
              .filter((r) => !r.success)
              .map((r) => r.task.id.substring(0, 8));
            // R15: Include tasks that were not executed (early stop in sequential mode)
            for (const t of tasks) {
              if (!executedIds.has(t.id)) {
                failedIds.push(t.id.substring(0, 8));
              }
            }
            const lines = results.map((r) => formatPipelineResult(r));
            return `BATCH_COMPLETE:${ok}/${tasks.length}:failed=${failedIds.join(",")}\n\n${lines.join("\n\n---\n\n")}`;
          };
          const taskList = tasks
            .map((t: any, i: number) => `${i + 1}. ${t.title} [${t.id.substring(0, 8)}]`)
            .join("\n");
          const jobId = await launchJob("autopipeline-batch", capturedChatId, launchFn, {
            messageThreadId: capturedThreadId,
          });
          await ctx.editMessageText(
            `Implémentation lancée pour ${tasks.length} tâches (job: ${jobId})\n\n${taskList}`,
          );
        } else {
          await ctx.editMessageText(
            "Le job manager n'est pas actif. Active-le avec /feature enable job_manager puis relance.",
          );
        }
        return;
      }

      if (data.startsWith("prdwf_merge:")) {
        // F7: User wants to merge PR
        const prNumber = data.replace("prdwf_merge:", "");
        await ctx.answerCallbackQuery({ text: "Merge en cours..." });

        try {
          const { spawnSync } = await import("bun");
          const result = spawnSync(["gh", "pr", "merge", prNumber, "--merge", "--delete-branch"], {
            cwd: process.env.PROJECT_DIR || process.cwd(),
            timeout: 30_000,
          });
          const success = result.exitCode === 0;
          await ctx.editMessageText(
            success
              ? `PR #${prNumber} mergée avec succès !`
              : `Erreur lors du merge de la PR #${prNumber}. Vérifie sur GitHub.`,
          );
        } catch {
          await ctx.editMessageText(`Erreur lors du merge de la PR #${prNumber}.`);
        }
        return;
      }

      if (data === "prdwf_preflight_ok") {
        // Preflight accepted: launch implementation batch (V9)
        await ctx.answerCallbackQuery({ text: "Lancement..." });

        // Retrieve prdId from pending proto-specs
        const pending = getPendingProtoSpec(ck);
        if (!pending) {
          await ctx.editMessageText("Données de preflight expirées. Relance le workflow.");
          return;
        }

        // Get tasks tagged with this PRD
        const { data: tasks } = await bctx.supabase
          .from("tasks")
          .select("*")
          .contains("tags", [`prd:${pending.prdId}`])
          .eq("status", "backlog")
          .order("priority", { ascending: true });

        if (!tasks || tasks.length === 0) {
          await ctx.editMessageText("Aucune tâche en backlog pour ce PRD.");
          clearPendingProtoSpec(ck);
          return;
        }

        // Launch batch pipeline via job manager (same pattern as prdwf_launch)
        if (isJobManagerEnabled()) {
          const { runBatchPipeline, formatPipelineResult } = await import("../auto-pipeline.ts");
          // R5: Capture chatId and threadId before closure
          const capturedChatId = cId;
          const capturedThreadId = tId;
          const launchFn = async (): Promise<string> => {
            // R4/R16: onProgress sends one message per completed task
            const onProgress = async (msg: string) => {
              await sendProgressMessage(capturedChatId, capturedThreadId, msg);
            };
            const results = await runBatchPipeline(bctx.supabase!, tasks, {
              autoPipeline: true,
              onProgress,
            });
            const ok = results.filter((r) => r.success).length;
            // R9/R15: Collect failed IDs including non-executed tasks
            const executedIds = new Set(results.map((r) => r.task.id));
            const failedIds = results
              .filter((r) => !r.success)
              .map((r) => r.task.id.substring(0, 8));
            // R15: Include tasks that were not executed (early stop in sequential mode)
            for (const t of tasks) {
              if (!executedIds.has(t.id)) {
                failedIds.push(t.id.substring(0, 8));
              }
            }
            const lines = results.map((r) => formatPipelineResult(r));
            return `BATCH_COMPLETE:${ok}/${tasks.length}:failed=${failedIds.join(",")}\n\n${lines.join("\n\n---\n\n")}`;
          };
          const taskList = tasks
            .map((t: any, i: number) => `${i + 1}. ${t.title} [${t.id.substring(0, 8)}]`)
            .join("\n");
          const jobId = await launchJob("autopipeline-batch", capturedChatId, launchFn, {
            messageThreadId: capturedThreadId,
          });
          await ctx.editMessageText(
            `Implémentation lancée pour ${tasks.length} tâches (job: ${jobId})\n\n${taskList}`,
          );
        } else {
          await ctx.editMessageText(
            "Le job manager n'est pas actif. Active-le avec /feature enable job_manager puis relance.",
          );
        }
        clearPendingProtoSpec(ck);
        return;
      }

      if (data === "prdwf_preflight_abort") {
        // Preflight aborted: cancel workflow (V10)
        await ctx.answerCallbackQuery({ text: "Annule." });
        await ctx.editMessageText("Workflow annulé. Le PRD et les tâches restent dans le backlog.");
        // Clean up all pending state (V20)
        clearPendingProtoSpec(ck);
        clearPendingDescription(ck);
        clearPendingRevision(ck);
        return;
      }

      if (data === "prdwf_revise_prd") {
        // Preflight revision: redirect to PRD revision flow (V11, R10)
        await ctx.answerCallbackQuery({ text: "Envoie tes modifications." });
        const pending = getPendingProtoSpec(ck);
        if (!pending) {
          await ctx.editMessageText("Données de preflight expirées. Relance le workflow.");
          return;
        }

        // Store pending revision with prdId (reuse existing revision flow)
        const session = getSession(cId, tId);
        const constraints = extractSessionConstraints(session.constraints);
        storePendingRevision(ck, pending.prdId, constraints);
        clearPendingProtoSpec(ck);

        await ctx.editMessageText(
          `PRD en revision [${pending.prdId.substring(0, 8)}]\n\nLe challenge adversarial a identifié des problèmes. Décris les modifications souhaitées. Je régénérerai le PRD.`,
        );
        return;
      }

      // Not a prdwf_ callback we handle
      await next();
      return;
    }

    // Handle existing PRD callbacks
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

    if (action === "prd_view") {
      const prd = await getPRD(bctx.supabase, prdId);
      if (!prd) {
        await ctx.answerCallbackQuery({ text: "PRD introuvable." });
        return;
      }
      await ctx.answerCallbackQuery();
      const detail = formatPRDDetail(prd);
      if (prd.status === "draft") {
        const actionKeyboard = isPrdWorkflowEnabled()
          ? buildRevisionKeyboard(prd)
          : new InlineKeyboard()
              .text("Approuver", `prd_approve:${prd.id}`)
              .text("Rejeter", `prd_reject:${prd.id}`)
              .row()
              .text("Modifier", `prd_revise:${prd.id}`);
        if (detail.length > 4000) {
          await bctx.sendResponse(ctx, detail);
          await ctx.reply("Actions:", { ...bctx.threadOpts(ctx), reply_markup: actionKeyboard });
        } else {
          await ctx.reply(detail, { ...bctx.threadOpts(ctx), reply_markup: actionKeyboard });
        }
      } else if (prd.status === "approved") {
        const { data: prdTasks } = await bctx
          .supabase!.from("tasks")
          .select("id")
          .contains("tags", [`prd:${prd.id}`])
          .eq("status", "backlog");
        if (prdTasks && prdTasks.length > 0) {
          const launchKeyboard = new InlineKeyboard().text(
            `Lancer l'implementation (${prdTasks.length} taches)`,
            `prdwf_launch:${prd.id.substring(0, 8)}`,
          );
          if (detail.length > 4000) {
            await bctx.sendResponse(ctx, detail);
            await ctx.reply("Actions:", { ...bctx.threadOpts(ctx), reply_markup: launchKeyboard });
          } else {
            await ctx.reply(detail, { ...bctx.threadOpts(ctx), reply_markup: launchKeyboard });
          }
        } else {
          await bctx.sendResponse(ctx, detail);
        }
      } else {
        await bctx.sendResponse(ctx, detail);
      }
      return;
    } else if (action === "prd_approve") {
      const updated = await updatePRDStatus(bctx.supabase, prdId, "approved");
      if (updated) {
        await ctx.answerCallbackQuery({ text: "PRD approuve !" });

        // Auto-decompose PRD into tasks as background job
        if (isJobManagerEnabled()) {
          const prd = await getPRD(bctx.supabase, prdId);
          if (prd) {
            const projectSlug = prd.project || "telegram-relay";
            const threadId = ctx.callbackQuery.message?.message_thread_id;
            const currentProject = await resolveProjectContext(bctx.supabase, threadId);

            if (isPrdWorkflowEnabled()) {
              // PRD-to-Deploy workflow: decompose then optionally run preflight (R1)
              const chatId = ctx.chat?.id || 0;
              const cbThreadId = ctx.callbackQuery.message?.message_thread_id;

              if (isPrdMaturationEnabled()) {
                // Maturation enabled: decompose then preflight (R1)
                const decomposeThenPreflightFn = async (): Promise<string> => {
                  const result = await decomposePRDIntoTasks(
                    bctx.supabase!,
                    prd,
                    projectSlug,
                    currentProject?.id,
                  );
                  if (result.tasks.length === 0) {
                    return `PRDWF_DECOMPOSED:${prd.id}|0|Aucune tache generee`;
                  }

                  // Fetch full tasks for preflight
                  const { data: fullTasks } = await bctx
                    .supabase!.from("tasks")
                    .select("*")
                    .contains("tags", [`prd:${prd.id}`])
                    .eq("status", "backlog");

                  if (!fullTasks || fullTasks.length === 0) {
                    return `PRDWF_DECOMPOSED:${prd.id}|${result.tasks.length}|${result.message}`;
                  }

                  // Run preflight checks (P1+P2+E1)
                  const report = await runPrdPreflightChecks(prd, fullTasks);

                  // Store proto-specs for later use (R8)
                  const ck = chatKey(chatId, cbThreadId);
                  storePendingProtoSpec(ck, prd.id, report.protoSpecs);

                  // Build result tag for job-manager (R14)
                  return buildPreflightResultTag(report);
                };

                const jobId = await launchJob("prd-preflight", chatId, decomposeThenPreflightFn, {
                  messageThreadId: cbThreadId,
                });
                await ctx.editMessageText(
                  `PRD APPROUVE : ${updated.title} [${updated.id.substring(0, 8)}]\n\nDecomposition et verification en cours (job: ${jobId}). Tu recevras un rapport de pre-lancement avec les resultats.`,
                );
              } else {
                // No maturation: decompose then offer launch (existing behavior)
                const decomposeFn = async (): Promise<string> => {
                  const result = await decomposePRDIntoTasks(
                    bctx.supabase!,
                    prd,
                    projectSlug,
                    currentProject?.id,
                  );
                  return `PRDWF_DECOMPOSED:${prd.id}|${result.tasks.length}|${result.message}`;
                };

                const jobId = await launchJob("prd-decompose", chatId, decomposeFn, {
                  messageThreadId: cbThreadId,
                });
                await ctx.editMessageText(
                  `PRD APPROUVE : ${updated.title} [${updated.id.substring(0, 8)}]\n\nDecomposition en taches lancee (job: ${jobId}). Tu recevras une notification avec les taches et l'option de lancer l'implementation.`,
                );
              }
            } else {
              // Legacy flow
              const decomposeFn = async (): Promise<string> => {
                const prdDescription = `PRD: ${prd.title}\n${prd.summary || ""}\n\n${prd.content}`;
                const subtasks = await decomposeTask(prdDescription);

                if (subtasks.length === 0) {
                  throw new Error("Aucune sous-tache generee depuis le PRD.");
                }

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
                      await bctx
                        .supabase!.from("tasks")
                        .update({
                          acceptance_criteria: st.acceptance_criteria,
                        })
                        .eq("id", task.id);
                      task.acceptance_criteria = st.acceptance_criteria;
                    }
                    const story = buildStoryFile(task);
                    await enrichTaskWithStory(bctx.supabase!, task.id, story);
                    added.push(task);
                  }
                }

                const lines = added.map((t, i) => {
                  const acCount = (t.acceptance_criteria || "")
                    .split("\n")
                    .filter((l: string) => l.trim()).length;
                  return `${i + 1}. P${t.priority} ${t.title} [${t.id.substring(0, 8)}]${acCount > 0 ? ` (${acCount} ACs)` : ""}`;
                });
                return `${added.length} tâches créées depuis le PRD "${prd.title}":\n${lines.join("\n")}`;
              };

              const chatId = ctx.chat?.id || 0;
              const cbThreadId = ctx.callbackQuery.message?.message_thread_id;
              const jobId = await launchJob("prd-decompose", chatId, decomposeFn, {
                messageThreadId: cbThreadId,
              });
              await ctx.editMessageText(
                `PRD APPROUVE: ${updated.title} [${updated.id.substring(0, 8)}]\n\nDecomposition en taches lancee en arriere-plan (job: ${jobId}).`,
              );
            }
          } else {
            await ctx.editMessageText(
              `PRD APPROUVE: ${updated.title} [${updated.id.substring(0, 8)}]\n\nLe PRD est maintenant pret pour l'implementation. Utilise /plan pour decomposer en taches.`,
            );
          }
        } else {
          await ctx.editMessageText(
            `PRD APPROUVE: ${updated.title} [${updated.id.substring(0, 8)}]\n\nLe PRD est maintenant pret pour l'implementation. Utilise /plan pour decomposer en taches.`,
          );
        }
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur." });
      }
    } else if (action === "prd_reject") {
      const updated = await updatePRDStatus(bctx.supabase, prdId, "rejected");
      if (updated) {
        await ctx.answerCallbackQuery({ text: "PRD rejete." });
        await ctx.editMessageText(
          `PRD REJETE: ${updated.title} [${updated.id.substring(0, 8)}]\n\nCree un nouveau PRD avec /prd si tu veux reprendre.`,
        );
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur." });
      }
    } else if (action === "prd_revise") {
      await ctx.answerCallbackQuery({ text: "Envoie tes modifications." });
      await ctx.editMessageText(
        `PRD en revision [${prdId.substring(0, 8)}]\n\nDecris les modifications souhaitees dans un message. Je regenererai le PRD avec tes retours.`,
      );
    }
  });

  return composer;
}
