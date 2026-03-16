/**
 * @module autonomy-cron
 * @description Scheduled autonomy runner: daily scan trigger via PM2 cron.
 */

/**
 * Autonomy Cron — Proactive Task Creation
 *
 * Standalone script that runs periodically via PM2.
 * Scans the project for improvement opportunities,
 * creates tasks in Supabase (tag: auto-generated),
 * and notifies on Telegram.
 *
 * Run: bun run src/autonomy-cron.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  runAllScanners,
  isDuplicate,
  formatScanResult,
  type Opportunity,
} from "./autonomy-scanner.ts";
import { addTask } from "./tasks.ts";
import { getCurrentSprint } from "./tasks.ts";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";
const SPRINT_THREAD_ID = parseInt(process.env.SPRINT_THREAD_ID || "0");
const PROJECT_ROOT = process.env.PROJECT_ROOT || "/home/edouard/claude-telegram-relay";

// Max tasks to create per run (avoid flooding)
const MAX_TASKS_PER_RUN = 3;

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

async function createTaskFromOpportunity(
  opp: Opportunity,
  sprint: string | null
): Promise<string | null> {
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

  return task.id;
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Autonomy scan starting...`);

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
  const created: string[] = [];
  for (const opp of result.opportunities.slice(0, MAX_TASKS_PER_RUN)) {
    const taskId = await createTaskFromOpportunity(opp, sprint);
    if (taskId) {
      created.push(opp.title);
      console.log(`  Created: ${opp.title} [${taskId.substring(0, 8)}]`);
    }
  }

  // Notify on Telegram
  if (created.length > 0) {
    const message = [
      `[Autonomie] ${created.length} tache(s) auto-generee(s):`,
      "",
      ...created.map((t) => `  ${t}`),
      "",
      `Sprint: ${sprint || "aucun"}`,
      `Total detecte: ${result.opportunities.length} opportunite(s)`,
    ].join("\n");

    await sendTelegram(message);
  }

  console.log(`[${timestamp}] Done. Created ${created.length} task(s).`);
}

main().catch((err) => {
  console.error("Autonomy cron error:", err);
  process.exit(1);
});
