/**
 * @module commands/exploration
 * @description Grammy Composer handling the /explore command. Launches the Explorer agent (Ada)
 * to investigate a topic, module, or question in the codebase and produce a structured report.
 */

import { Composer, Context } from "grammy";
import type { BotContext } from "../bot-context.ts";
import { spawnClaude } from "../agent.ts";
import { getAgent } from "../bmad-agents.ts";
import { buildAgentContext } from "../agent-context.ts";
import {
  getJsonSchemaForRole,
  parseAgentOutput,
  formatStructuredOutput,
  buildStructuredOutputInstructions,
} from "../agent-schemas.ts";
import {
  buildAgentSystemPromptPart,
  buildAgentTaskPromptPart,
} from "../bmad-prompts.ts";
import { resolveProjectContext } from "../projects.ts";
import { getGraph } from "../code-graph.ts";
import { tryGraphResponse } from "../explore-graph.ts";
import { launch as launchJob, isJobManagerEnabled } from "../job-manager.ts";

// ── Web Research Detection ───────────────────────────────────

const WEB_RESEARCH_KEYWORDS = [
  "api", "library", "librairie", "package", "alternative", "comparaison",
  "benchmark", "trend", "best practice", "meilleure pratique", "how to",
  "comment implementer", "outil", "tool", "framework", "service", "saas",
  "cloud", "pricing", "documentation externe", "standard", "specification",
  "rfc", "protocol", "npm", "crate", "pip", "gem", "etat de l'art",
  "state of the art", "open source", "solution", "comparatif",
];

/**
 * Detect if a query requires web research (vs code-only exploration).
 */
export function detectWebResearchIntent(query: string): boolean {
  const text = query.toLowerCase();
  return WEB_RESEARCH_KEYWORDS.some((kw) => text.includes(kw));
}

export default function explorationCommands(bctx: BotContext): Composer<Context> {
  const composer = new Composer<Context>();

  // /explore — launch the Explorer agent to investigate a topic
  composer.command("explore", async (ctx) => {
    const blocked = bctx.commandGuard(ctx, "explore");
    if (blocked) { await ctx.reply(blocked, bctx.threadOpts(ctx)); return; }

    if (!bctx.supabase) {
      await ctx.reply("Supabase non configure.", bctx.threadOpts(ctx));
      return;
    }

    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply(
        "Usage: /explore <sujet a investiguer>\n\n" +
        "Exemples:\n" +
        "  /explore comment fonctionne le systeme de notifications\n" +
        "  /explore impact de modifier le module orchestrator\n" +
        "  /explore options pour ajouter du caching\n" +
        "  /explore architecture du pipeline multi-agents",
        bctx.threadOpts(ctx)
      );
      return;
    }

    // Fast-path: try to answer from code graph alone (zero LLM cost)
    try {
      const graph = getGraph();
      const graphResult = tryGraphResponse(query, graph);
      if (graphResult) {
        await bctx.sendResponse(ctx, `EXPLORATION (code-graph): ${query}\n\n${graphResult.response}`);
        return;
      }
    } catch {
      // Graph unavailable — fall through to LLM
    }

    const explorer = getAgent("explorer");
    if (!explorer) {
      await ctx.reply("Agent Explorer non configure.", bctx.threadOpts(ctx));
      return;
    }

    // Detect web research intent for budget/model upgrade
    const isWebResearch = detectWebResearchIntent(query);

    // ── Explore function (shared between sync/async) ──────────
    const exploreFn = async (): Promise<string> => {
      const currentProject = await resolveProjectContext(bctx.supabase!, ctx.message?.message_thread_id);

      const agentContext = await buildAgentContext(bctx.supabase!, {
        role: "explorer",
        projectId: currentProject?.id,
        sprintId: currentProject?.current_sprint || undefined,
        taskTitle: query,
      });

      const systemPrompt = buildAgentSystemPromptPart("explorer", {
        command: "explore",
        taskTitle: query,
        projectName: currentProject?.slug || "telegram-relay",
      });

      const taskPrompt = buildAgentTaskPromptPart("explorer", {
        command: "explore",
        taskTitle: query,
        projectName: currentProject?.slug || "telegram-relay",
      });

      const outputInstructions = buildStructuredOutputInstructions("explorer" as any);

      const fullPrompt = [
        taskPrompt,
        "",
        agentContext ? `CONTEXTE PROJET:\n${agentContext}` : "",
        "",
        "QUESTION A EXPLORER:",
        query,
        "",
        "Explore le codebase, analyse les fichiers pertinents, et produis un rapport structure.",
        outputInstructions,
      ].filter(Boolean).join("\n");

      const jsonSchema = getJsonSchemaForRole("explorer");
      const model = isWebResearch ? "claude-sonnet-4-6" : explorer.model;
      const effort = isWebResearch ? "medium" : explorer.effort;

      const result = await spawnClaude({
        prompt: fullPrompt,
        systemPrompt: systemPrompt || undefined,
        outputFormat: "json",
        jsonSchema: jsonSchema || undefined,
        model,
        fallbackModel: explorer.fallbackModel,
        effort: effort as any,
        mcpRole: "explorer",
      });

      if (result.exitCode !== 0 || !result.stdout.trim()) {
        throw new Error(result.stderr || "Pas de reponse de l'agent.");
      }

      const parsed = parseAgentOutput(result.stdout, "explorer" as any);
      if (parsed) {
        return `EXPLORATION: ${query}\n\n${formatStructuredOutput(parsed)}`;
      }
      const output = result.stdout.length > 4000
        ? result.stdout.substring(0, 4000) + "\n...(tronque)"
        : result.stdout;
      return `EXPLORATION: ${query}\n\n${output}`;
    };

    // ── Background job or blocking (S46) ────────────────────────
    if (isJobManagerEnabled()) {
      const chatId = ctx.chat?.id || 0;
      const threadId = bctx.getThreadId(ctx);
      const jobId = await launchJob("explore", chatId, exploreFn, { messageThreadId: threadId });
      await ctx.reply(`Job lance explore (id: ${jobId})\nQuery: ${query}`, bctx.threadOpts(ctx));
    } else {
      const statusMsg = isWebResearch
        ? `Exploration en cours: ${query}\nAgent Ada analyse le codebase + recherche web...`
        : `Exploration en cours: ${query}\nAgent Ada analyse le codebase...`;
      await ctx.reply(statusMsg, bctx.threadOpts(ctx));

      try {
        const resultMsg = await exploreFn();
        await bctx.sendResponse(ctx, resultMsg);
      } catch (error: any) {
        await ctx.reply(`Exploration echouee:\n${(error.message || "").substring(0, 2000)}`, bctx.threadOpts(ctx));
      }
    }
  });

  return composer;
}
