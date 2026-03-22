/**
 * @module memory-cmds
 * @description Grammy Composer for memory-related Telegram commands: /brain (memory synthesis),
 * /ideas (ideas pipeline CRUD), and /remind (scheduled reminders). Named memory-cmds to avoid
 * conflict with src/memory.ts.
 */

import { Composer, type Context } from "grammy";
import type { BotContext, Reminder } from "../bot-context.ts";
import { createLogger } from "../logger.ts";
import {
  archiveIdea,
  clusterMemories,
  formatClusters,
  formatIdeasList,
  listIdeas,
  promoteIdea,
  reviewIdea,
} from "../memory.ts";
import { enqueue } from "../notification-queue.ts";
import { resolveProjectContext } from "../projects.ts";
import { addTask } from "../tasks.ts";

const log = createLogger("memory-cmds");
export default function memoryCmds(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // ==========================================================================
  // /brain — Memory synthesis
  // ==========================================================================

  composer.command("brain", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "brain");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    await ctx.replyWithChatAction("typing");

    try {
      // Gather recent facts, goals, ideas, memory stats, and signal/noise data (S36-06)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const [
        factsResult,
        goalsResult,
        recentFacts,
        activeIdeas,
        allIdeas,
        recentMessages,
        recentMemories,
      ] = await Promise.all([
        bctx.supabase.rpc("get_facts"),
        bctx.supabase.rpc("get_active_goals"),
        bctx.supabase
          .from("memory")
          .select("type, content, metadata, created_at")
          .order("created_at", { ascending: false })
          .limit(50),
        listIdeas(bctx.supabase, ["new", "reviewed"]),
        listIdeas(bctx.supabase, ["new", "reviewed", "promoted", "archived"]),
        bctx.supabase.from("messages").select("id").gte("created_at", sevenDaysAgo),
        bctx.supabase.from("memory").select("id").gte("created_at", sevenDaysAgo),
      ]);

      const facts = factsResult.data || [];
      const goals = goalsResult.data || [];
      const recent = recentFacts.data || [];

      // Idea stats
      const ideaStatusCounts: Record<string, number> = {};
      for (const idea of allIdeas) {
        const status = idea.idea_status || "new";
        ideaStatusCounts[status] = (ideaStatusCounts[status] || 0) + 1;
      }

      // Count by type
      const typeCounts: Record<string, number> = {};
      for (const r of recent) {
        typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
      }

      // Extract auto-classified topics
      const topicCounts: Record<string, number> = {};
      for (const r of recent) {
        const topics = r.metadata?.topics;
        if (Array.isArray(topics)) {
          for (const t of topics) {
            topicCounts[t] = (topicCounts[t] || 0) + 1;
          }
        }
      }
      const topTopics = Object.entries(topicCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([topic, count]) => `${topic} (${count})`)
        .join(", ");

      // Recent auto-classified facts
      const autoFacts = recent.filter((r: any) => r.metadata?.auto_classified).slice(0, 5);

      // Fetch memory clusters (S41-03): connected components clustering
      const clusters = await clusterMemories(bctx.supabase!);
      const clusterText = formatClusters(clusters);

      // Signal/noise ratio (S36-06)
      const msgCount = recentMessages.data?.length || 0;
      const memCount = recentMemories.data?.length || 0;
      const signalNoiseRatio =
        msgCount > 0
          ? `${memCount}/${msgCount} (${Math.round((memCount / msgCount) * 100)}%)`
          : "N/A";

      // Build the synthesis prompt
      const contextParts = [
        `STATISTIQUES MEMOIRE`,
        `Total facts: ${facts.length}`,
        `Goals actifs: ${goals.length}`,
        `Signal/bruit (7j): ${signalNoiseRatio} messages memorises`,
        `Entrees recentes (50 dernieres): ${JSON.stringify(typeCounts)}`,
        topTopics ? `Topics frequents: ${topTopics}` : "",
        "",
        `FACTS RECENTS (10 derniers):`,
        ...facts.slice(0, 10).map((f: any) => `- ${f.content}`),
        "",
        `GOALS ACTIFS:`,
        ...goals.map((g: any) => `- ${g.content}${g.deadline ? ` (deadline: ${g.deadline})` : ""}`),
        "",
        clusters.length > 0 ? clusterText : "",
        autoFacts.length > 0 ? `FAITS AUTO-DETECTES RECENTS:` : "",
        ...autoFacts.map((f: any) => `- [${f.metadata?.thought_type}] ${f.content}`),
        "",
        `IDEES (${allIdeas.length} total: ${
          Object.entries(ideaStatusCounts)
            .map(([s, c]) => `${c} ${s}`)
            .join(", ") || "aucune"
        })`,
        ...(activeIdeas.length > 0
          ? [
              `IDEES ACTIVES (new + reviewed):`,
              ...activeIdeas.slice(0, 10).map((idea: any) => {
                const status = idea.idea_status || "new";
                const topics = idea.metadata?.topics?.join(", ") || "";
                return `- [${status}] ${idea.content}${topics ? ` (${topics})` : ""}`;
              }),
            ]
          : ["Aucune idee active."]),
      ]
        .filter(Boolean)
        .join("\n");

      const prompt = `Tu es un assistant de synthese memoire. Analyse les donnees suivantes et produis une synthese hebdomadaire concise en francais.

${contextParts}

Produis:
1. RESUME: ce qui s'est passe recemment (2-3 phrases)
2. DECISIONS CLES: les decisions importantes prises
3. PATTERNS: les sujets recurrents ou tendances
4. CLUSTERS: analyse des groupes de memories connectees, quels themes emergent des liens
5. IDEES: synthese des idees actives, lesquelles meritent d'etre promues en taches, lesquelles sont redondantes ou obsoletes
6. SUGGESTIONS: ce qui meriterait d'etre consolide, nettoye ou approfondi
7. SANTE MEMOIRE: est-ce que la memoire est bien organisee, y a-t-il des doublons ou des trous

Reponds en texte brut, sans markdown.`;

      const synthesis = await bctx.callClaude(prompt, { heartbeat: bctx.heartbeatOpts(ctx) });
      await bctx.sendResponse(ctx, synthesis);
    } catch (error) {
      log.error("Brain review error", { error: String(error) });
      await ctx.reply("Erreur lors de la synthese memoire.", bctx.threadOpts(ctx));
    }
  });

  // ==========================================================================
  // /ideas — Ideas pipeline
  // ==========================================================================

  composer.command("ideas", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "ideas");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const input = ctx.match?.trim() || "";
    const parts = input.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || "list";
    const arg = parts.slice(1).join(" ");

    // /ideas or /ideas list — show new + reviewed ideas
    if (subcommand === "list" || (!input && subcommand === "list")) {
      const ideas = await listIdeas(bctx.supabase);
      await bctx.sendResponse(ctx, formatIdeasList(ideas));
      return;
    }

    // /ideas all — show all ideas including archived
    if (subcommand === "all") {
      const ideas = await listIdeas(bctx.supabase, ["new", "reviewed", "promoted", "archived"]);
      await bctx.sendResponse(ctx, formatIdeasList(ideas));
      return;
    }

    // /ideas add <text> — manually add an idea
    if (subcommand === "add") {
      if (!arg) {
        await ctx.reply("Usage: /ideas add <texte de l'idee>", bctx.threadOpts(ctx));
        return;
      }
      const { error } = await bctx.supabase.from("memory").insert({
        type: "idea",
        content: arg,
        idea_status: "new",
        metadata: { source: "manual" },
      });
      if (error) {
        log.error("ideas add error", { error: String(error) });
        await ctx.reply("Erreur lors de l'ajout de l'idee.", bctx.threadOpts(ctx));
      } else {
        await ctx.reply(`Idee ajoutee : ${arg}`, bctx.threadOpts(ctx));
        const preview = arg.length > 80 ? arg.slice(0, 80) + "..." : arg;
        const ts = new Date().toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: process.env.USER_TIMEZONE || "Europe/Paris",
        });
        await enqueue({
          type: "idea",
          severity: "normal",
          message: `[${ts}] Nouvelle idee (manual): ${preview}`,
        });
      }
      return;
    }

    // /ideas review <id> — mark as reviewed
    if (subcommand === "review") {
      if (!arg) {
        await ctx.reply("Usage: /ideas review <id>", bctx.threadOpts(ctx));
        return;
      }
      const idea = await bctx.findIdeaByPrefix(arg);
      if (!idea) {
        await ctx.reply(`Aucune idee trouvee avec l'ID "${arg}".`, bctx.threadOpts(ctx));
        return;
      }
      const ok = await reviewIdea(bctx.supabase, idea.id);
      await ctx.reply(
        ok
          ? `Idee "${idea.content.slice(0, 60)}" marquee comme reviewed.`
          : "Erreur lors du review.",
        bctx.threadOpts(ctx),
      );
      return;
    }

    // /ideas promote <id> — promote idea to task
    if (subcommand === "promote") {
      if (!arg) {
        await ctx.reply("Usage: /ideas promote <id>", bctx.threadOpts(ctx));
        return;
      }
      const idea = await bctx.findIdeaByPrefix(arg);
      if (!idea) {
        await ctx.reply(`Aucune idee trouvee avec l'ID "${arg}".`, bctx.threadOpts(ctx));
        return;
      }
      const content = await promoteIdea(bctx.supabase, idea.id);
      if (!content) {
        await ctx.reply("Erreur lors de la promotion.", bctx.threadOpts(ctx));
        return;
      }
      // Create a task from the promoted idea
      const currentProject = await resolveProjectContext(
        bctx.supabase,
        ctx.message?.message_thread_id,
      );
      const task = await addTask(bctx.supabase, content, {
        ...(currentProject ? { project_id: currentProject.id } : {}),
        tags: ["from-idea"],
      });
      if (task) {
        await ctx.reply(
          `Idee promue en tache !\nTache: ${task.title}\nID: ${task.id.slice(0, 8)}`,
          bctx.threadOpts(ctx),
        );
        const promotePreview = content.length > 80 ? content.slice(0, 80) + "..." : content;
        const promoteTs = new Date().toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: process.env.USER_TIMEZONE || "Europe/Paris",
        });
        await enqueue({
          type: "idea",
          severity: "normal",
          message: `[${promoteTs}] Idee promue en tache: ${promotePreview}\nTache: ${task.title}`,
        });
      } else {
        await ctx.reply(
          `Idee promue mais erreur creation tache. Contenu : ${content}`,
          bctx.threadOpts(ctx),
        );
      }
      return;
    }

    // /ideas archive <id> or /ideas done <id> — archive an idea
    if (subcommand === "archive" || subcommand === "done") {
      if (!arg) {
        await ctx.reply(`Usage: /ideas ${subcommand} <id>`, bctx.threadOpts(ctx));
        return;
      }
      const idea = await bctx.findIdeaByPrefix(arg);
      if (!idea) {
        await ctx.reply(`Aucune idee trouvee avec l'ID "${arg}".`, bctx.threadOpts(ctx));
        return;
      }
      const ok = await archiveIdea(bctx.supabase, idea.id);
      await ctx.reply(
        ok ? `Idee "${idea.content.slice(0, 60)}" archivee.` : "Erreur lors de l'archivage.",
        bctx.threadOpts(ctx),
      );
      return;
    }

    // /ideas <id> — show idea detail
    if (subcommand.length <= 8 && /^[a-f0-9]+$/.test(subcommand)) {
      const idea = await bctx.findIdeaByPrefix(subcommand);
      if (!idea) {
        await ctx.reply(`Aucune idee trouvee avec l'ID "${subcommand}".`, bctx.threadOpts(ctx));
        return;
      }
      const topics = Array.isArray(idea.metadata?.topics)
        ? (idea.metadata.topics as string[]).join(", ")
        : "";
      const date = new Date(idea.created_at).toLocaleDateString("fr-FR");
      const detail = [
        `IDEE ${idea.idea_status.toUpperCase()} [${idea.id.slice(0, 8)}]`,
        idea.content,
        topics ? `Topics: ${topics}` : "",
        `Date: ${date}`,
      ]
        .filter(Boolean)
        .join("\n");
      await bctx.sendResponse(ctx, detail);
      return;
    }

    // Unknown subcommand → treat as a new idea
    const { error } = await bctx.supabase.from("memory").insert({
      type: "idea",
      content: input,
      idea_status: "new",
      metadata: { source: "manual" },
    });
    if (error) {
      log.error("ideas add error", { error: String(error) });
      await ctx.reply("Erreur lors de l'ajout de l'idee.", bctx.threadOpts(ctx));
    } else {
      await ctx.reply(`Idee ajoutee : ${input}`, bctx.threadOpts(ctx));
      const fallbackPreview = input.length > 80 ? input.slice(0, 80) + "..." : input;
      const fallbackTs = new Date().toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: process.env.USER_TIMEZONE || "Europe/Paris",
      });
      await enqueue({
        type: "idea",
        severity: "normal",
        message: `[${fallbackTs}] Nouvelle idee (manual): ${fallbackPreview}`,
      });
    }
  });

  // ==========================================================================
  // /remind — Scheduled reminders
  // ==========================================================================

  composer.command("remind", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "remind");
    if (blocked) {
      await ctx.reply(blocked, bctx.threadOpts(ctx));
      return;
    }
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply(
        "Usage: /remind 14h30 Appeler le client\nOu: /remind 2h Verifier les logs",
        bctx.threadOpts(ctx),
      );
      return;
    }

    // Parse time: either HH:MM (absolute) or Nh/Nm (relative)
    const relativeMatch = input.match(/^(\d+)(h|m)\s+(.+)$/i);
    const absoluteMatch = input.match(/^(\d{1,2})[h:](\d{2})?\s+(.+)$/i);

    let triggerAt: number;
    let text: string;
    let timeLabel: string;

    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1], 10);
      const unit = relativeMatch[2].toLowerCase();
      text = relativeMatch[3];
      const ms = unit === "h" ? amount * 3600_000 : amount * 60_000;
      triggerAt = Date.now() + ms;
      timeLabel = `dans ${amount}${unit}`;
    } else if (absoluteMatch) {
      const hours = parseInt(absoluteMatch[1], 10);
      const minutes = parseInt(absoluteMatch[2] || "0", 10);
      text = absoluteMatch[3];
      const now = new Date();
      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1); // Tomorrow if time already passed
      }
      triggerAt = target.getTime();
      timeLabel = `a ${hours}h${minutes.toString().padStart(2, "0")}`;
    } else {
      await ctx.reply(
        "Format non reconnu. Exemples:\n/remind 14h30 Appeler le client\n/remind 2h Verifier les logs\n/remind 30m Pause cafe",
        bctx.threadOpts(ctx),
      );
      return;
    }

    const reminder: Reminder = {
      id: crypto.randomUUID().substring(0, 8),
      text,
      triggerAt,
      chatId: ctx.chat.id,
      threadId: bctx.getThreadId(ctx),
    };

    bctx.reminders.push(reminder);
    await bctx.saveReminders();

    await ctx.reply(`Rappel programme ${timeLabel}: ${text}`, bctx.threadOpts(ctx));
  });

  return composer;
}
