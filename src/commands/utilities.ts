/**
 * @module commands/utilities
 * @description Composer for utility commands: /speak, /export, /feature, /estimate, /rollback.
 * Also handles gate override callbacks (gate_override, gate_cancel) and
 * notification action callbacks (notif_*).
 */

import { Composer, type Context, InputFile } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { synthesize } from "../tts.ts";
import { setFeature, formatFeatures } from "../feature-flags.ts";
import { estimateSprintCost, formatCostEstimate } from "../cost-estimate.ts";
import { overrideGate } from "../gates.ts";
import { updateTaskStatus, getCurrentSprint, getSprintSummary, formatSprintSummary } from "../tasks.ts";
import { getIdea, promoteIdea, archiveIdea } from "../memory.ts";
import { launch as launchJob, isJobManagerEnabled } from "../job-manager.ts";

export default function utilitiesComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /speak
  composer.command("speak", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "speak");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    const text = ctx.match?.trim();

    await ctx.replyWithChatAction("record_voice");

    if (text) {
      const audioBuffer = await synthesize(text);
      if (audioBuffer) {
        await ctx.replyWithVoice(new InputFile(audioBuffer, "voice.ogg"), bctx.threadOpts(ctx));
      } else {
        await ctx.reply("TTS is not configured. Set TTS_PROVIDER=local and PIPER_* vars in .env.", bctx.threadOpts(ctx));
      }
      return;
    }

    if (!bctx.supabase) {
      await ctx.reply("Supabase not configured — cannot retrieve last message.", bctx.threadOpts(ctx));
      return;
    }

    const { data } = await bctx.supabase
      .from("messages")
      .select("content")
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!data?.content) {
      await ctx.reply("No previous assistant message found.", bctx.threadOpts(ctx));
      return;
    }

    const audioBuffer = await synthesize(data.content.substring(0, 4000));
    if (audioBuffer) {
      await ctx.replyWithVoice(new InputFile(audioBuffer, "voice.ogg"), bctx.threadOpts(ctx));
    } else {
      await ctx.reply("TTS is not configured. Set TTS_PROVIDER=local and PIPER_* vars in .env.", bctx.threadOpts(ctx));
    }
  });

  // /export
  composer.command("export", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "export");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    await ctx.replyWithChatAction("upload_document");

    try {
      const [messagesResult, memoryResult, tasksResult] = await Promise.all([
        bctx.supabase.from("messages").select("role, content, created_at").order("created_at", { ascending: true }),
        bctx.supabase.from("memory").select("type, content, created_at"),
        bctx.supabase.from("tasks").select("title, description, status, priority, sprint, created_at, completed_at").order("priority", { ascending: true }),
      ]);

      const exportData = {
        exported_at: new Date().toISOString(),
        messages: messagesResult.data || [],
        memory: memoryResult.data || [],
        tasks: tasksResult.data || [],
      };

      const json = JSON.stringify(exportData, null, 2);
      const buffer = Buffer.from(json, "utf-8");
      const filename = `export_${new Date().toISOString().split("T")[0]}.json`;

      await ctx.replyWithDocument(new InputFile(buffer, filename), {
        caption: `Export: ${exportData.messages.length} messages, ${exportData.memory.length} memories, ${exportData.tasks.length} taches`,
        ...bctx.threadOpts(ctx),
      });
    } catch (error) {
      console.error("Export error:", error);
      await ctx.reply("Erreur lors de l'export.", bctx.threadOpts(ctx));
    }
  });

  // /feature
  composer.command("feature", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "feature");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }

    const input = ctx.match?.trim() || "";
    const parts = input.split(/\s+/);
    const sub = parts[0]?.toLowerCase();

    if (!sub || sub === "list") {
      await ctx.reply(formatFeatures(), bctx.threadOpts(ctx));
      return;
    }

    if (sub === "enable" && parts[1]) {
      setFeature(parts[1], true);
      await ctx.reply(`Feature "${parts[1]}" activee.`, bctx.threadOpts(ctx));
      return;
    }

    if (sub === "disable" && parts[1]) {
      setFeature(parts[1], false);
      await ctx.reply(`Feature "${parts[1]}" desactivee.`, bctx.threadOpts(ctx));
      return;
    }

    await ctx.reply("Usage: /feature [list|enable <flag>|disable <flag>]", bctx.threadOpts(ctx));
  });

  // /estimate
  composer.command("estimate", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "estimate");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }

    const input = ctx.match?.trim() || "";
    const parts = input.split(/\s+/);
    const taskCount = parseInt(parts[0] || "0", 10);
    const pipeline = parts[1]?.toUpperCase() || "DEFAULT";

    if (!taskCount || taskCount < 1) {
      await ctx.reply("Usage: /estimate <nombre_taches> [pipeline]\nPipelines: DEFAULT, QUICK, REVIEW", bctx.threadOpts(ctx));
      return;
    }

    try {
      const result = await estimateSprintCost(bctx.supabase, taskCount, pipeline);
      await ctx.reply(formatCostEstimate(result), bctx.threadOpts(ctx));
    } catch (error) {
      console.error("Estimate error:", error);
      await ctx.reply("Erreur lors de l'estimation.", bctx.threadOpts(ctx));
    }
  });

  // /rollback
  composer.command("rollback", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "rollback");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }

    const reason = ctx.match?.trim() || "rollback manuel via Telegram";

    const rollbackFn = async (): Promise<string> => {
      const { spawn } = await import("bun");
      const proc = spawn(["bash", "./scripts/rollback.sh", reason], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        return `Rollback termine avec succes.\n\n${stdout.trim().slice(-500)}`;
      }
      throw new Error(`Rollback echoue (exit ${exitCode}).\n\n${stdout.trim().slice(-500)}`);
    };

    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const jobId = await launchJob("rollback", chatId, rollbackFn);
      await ctx.reply(`Job lance rollback (id: ${jobId})`, bctx.threadOpts(ctx));
    } else {
      await ctx.reply("Rollback en cours...", bctx.threadOpts(ctx));
      try {
        const resultMsg = await rollbackFn();
        await ctx.reply(resultMsg, bctx.threadOpts(ctx));
      } catch (error: any) {
        console.error("Rollback error:", error);
        await ctx.reply(error.message || "Erreur lors du rollback.", bctx.threadOpts(ctx));
      }
    }
  });

  // Gate override callbacks
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("gate_")) { await next(); return; }

    const parts = data.split(":");
    const action = parts[0];
    const taskId = parts[1];

    if (action === "gate_override" && taskId && bctx.supabase) {
      const gateName = parts.slice(2).join(":");
      await overrideGate(bctx.supabase, taskId, gateName);

      await ctx.answerCallbackQuery({ text: "Gate bypassed." });
      await ctx.editMessageText(
        `Gate bypassed: ${gateName}\n\nRelance /exec ${taskId.substring(0, 8)} pour executer la tache.`,
      );
    } else if (action === "gate_cancel" && taskId) {
      await ctx.answerCallbackQuery({ text: "Execution annulee." });
      await ctx.editMessageText(
        `Execution annulee. Resous la gate avant de relancer /exec.`,
      );
    }
  });

  // Notification action callbacks (notif_*)
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("notif_")) { await next(); return; }

    const [action, id] = data.split(":");

    try {
      if (action === "notif_start" && id && bctx.supabase) {
        const updated = await updateTaskStatus(bctx.supabase, id, "in_progress");
        if (updated) {
          await ctx.answerCallbackQuery({ text: "Tache demarree !" });
          await ctx.editMessageText(`Tache demarree : ${updated.title}`);
        } else {
          await ctx.answerCallbackQuery({ text: "Action expiree." });
        }
      } else if (action === "notif_done" && id && bctx.supabase) {
        const updated = await updateTaskStatus(bctx.supabase, id, "done");
        if (updated) {
          await ctx.answerCallbackQuery({ text: "Tache terminee !" });
          await ctx.editMessageText(`Tache terminee : ${updated.title}`);
        } else {
          await ctx.answerCallbackQuery({ text: "Action expiree." });
        }
      } else if (action === "notif_view" && id && bctx.supabase) {
        const { data: tasks } = await bctx.supabase
          .from("tasks")
          .select("*")
          .or(`id.eq.${id},id.like.${id}%`)
          .limit(1);
        if (tasks && tasks[0]) {
          const t = tasks[0];
          await ctx.answerCallbackQuery();
          await ctx.editMessageText(
            `${t.title}\nStatut: ${t.status}\nPriorite: ${t.priority || "N/A"}\nSprint: ${t.sprint || "N/A"}\n${t.description || ""}`,
          );
        } else {
          await ctx.answerCallbackQuery({ text: "Tache introuvable." });
        }
      } else if (action === "notif_viewtask" && id && bctx.supabase) {
        const { data: tasks } = await bctx.supabase
          .from("tasks")
          .select("*")
          .or(`id.eq.${id},id.like.${id}%`)
          .limit(1);
        if (tasks && tasks[0]) {
          const t = tasks[0];
          await ctx.answerCallbackQuery();
          await ctx.editMessageText(
            `${t.title}\nStatut: ${t.status}\nPriorite: ${t.priority || "N/A"}`,
          );
        } else {
          await ctx.answerCallbackQuery({ text: "Tache introuvable." });
        }
      } else if (action === "notif_promote" && id && bctx.supabase) {
        const idea = await getIdea(bctx.supabase, id);
        if (idea) {
          const result = await promoteIdea(bctx.supabase, id);
          if (result) {
            await ctx.answerCallbackQuery({ text: "Idee promue !" });
            await ctx.editMessageText(`Idee promue en tache : ${result.title || idea.content?.substring(0, 60)}`);
          } else {
            await ctx.answerCallbackQuery({ text: "Erreur lors de la promotion." });
          }
        } else {
          await ctx.answerCallbackQuery({ text: "Action expiree." });
        }
      } else if (action === "notif_archive" && id && bctx.supabase) {
        const idea = await getIdea(bctx.supabase, id);
        if (idea) {
          await archiveIdea(bctx.supabase, id);
          await ctx.answerCallbackQuery({ text: "Idee archivee." });
          await ctx.editMessageText("Idee archivee.");
        } else {
          await ctx.answerCallbackQuery({ text: "Action expiree." });
        }
      } else if (action === "notif_sprint") {
        if (bctx.supabase) {
          const sprintId = await getCurrentSprint(bctx.supabase);
          if (sprintId) {
            const summary = await getSprintSummary(bctx.supabase, sprintId);
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(summary ? formatSprintSummary(summary) : "Sprint non trouve.");
          } else {
            await ctx.answerCallbackQuery({ text: "Pas de sprint actif." });
          }
        }
      } else if (action === "notif_dismiss") {
        await ctx.answerCallbackQuery({ text: "Ignore." });
        await ctx.editMessageText("Notification ignoree.");
      } else {
        await ctx.answerCallbackQuery();
      }
    } catch (error) {
      console.error("Notification callback error:", error);
      await ctx.answerCallbackQuery({ text: "Action expiree." });
    }
  });

  return composer;
}
