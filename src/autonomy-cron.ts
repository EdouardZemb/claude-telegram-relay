/**
 * Autonomy Cron — Proactive Task Creation & Execution
 *
 * Standalone script that runs periodically via PM2.
 * Scans the project for improvement opportunities,
 * creates tasks in Supabase (tag: auto-generated),
 * notifies on Telegram, and optionally executes
 * safe tasks automatically (code + PR).
 *
 * Run: bun run src/autonomy-cron.ts
 * Run with execution: AUTONOMY_EXEC=1 bun run src/autonomy-cron.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  runAllScanners,
  isDuplicate,
  formatScanResult,
  type Opportunity,
} from "./autonomy-scanner.ts";
import { addTask, type Task } from "./tasks.ts";
import { getCurrentSprint } from "./tasks.ts";
import { executeTask } from "./agent.ts";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";
const SPRINT_THREAD_ID = parseInt(process.env.SPRINT_THREAD_ID || "0");
const PROJECT_ROOT = process.env.PROJECT_ROOT || "/home/edouard/claude-telegram-relay";

// Max tasks to create per run (avoid flooding)
const MAX_TASKS_PER_RUN = 3;

// Auto-execution: only these opportunity types are safe to execute automatically
const EXEC_SAFE_TYPES: Set<Opportunity["type"]> = new Set(["missing_tests", "todo_marker"]);

// Enable auto-execution via env var (default: off)
const AUTONOMY_EXEC = process.env.AUTONOMY_EXEC === "1" || process.env.AUTONOMY_EXEC === "true";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log("Supabase not configured, skipping autonomy scan.");
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegram(text: string): Promise<void> {
  if (!BOT_TOKEN) return;

  const chatId = GROUP_ID || process.env.TELEGRAM_USER_ID || "";
  if (!chatId) return;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (GROUP_ID && SPRINT_THREAD_ID) {
    body.message_thread_id = SPRINT_THREAD_ID;
  }

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface CreatedTask {
  id: string;
  task: Task;
  opportunity: Opportunity;
}

async function createTaskFromOpportunity(
  opp: Opportunity,
  sprint: string | null
): Promise<CreatedTask | null> {
  // Check for duplicates using dedup_key stored in notes
  const duplicate = await isDuplicate(supabase, opp.dedup_key);
  if (duplicate) {
    console.log(`  Skip (duplicate): ${opp.title}`);
    return null;
  }

  const task = await addTask(supabase, opp.title, {
    description: opp.description,
    priority: opp.priority,
    sprint: sprint ?? undefined,
    tags: ["auto-generated", opp.type],
  });

  if (!task) return null;

  // Store dedup_key in notes for future duplicate detection
  await supabase
    .from("tasks")
    .update({ notes: opp.dedup_key })
    .eq("id", task.id);

  return { id: task.id, task: task as Task, opportunity: opp };
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Autonomy scan starting... (exec=${AUTONOMY_EXEC})`);

  // Run all scanners
  const result = await runAllScanners(PROJECT_ROOT, supabase);

  if (result.opportunities.length === 0) {
    console.log(`[${timestamp}] No opportunities found.`);
    return;
  }

  console.log(`[${timestamp}] ${result.opportunities.length} opportunity(ies) found.`);

  // Get current sprint for task assignment
  const sprint = await getCurrentSprint(supabase);

  // Create tasks for top opportunities (respect limit)
  const createdTasks: CreatedTask[] = [];
  for (const opp of result.opportunities.slice(0, MAX_TASKS_PER_RUN)) {
    const created = await createTaskFromOpportunity(opp, sprint);
    if (created) {
      createdTasks.push(created);
      console.log(`  Created: ${opp.title} [${created.id.substring(0, 8)}]`);
    }
  }

  // Notify on Telegram
  if (createdTasks.length > 0) {
    const message = [
      `[Autonomie] ${createdTasks.length} tache(s) auto-generee(s):`,
      "",
      ...createdTasks.map((t) => `  ${t.opportunity.title}`),
      "",
      `Sprint: ${sprint || "aucun"}`,
      `Total detecte: ${result.opportunities.length} opportunite(s)`,
      AUTONOMY_EXEC ? `\nExecution auto activee. Recherche d'une tache executable...` : "",
    ].join("\n");

    await sendTelegram(message);
  }

  // Auto-execution: pick the first safe task and execute it
  if (AUTONOMY_EXEC && createdTasks.length > 0) {
    const execCandidate = createdTasks.find((t) => EXEC_SAFE_TYPES.has(t.opportunity.type));

    if (execCandidate) {
      console.log(`  Auto-executing: ${execCandidate.opportunity.title}`);
      await sendTelegram(
        `[Autonomie] Execution auto: ${execCandidate.opportunity.title}\nBranche + code + PR en cours...`
      );

      const onProgress = async (msg: string) => {
        console.log(`  [exec] ${msg}`);
        await sendTelegram(`[Autonomie] ${msg}`);
      };

      const agentResult = await executeTask(supabase, execCandidate.task, onProgress);

      const execSummary = agentResult.success
        ? [
            `[Autonomie] Execution terminee: ${execCandidate.opportunity.title}`,
            agentResult.prUrl ? `PR: ${agentResult.prUrl}` : "Aucun changement de fichier.",
            `Duree: ${Math.round(agentResult.durationMs / 60000)} min`,
            agentResult.reviewScore != null ? `Review: ${agentResult.reviewScore}/100` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `[Autonomie] Echec execution: ${execCandidate.opportunity.title}`,
            agentResult.error || "Erreur inconnue",
          ].join("\n");

      await sendTelegram(execSummary);
      console.log(`  Execution done: success=${agentResult.success}`);
    } else {
      console.log("  No safe task found for auto-execution.");
    }
  }

  console.log(`[${timestamp}] Done. Created ${createdTasks.length} task(s).`);
}

main().catch((err) => {
  console.error("Autonomy cron error:", err);
  process.exit(1);
});
