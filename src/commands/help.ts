/**
 * @module commands/help
 * @description Grammy Composer module handling informational commands:
 * /help, /workflow, /agents, /status, /monitor. These are read-only commands
 * that display bot capabilities, system health, and production monitoring.
 */

import { Composer, Context } from "grammy";
import { cpus, totalmem, freemem, loadavg, uptime as osUptime, hostname } from "os";
import { execSync } from "child_process";
import type { BotContext } from "../bot-context.ts";
import { RELAY_START_TIME } from "../bot-context.ts";
import { formatAgentList } from "../bmad-agents.ts";
import { formatMonitoringStats } from "../alerts.ts";
import { formatRecentGateEvaluations } from "../trust-scores.ts";
import { formatDoubleLoopRules } from "../gate-persistence.ts";
import { isFeatureEnabled } from "../feature-flags.ts";
import { getAgentEvents, formatAgentTimeline } from "../agent-events.ts";
import { getAgentMessages, getMessageFlowSummary, formatMessageFlow } from "../agent-messaging.ts";

export default function helpCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();
  const { commandGuard, threadOpts, sendResponse, supabase } = bctx;

  // /help — command reference
  composer.command("help", async (ctx) => {
    const help = [
      "COMMANDES — Workflow BMad",
      "",
      "ANALYSE & PLANIFICATION",
      "  /prd <description> -- Creer un PRD (Product Manager John)",
      "  /plan <description> -- Decomposer en sous-taches (PM John)",
      "  /agents -- Agents BMad disponibles et leurs roles",
      "",
      "BACKLOG & SPRINT",
      "  /task <titre> -- Ajouter une tache",
      "  /backlog [projet] -- Voir le backlog",
      "  /sprint [id] -- Etat du sprint",
      "  /start <id> -- Demarrer une tache",
      "  /done <id> -- Terminer une tache",
      "",
      "EXECUTION",
      "  /exec <id> -- Lancer l'agent Dev (Amelia)",
      "  /orchestrate <id> [pipeline] [--blackboard] [--parallel] -- Pipeline multi-agents (full/quick/review)",
      "  /autopipeline <id> [full|fast] -- Pipeline auto BMad complet",
      "  /workflow -- Voir le processus BMad complet",
      "",
      "QUALITE & AMELIORATION",
      "  /metrics [sprint] -- Metriques (Scrum Master Bob)",
      "  /retro [sprint] -- Retrospective (Bob)",
      "  /patterns -- Analyse multi-sprints (Analyste Mary)",
      "  /alerts -- Alertes proactives (QA Quinn)",
      "  /planify [sprint] -- Analyse proactive du backlog + recommandations",
      "  /cost [sprint|total] -- Suivi couts tokens par agent/tache/sprint",
      "  /brain -- Synthese memoire (faits, decisions, patterns recents)",
      "  /ideas [list|add|review|promote|archive] -- Gerer les idees",
      "",
      "PROJETS",
      "  /projects -- Tous les projets",
      "  /project create|switch|archive -- Gerer",
      "",
      "PRODUCTION",
      "  /estimate <n> [pipeline] -- Estimation cout sprint (DEFAULT/QUICK/REVIEW)",
      "  /monitor -- Monitoring production (temps reponse, spawn, erreurs)",
      "  /feature [list|enable|disable] -- Feature flags",
      "  /rollback [raison] -- Rollback au commit precedent",
      "",
      "UTILITAIRES",
      "  /status -- Etat serveur",
      "  /remind <heure> <texte> -- Rappel",
      "  /speak [texte] -- Synthese vocale",
      "  /profile -- Profil utilisateur",
      "  /notify [status|quiet|on|off|immediate] -- Preferences notifications",
      "  /export -- Export donnees",
      "",
      "Envoie un texte ou vocal pour discuter librement.",
    ].join("\n");
    await ctx.reply(help, threadOpts(ctx));
  });

  // /workflow — show BMad workflow overview
  composer.command("workflow", async (ctx) => {
    const workflow = [
      "WORKFLOW BMad — Processus Complet",
      "",
      "1. ANALYSE (Analyste Mary)",
      "   Research, domain expertise, competitive analysis",
      "   -> Produit un brief ou une analyse",
      "",
      "2. PLANIFICATION (PM John)",
      "   /prd pour creer le PRD",
      "   /plan pour decomposer en taches",
      "   -> Gate 1 : PRD approuve requis",
      "",
      "3. ARCHITECTURE (Architecte Winston)",
      "   Design technique, decisions ADR",
      "   -> Gate 2 : Architecture validee",
      "",
      "4. EXECUTION (Dev Amelia)",
      "   /exec pour lancer l'implementation",
      "   Tests obligatoires, story files atomiques",
      "   -> Gate 3 : Code review avant merge",
      "",
      "5. QUALITE (QA Quinn)",
      "   Tests automatises, review adversariale",
      "   CI/CD : branche -> PR -> merge -> deploy",
      "",
      "6. RETROSPECTIVE (Scrum Master Bob)",
      "   /retro pour analyser le sprint",
      "   /metrics pour les donnees quantitatives",
      "   /patterns pour les tendances multi-sprints",
      "   -> Les retros decident des ajustements",
      "",
      "Chaque gate peut etre bypassee explicitement.",
      "Le processus s'ameliore via les retros.",
    ].join("\n");
    await ctx.reply(workflow, threadOpts(ctx));
  });

  // /agents — list BMad agents and their capabilities
  composer.command("agents", async (ctx) => {
    const blocked = commandGuard(ctx, "agents");
    if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
    await ctx.reply(formatAgentList(), threadOpts(ctx));
  });

  // /status — server health and system info
  composer.command("status", async (ctx) => {
    const blocked = commandGuard(ctx, "status");
    if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
    try {
      const uptimeSec = Math.round((Date.now() - RELAY_START_TIME) / 1000);
      const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
      const memUsed = Math.round((totalmem() - freemem()) / 1024 / 1024);
      const memTotal = Math.round(totalmem() / 1024 / 1024);
      const memPct = Math.round((1 - freemem() / totalmem()) * 100);
      const load = loadavg();

      const parts = [
        `Serveur: ${hostname()}`,
        `Uptime bot: ${uptimeStr}`,
        `Uptime systeme: ${Math.floor(osUptime() / 3600)}h`,
        `CPU: ${cpus().length} cores, load ${load[0].toFixed(1)} / ${load[1].toFixed(1)} / ${load[2].toFixed(1)}`,
        `Memoire: ${memUsed}/${memTotal} MB (${memPct}%)`,
      ];

      // PM2 services
      try {
        const pm2Output = execSync("npx pm2 jlist 2>/dev/null", { timeout: 5000 }).toString();
        const pm2Apps = JSON.parse(pm2Output);
        parts.push("");
        parts.push("Services PM2:");
        for (const app of pm2Apps) {
          const status = app.pm2_env?.status || "unknown";
          const restarts = app.pm2_env?.restart_time || 0;
          const mem = Math.round((app.monit?.memory || 0) / 1024 / 1024);
          parts.push(`  ${app.name}: ${status} (${mem}MB, ${restarts} restarts)`);
        }
      } catch {}

      // Message count today
      if (supabase) {
        const today = new Date().toISOString().split("T")[0];
        const { count } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .gte("created_at", today);
        parts.push("");
        parts.push(`Messages aujourd'hui: ${count ?? 0}`);
      }

      await sendResponse(ctx, parts.join("\n"));
    } catch (error) {
      console.error("Status error:", error);
      await ctx.reply("Erreur lors de la recuperation du statut.", threadOpts(ctx));
    }
  });

  // /monitor — production monitoring stats (S35: trust scores, evaluations, double-loop)
  composer.command("monitor", async (ctx) => {
    const blocked = commandGuard(ctx, "monitor");
    if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }

    const parts = [formatMonitoringStats()];

    // S35: Recent gate evaluations and double-loop rules
    if (supabase) {
      const [recentEvals, dlRules] = await Promise.all([
        formatRecentGateEvaluations(supabase),
        formatDoubleLoopRules(supabase),
      ]);
      parts.push("", recentEvals, "", dlRules);

      // S38: Inter-agent communication monitoring
      if (isFeatureEnabled("inter_agent_messaging")) {
        try {
          // Find most recent pipeline run
          const { data: latestRun } = await supabase
            .from("pipeline_runs")
            .select("session_id")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          if (latestRun?.session_id) {
            const [events, messagesSection] = await Promise.all([
              getAgentEvents(supabase, latestRun.session_id),
              getAgentMessages(supabase, latestRun.session_id, "*"),
            ]);

            if (events.length > 0) {
              parts.push("", formatAgentTimeline(events.slice(-10)));
            }

            if (messagesSection.length > 0) {
              const summary = getMessageFlowSummary(messagesSection);
              parts.push("", formatMessageFlow(summary));
            }
          }
        } catch {
          // Best-effort monitoring
        }
      }
    }

    await ctx.reply(parts.join("\n"), threadOpts(ctx));
  });

  return composer;
}
