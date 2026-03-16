/**
 * Generate post-merge test checklist (S29-T9)
 *
 * Reads sprint tasks from Supabase and generates a checklist of
 * concrete Telegram test scenarios.
 *
 * Run: bun run scripts/generate-checklist.ts [sprint_id]
 */

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

// ── Scenario Rules ──────────────────────────────────────────

interface ChecklistItem {
  scenario: string;
  command: string;
  expected: string;
}

function generateScenarios(title: string, description?: string): ChecklistItem[] {
  const text = `${title} ${description || ""}`.toLowerCase();
  const items: ChecklistItem[] = [];

  if (text.includes("command") || text.includes("commande") || text.match(/\/\w+/)) {
    const cmdMatch = text.match(/\/(\w+)/);
    const cmd = cmdMatch ? `/${cmdMatch[1]}` : "/help";
    items.push({
      scenario: `Tester la commande Telegram liee a: ${title}`,
      command: cmd,
      expected: "Reponse sans erreur avec contenu pertinent",
    });
  }

  if (text.includes("agent") || text.includes("pipeline") || text.includes("orchestrat")) {
    items.push({
      scenario: `Tester le pipeline pour: ${title}`,
      command: "/orchestrate <id> --blackboard",
      expected: "Pipeline complete avec resultat structure",
    });
  }

  if (text.includes("alert") || text.includes("monitor") || text.includes("surveillance")) {
    items.push({
      scenario: `Verifier les alertes/monitoring: ${title}`,
      command: "/alerts",
      expected: "Reponse avec statut des alertes",
    });
  }

  if (text.includes("deploy") || text.includes("rollback") || text.includes("smoke")) {
    items.push({
      scenario: `Verifier le deploy/rollback: ${title}`,
      command: "bun run smoke",
      expected: "Tous les checks passent",
    });
  }

  if (text.includes("cost") || text.includes("cout") || text.includes("estimat")) {
    items.push({
      scenario: `Tester l'estimation de cout: ${title}`,
      command: "/estimate 5 DEFAULT",
      expected: "Estimation avec breakdown par agent",
    });
  }

  if (text.includes("feature") || text.includes("flag")) {
    items.push({
      scenario: `Tester les feature flags: ${title}`,
      command: "/feature list",
      expected: "Liste des flags avec statut ON/OFF",
    });
  }

  // Default scenario if no keyword matched
  if (items.length === 0) {
    items.push({
      scenario: `Verifier: ${title}`,
      command: "/status",
      expected: "Le systeme fonctionne normalement",
    });
  }

  return items;
}

/**
 * Generate checklist from task list (exported for testing).
 */
export function generateChecklist(tasks: Array<{ title: string; description?: string }>): string {
  if (tasks.length === 0) return "Aucune tache a verifier.";

  const allItems: ChecklistItem[] = [];
  for (const task of tasks) {
    allItems.push(...generateScenarios(task.title, task.description));
  }

  const lines: string[] = [
    `Checklist post-merge — ${allItems.length} scenarios`,
    "",
  ];

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    lines.push(`${i + 1}. ${item.scenario}`);
    lines.push(`   Commande: ${item.command}`);
    lines.push(`   Attendu: ${item.expected}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const sprintId = process.argv[2] || undefined;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.log("SUPABASE_URL and SUPABASE_ANON_KEY required");
    process.exit(1);
  }

  const supabase = createClient(url, key);

  let query = supabase
    .from("tasks")
    .select("title, description")
    .eq("status", "done");

  if (sprintId) {
    query = query.eq("sprint", sprintId);
  }

  const { data: tasks, error } = await query;
  if (error) {
    console.error("Error fetching tasks:", error);
    process.exit(1);
  }

  const checklist = generateChecklist(tasks || []);
  console.log(checklist);

  // Send to Telegram if configured
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groupId = process.env.TELEGRAM_GROUP_ID;
  const userId = process.env.TELEGRAM_USER_ID;
  const chatId = groupId || userId;
  const threadId = process.env.SERVER_THREAD_ID || "7";

  if (token && chatId) {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text: checklist };
      if (groupId && chatId === groupId) {
        body.message_thread_id = Number(threadId);
      }
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {}
  }
}

main();
