/**
 * Alert Cron — S13 Intelligence Reflexive
 *
 * Standalone script that runs periodically via PM2 cron.
 * Checks for anomalies and sends notifications to Telegram.
 *
 * Run: bun run src/alert-cron.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { runAllChecks, formatAlerts } from "./alerts.ts";
import { getCurrentSprint } from "./tasks.ts";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";
const SPRINT_THREAD_ID = parseInt(process.env.SPRINT_THREAD_ID || "0");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log("Supabase not configured, skipping alert check.");
  process.exit(0);
}

if (!BOT_TOKEN) {
  console.log("Bot token not configured, skipping alert check.");
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegram(text: string): Promise<void> {
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

async function main(): Promise<void> {
  const sprintId = await getCurrentSprint(supabase) || undefined;
  const alerts = await runAllChecks(supabase, sprintId);

  if (alerts.length === 0) {
    console.log(`[${new Date().toISOString()}] No alerts.`);
    return;
  }

  console.log(`[${new Date().toISOString()}] ${alerts.length} alert(s) detected.`);
  const message = `[Alerte automatique]\n\n${formatAlerts(alerts)}`;
  await sendTelegram(message);
}

main().catch((err) => {
  console.error("Alert cron error:", err);
  process.exit(1);
});
