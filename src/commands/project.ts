/**
 * @module commands/project
 * @description Composer for project management commands: /projects, /project.
 */

import { Composer, type Context } from "grammy";
import type { BotContext } from "../bot-context.ts";
import {
  listProjects,
  getProject,
  createProject,
  archiveProject,
  updateProject,
  resolveProjectContext,
  setActiveProjectSlug,
  formatProjectList,
  formatProjectDetail,
} from "../projects.ts";

export default function projectComposer(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /projects
  composer.command("projects", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "projects");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) { await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx)); return; }

    const projects = await listProjects(bctx.supabase);
    await bctx.sendResponse(ctx, formatProjectList(projects));
  });

  // /project
  composer.command("project", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "project");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }
    if (!bctx.supabase) { await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx)); return; }

    const args = ctx.match?.trim() || "";

    if (!args) {
      const current = await resolveProjectContext(bctx.supabase, ctx.message?.message_thread_id);
      if (current) {
        await bctx.sendResponse(ctx, formatProjectDetail(current));
      } else {
        await ctx.reply("Aucun projet actif. Utilise /projects pour voir la liste.", bctx.threadOpts(ctx));
      }
      return;
    }

    const [subcommand, ...rest] = args.split(" ");
    const argument = rest.join(" ").trim();

    if (subcommand === "create") {
      if (!argument) {
        await ctx.reply("Usage: /project create <nom du projet>", bctx.threadOpts(ctx));
        return;
      }
      const slug = argument
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const project = await createProject(bctx.supabase, { name: argument, slug });
      if (project) {
        await ctx.reply(`Projet cree: ${project.name} (${project.slug})\nID: ${project.id.substring(0, 8)}`, bctx.threadOpts(ctx));
      } else {
        await ctx.reply("Erreur lors de la creation du projet. Le nom existe peut-etre deja.", bctx.threadOpts(ctx));
      }
    } else if (subcommand === "switch") {
      if (!argument) {
        await ctx.reply("Usage: /project switch <slug>", bctx.threadOpts(ctx));
        return;
      }
      const project = await getProject(bctx.supabase, argument);
      if (project) {
        setActiveProjectSlug(project.slug);
        await ctx.reply(`Projet actif: ${project.name} (${project.slug})`, bctx.threadOpts(ctx));
      } else {
        await ctx.reply(`Projet "${argument}" introuvable.`, bctx.threadOpts(ctx));
      }
    } else if (subcommand === "archive") {
      if (!argument) {
        await ctx.reply("Usage: /project archive <slug>", bctx.threadOpts(ctx));
        return;
      }
      const project = await getProject(bctx.supabase, argument);
      if (project) {
        await archiveProject(bctx.supabase, project.id);
        await ctx.reply(`Projet archive: ${project.name}`, bctx.threadOpts(ctx));
      } else {
        await ctx.reply(`Projet "${argument}" introuvable.`, bctx.threadOpts(ctx));
      }
    } else if (subcommand === "topic") {
      const topicId = parseInt(argument);
      if (isNaN(topicId)) {
        await ctx.reply("Usage: /project topic <topic_thread_id>", bctx.threadOpts(ctx));
        return;
      }
      const current = await resolveProjectContext(bctx.supabase);
      if (current) {
        await updateProject(bctx.supabase, current.id, { telegram_topic_id: topicId });
        await ctx.reply(`Projet ${current.name} lie au topic ${topicId}`, bctx.threadOpts(ctx));
      } else {
        await ctx.reply("Aucun projet actif.", bctx.threadOpts(ctx));
      }
    } else {
      const project = await getProject(bctx.supabase, subcommand);
      if (project) {
        await bctx.sendResponse(ctx, formatProjectDetail(project));
      } else {
        await ctx.reply(`Projet "${subcommand}" introuvable. Commandes: create, switch, archive, topic`, bctx.threadOpts(ctx));
      }
    }
  });

  return composer;
}
