/**
 * @module commands/tasks
 * @description Grammy Composer module for task management commands:
 * /task, /backlog, /sprint, /done, /start. Handles task creation,
 * backlog viewing, sprint summaries, and status transitions.
 */

import { Composer, type Context } from "grammy";
import { z } from "zod";
import type { BotContext } from "../bot-context.ts";
import { escapeHtml } from "../bot-context.ts";
import { getConfig } from "../config.ts";
import { buildOnboardingKeyboard } from "../inline-menus.ts";
import { enqueue } from "../notification-queue.ts";
import { err, ok, type Result } from "../result.ts";

// R10: Zod schema for /task command — validate extracted fields (not raw string)
// Note: --hours excluded per adversarial F-DA-2 — addTask does not accept estimated_hours in opts
export const TaskCommandSchema = z.object({
  title: z.string().min(1, "Le titre est requis"),
  desc: z.string().optional(),
  priority: z.coerce
    .number()
    .int()
    .min(1, "La priorite doit etre entre 1 et 5")
    .max(5, "La priorite doit etre entre 1 et 5")
    .optional(),
});

type TaskCommandArgs = z.infer<typeof TaskCommandSchema>;

/**
 * Parse /task input string into structured args via Zod validation.
 * Returns Result<TaskCommandArgs, z.ZodError>.
 */
export function parseTaskCommand(input: string): Result<TaskCommandArgs, z.ZodError> {
  // Extract --desc <value>
  const descMatch = input.match(/--desc\s+([^-][^\s-]*(?:\s+[^-][^\s-]*)*?)(?=\s+--|$)/);
  const desc = descMatch?.[1]?.trim();

  // Extract --priority <n>
  const priorityMatch = input.match(/--priority\s+(\S+)/);
  const priorityRaw = priorityMatch?.[1];

  // Title is input with flags stripped
  const title = input
    .replace(/--desc\s+[^-][^\s-]*(?:\s+[^-][^\s-]*)*/g, "")
    .replace(/--priority\s+\S+/g, "")
    .trim();

  const raw: Record<string, unknown> = { title };
  if (desc !== undefined) raw.desc = desc;
  if (priorityRaw !== undefined) raw.priority = priorityRaw;

  const parsed = TaskCommandSchema.safeParse(raw);
  if (!parsed.success) return err(parsed.error);
  return ok(parsed.data);
}

import { resolveProjectContext } from "../projects.ts";
import {
  addTask,
  formatBacklog,
  formatSprintSummary,
  getBacklog,
  getCurrentSprint,
  getSprintSummary,
  updateTaskStatus,
} from "../tasks.ts";

