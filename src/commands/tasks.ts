/**
 * @module commands/tasks
 * @description Grammy Composer module for task management commands:
 * /task, /backlog, /sprint, /done, /start. Handles task creation,
 * backlog viewing, sprint summaries, and status transitions.
 */

import { Composer, Context } from "grammy";
import type { BotContext } from "../bot-context.ts";
import {
  addTask,
  getBacklog,
  updateTaskStatus,
  getSprintSummary,
  getCurrentSprint,
  formatBacklog,
  formatSprintSummary,
} from "../tasks.ts";
import { resolveProjectContext } from "../projects.ts";
import { notifyTaskStarted, notifyTaskDone } from "../notifications.ts";

export default function tasksCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /task — create a new task
  composer.command("task", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "task");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply("Usage: /task titre de la tache", bctx.threadOpts(ctx));
      return;
    }
    // Resolve project context
    const currentProject = await resolveProjectContext(bctx.supabase, ctx.message?.message_thread_id);
    const projectSlug = currentProject?.slug || "telegram-relay";
    const task = await addTask(bctx.supabase, input, { project: projectSlug, project_id: currentProject?.id });
    if (task) {
      await ctx.reply(`Tache ajoutee: ${task.title}\nProjet: ${projectSlug}\nID: ${task.id.substring(0, 8)}`, bctx.threadOpts(ctx));
    } else {
      await ctx.reply("Erreur lors de l'ajout de la tache.", bctx.threadOpts(ctx));
    }
  });

  // /backlog — view current backlog
  composer.command("backlog", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "backlog");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const filter = ctx.match?.trim();
    if (filter) {
      // Explicit project filter
      const tasks = await getBacklog(bctx.supabase, { project: filter });
      await bctx.sendResponse(ctx, formatBacklog(tasks));
    } else {
      // Auto-scope to current project
      const currentProject = await resolveProjectContext(bctx.supabase, ctx.message?.message_thread_id);
      const tasks = await getBacklog(bctx.supabase, currentProject ? { project_id: currentProject.id } : undefined);
      const header = currentProject ? `Backlog — ${currentProject.name}\n\n` : "";
      await bctx.sendResponse(ctx, header + formatBacklog(tasks));
    }
  });

  // /sprint — view sprint status or assign tasks to a sprint
  composer.command("sprint", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "sprint");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const arg = ctx.match?.trim();

    // Resolve project context for scoping
    const currentProject = await resolveProjectContext(bctx.supabase, ctx.message?.message_thread_id);
    const projectFilter = currentProject ? { project_id: currentProject.id } : {};

    if (!arg) {
      // Show current sprint summary
      const current = currentProject?.current_sprint || await getCurrentSprint(bctx.supabase);
      if (!current) {
        await ctx.reply("Aucun sprint actif. Utilise /sprint S01 pour en creer un.", bctx.threadOpts(ctx));
        return;
      }
      const summary = await getSprintSummary(bctx.supabase, current);
      const tasks = await getBacklog(bctx.supabase, { sprint: current, ...projectFilter });
      const header = currentProject ? `${currentProject.name} — ` : "";
      const text = header + formatSprintSummary(current, summary) + "\n\n" + formatBacklog(tasks, `Taches ${current}`);
      await bctx.sendResponse(ctx, text);
      return;
    }

    // /sprint S01 — show that sprint
    const summary = await getSprintSummary(bctx.supabase, arg);
    const tasks = await getBacklog(bctx.supabase, { sprint: arg, ...projectFilter });
    const header = currentProject ? `${currentProject.name} — ` : "";
    const text = header + formatSprintSummary(arg, summary) + "\n\n" + formatBacklog(tasks, `Taches ${arg}`);
    await bctx.sendResponse(ctx, text);
  });

  // /done — mark a task as done by ID prefix
  composer.command("done", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "done");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const idPrefix = ctx.match?.trim();
    if (!idPrefix) {
      await ctx.reply("Usage: /done <id> (premiers caracteres de l'ID)", bctx.threadOpts(ctx));
      return;
    }

    // Find task by ID prefix
    const { data: matches } = await bctx.supabase
      .from("tasks")
      .select("id, title")
      .like("id", `${idPrefix}%`)
      .neq("status", "done")
      .limit(2);

    if (!matches || matches.length === 0) {
      await ctx.reply(`Aucune tache trouvee avec l'ID commencant par "${idPrefix}".`, bctx.threadOpts(ctx));
      return;
    }
    if (matches.length > 1) {
      await ctx.reply(`Plusieurs taches correspondent. Sois plus precis:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`, bctx.threadOpts(ctx));
      return;
    }

    const updated = await updateTaskStatus(bctx.supabase, matches[0].id, "done");
    if (updated) {
      await ctx.reply(`Fait: ${updated.title}`, bctx.threadOpts(ctx));
      // Notify sprint topic if not already in it
      const currentThread = bctx.getThreadId(ctx);
      const sprintThread = parseInt(process.env.SPRINT_THREAD_ID || "0");
      if (currentThread !== sprintThread) {
        await notifyTaskDone(updated.title, updated.id);
      }
    } else {
      await ctx.reply("Erreur lors de la mise a jour.", bctx.threadOpts(ctx));
    }
  });

  // /start — mark a task as in_progress by ID prefix
  composer.command("start", async (ctx) => {
    // grammY auto-handles /start for new bots, but we override for task management
    if (!bctx.supabase) return;
    const idPrefix = ctx.match?.trim();
    if (!idPrefix) return; // /start without args = normal bot start, do nothing
    const blocked = bctx.commandGuard(ctx, "start");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }

    const { data: matches } = await bctx.supabase
      .from("tasks")
      .select("id, title")
      .like("id", `${idPrefix}%`)
      .eq("status", "backlog")
      .limit(2);

    if (!matches || matches.length === 0) {
      await ctx.reply(`Aucune tache backlog trouvee avec l'ID "${idPrefix}".`, bctx.threadOpts(ctx));
      return;
    }
    if (matches.length > 1) {
      await ctx.reply(`Plusieurs taches correspondent. Sois plus precis:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`, bctx.threadOpts(ctx));
      return;
    }

    const updated = await updateTaskStatus(bctx.supabase, matches[0].id, "in_progress");
    if (updated) {
      await ctx.reply(`En cours: ${updated.title}`, bctx.threadOpts(ctx));
      // Notify sprint topic if not already in it
      const currentThread = bctx.getThreadId(ctx);
      const sprintThread = parseInt(process.env.SPRINT_THREAD_ID || "0");
      if (currentThread !== sprintThread) {
        await notifyTaskStarted(updated.title, updated.id);
      }
    } else {
      await ctx.reply("Erreur lors de la mise a jour.", bctx.threadOpts(ctx));
    }
  });

  return composer;
}