export default function tasksCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /task — create a new task
  composer.command("task", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "task");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply(
        "Usage: /task <titre> [--desc <description>] [--priority <1-5>]",
        bctx.threadOpts(ctx),
      );
      return;
    }
    // R10: Validate input via Zod schema before calling addTask
    const parsed = parseTaskCommand(input);
    if (!parsed.ok) {
      const msg = parsed.error.issues[0]?.message || "Parametres invalides";
      await ctx.reply(
        `Erreur: ${msg}\nUsage: /task <titre> [--desc <description>] [--priority <1-5>]`,
        bctx.threadOpts(ctx),
      );
      return;
    }
    // Resolve project context
    const currentProject = await resolveProjectContext(
      bctx.supabase,
      ctx.message?.message_thread_id,
    );
    const projectSlug = currentProject?.slug || "telegram-relay";
    const task = await addTask(bctx.supabase, parsed.value.title, {
      project: projectSlug,
      project_id: currentProject?.id,
      ...(parsed.value.desc !== undefined && { description: parsed.value.desc }),
      ...(parsed.value.priority !== undefined && { priority: parsed.value.priority }),
    });
    if (task) {
      await ctx.reply(
        `Tache ajoutee: ${task.title}\nProjet: ${projectSlug}\nID: ${task.id.substring(0, 8)}`,
        bctx.threadOpts(ctx),
      );
    } else {
      await ctx.reply("Erreur lors de l'ajout de la tache.", bctx.threadOpts(ctx));
    }
  });

  // /backlog — view current backlog
  composer.command("backlog", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "backlog");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const filter = ctx.match?.trim();
    if (filter) {
      // Explicit project filter
      const tasks = await getBacklog(bctx.supabase, { project: filter });
      await bctx.sendResponseHtml(ctx, formatBacklog(tasks));
    } else {
      // Auto-scope to current project
      const currentProject = await resolveProjectContext(
        bctx.supabase,
        ctx.message?.message_thread_id,
      );
      const tasks = await getBacklog(
        bctx.supabase,
        currentProject ? { project_id: currentProject.id } : undefined,
      );
      const header = currentProject ? `Backlog — ${escapeHtml(currentProject.name)}\n\n` : "";
      await bctx.sendResponseHtml(ctx, header + formatBacklog(tasks));
    }
  });

  // /sprint — view sprint status or assign tasks to a sprint
  composer.command("sprint", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "sprint");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }
    const arg = ctx.match?.trim();

    // Resolve project context for scoping
    const currentProject = await resolveProjectContext(
      bctx.supabase,
      ctx.message?.message_thread_id,
    );
    const projectFilter = currentProject ? { project_id: currentProject.id } : {};

    if (!arg) {
      // Show current sprint summary
      const current = currentProject?.current_sprint || (await getCurrentSprint(bctx.supabase));
      if (!current) {
        await ctx.reply(
          "Aucun sprint actif. Utilise /sprint S01 pour en creer un.",
          bctx.threadOpts(ctx),
        );
        return;
      }
      const summary = await getSprintSummary(bctx.supabase, current);
      const tasks = await getBacklog(bctx.supabase, { sprint: current, ...projectFilter });
      const header = currentProject ? `${escapeHtml(currentProject.name)} — ` : "";
      const text =
        header +
        formatSprintSummary(current, summary) +
        "\n\n" +
        formatBacklog(tasks, `Taches ${current}`);
      await bctx.sendResponseHtml(ctx, text);
      return;
    }

    // /sprint S01 — show that sprint
    const summary = await getSprintSummary(bctx.supabase, arg);
    const tasks = await getBacklog(bctx.supabase, { sprint: arg, ...projectFilter });
    const header = currentProject ? `${escapeHtml(currentProject.name)} — ` : "";
    const text =
      header + formatSprintSummary(arg, summary) + "\n\n" + formatBacklog(tasks, `Taches ${arg}`);
    await bctx.sendResponseHtml(ctx, text);
  });

  // /done — mark a task as done by ID prefix
  composer.command("done", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "done");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
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
    const { data: allDoneTasks } = await bctx.supabase
      .from("tasks")
      .select("id, title")
      .neq("status", "done");

    const matches = (allDoneTasks || []).filter((t: { id: string }) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      await ctx.reply(
        `Aucune tache trouvee avec l'ID commencant par "${idPrefix}".`,
        bctx.threadOpts(ctx),
      );
      return;
    }
    if (matches.length > 1) {
      await ctx.reply(
        `Plusieurs taches correspondent. Sois plus precis:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`,
        bctx.threadOpts(ctx),
      );
      return;
    }

    const updated = await updateTaskStatus(bctx.supabase, matches[0].id, "done");
    if (updated) {
      await ctx.reply(`Fait: ${updated.title}`, bctx.threadOpts(ctx));
      // Notify sprint topic if not already in it
      const currentThread = bctx.getThreadId(ctx);
      const sprintThread = getConfig().sprintThreadId || 0;
      if (currentThread !== sprintThread) {
        const ts = new Date().toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: getConfig().userTimezone || "Europe/Paris",
        });
        await enqueue({
          type: "task",
          severity: "normal",
          message: `[${ts}] Tache terminee: ${updated.title} [${updated.id.substring(0, 8)}]`,
          data: { taskId: updated.id, taskStatus: "done" },
        });
      }
    } else {
      await ctx.reply("Erreur lors de la mise a jour.", bctx.threadOpts(ctx));
    }
  });

  // /start — mark a task as in_progress by ID prefix, or show onboarding
  composer.command("start", async (ctx) => {
    // grammY auto-handles /start for new bots, but we override for task management
    const idPrefix = ctx.match?.trim();
    if (!idPrefix) {
      // /start without args = interactive onboarding
      const welcome = [
        "Bienvenue ! Je suis ton assistant de developpement.",
        "",
        "Je peux gerer tes taches, explorer le codebase, suivre les metriques,",
        "et bien plus encore. Voici quelques raccourcis pour commencer :",
      ].join("\n");
      const kb = buildOnboardingKeyboard();
      await ctx.reply(welcome, { ...bctx.threadOpts(ctx), reply_markup: kb });
      return;
    }
    if (!bctx.supabase) return;
    const blocked = bctx.commandGuard(ctx, "start");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }

    const { data: allStartTasks } = await bctx.supabase
      .from("tasks")
      .select("id, title")
      .eq("status", "backlog");

    const startMatches = (allStartTasks || []).filter((t: { id: string }) =>
      t.id.startsWith(idPrefix),
    );

    if (startMatches.length === 0) {
      await ctx.reply(
        `Aucune tache backlog trouvee avec l'ID "${idPrefix}".`,
        bctx.threadOpts(ctx),
      );
      return;
    }
    if (startMatches.length > 1) {
      await ctx.reply(
        `Plusieurs taches correspondent. Sois plus precis:\n${startMatches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`,
        bctx.threadOpts(ctx),
      );
      return;
    }

    const updated = await updateTaskStatus(bctx.supabase, startMatches[0].id, "in_progress");
    if (updated) {
      await ctx.reply(`En cours: ${updated.title}`, bctx.threadOpts(ctx));
      // Notify sprint topic if not already in it
      const currentThread = bctx.getThreadId(ctx);
      const sprintThread = getConfig().sprintThreadId || 0;
      if (currentThread !== sprintThread) {
        const ts = new Date().toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: getConfig().userTimezone || "Europe/Paris",
        });
        await enqueue({
          type: "task",
          severity: "normal",
          message: `[${ts}] Tache demarree: ${updated.title} [${updated.id.substring(0, 8)}]`,
          data: { taskId: updated.id, taskStatus: "in_progress" },
        });
      }
    } else {
      await ctx.reply("Erreur lors de la mise a jour.", bctx.threadOpts(ctx));
    }
  });

  // ── Task action callbacks (task_ prefix) ──────────────────────
  composer.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("task_")) {
      await next();
      return;
    }
    if (!bctx.supabase) {
      await ctx.answerCallbackQuery({ text: "Supabase non configure." });
      return;
    }

    // Parse callback: task_{action}:{shortId}
    const withoutPrefix = data.substring("task_".length);
    const colonIndex = withoutPrefix.indexOf(":");
    if (colonIndex === -1) {
      await ctx.answerCallbackQuery({ text: "Format invalide." });
      return;
    }

    const action = withoutPrefix.substring(0, colonIndex);
    const shortId = withoutPrefix.substring(colonIndex + 1);

    if (action === "start") {
      // Find task by short ID prefix in backlog
      const { data: tasks } = await bctx.supabase
        .from("tasks")
        .select("id, title")
        .eq("status", "backlog");

      const matches = (tasks || []).filter((t: { id: string }) => t.id.startsWith(shortId));
      if (matches.length !== 1) {
        await ctx.answerCallbackQuery({ text: "Tache introuvable ou ambigue." });
        return;
      }

      const updated = await updateTaskStatus(bctx.supabase, matches[0].id, "in_progress");
      if (updated) {
        await ctx.answerCallbackQuery({ text: "Tache demarree !" });
        try {
          await ctx.editMessageText(`En cours: ${updated.title}`);
        } catch {
          await ctx.reply(`En cours: ${updated.title}`, bctx.threadOpts(ctx));
        }
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur." });
      }
    } else if (action === "done") {
      // Find task by short ID prefix
      const { data: tasks } = await bctx.supabase
        .from("tasks")
        .select("id, title")
        .neq("status", "done");

      const matches = (tasks || []).filter((t: { id: string }) => t.id.startsWith(shortId));
      if (matches.length !== 1) {
        await ctx.answerCallbackQuery({ text: "Tache introuvable ou ambigue." });
        return;
      }

      const updated = await updateTaskStatus(bctx.supabase, matches[0].id, "done");
      if (updated) {
        await ctx.answerCallbackQuery({ text: "Tache terminee !" });
        try {
          await ctx.editMessageText(`Fait: ${updated.title}`);
        } catch {
          await ctx.reply(`Fait: ${updated.title}`, bctx.threadOpts(ctx));
        }
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur." });
      }
    } else {
      await ctx.answerCallbackQuery({ text: "Action inconnue." });
    }
  });

  return composer;
}
