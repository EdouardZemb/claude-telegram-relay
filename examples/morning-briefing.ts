/**
 * Morning Briefing Example
 *
 * Sends a daily summary via Telegram at a scheduled time.
 * Customize this for your own morning routine.
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/morning-briefing.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run examples/morning-briefing.ts
 */

import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_USER_ID || "";
const SPRINT_THREAD_ID = process.env.SPRINT_THREAD_ID || "";

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// TELEGRAM HELPER
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      chat_id: CHAT_ID,
      text: message,
    };
    if (SPRINT_THREAD_ID) {
      body.message_thread_id = parseInt(SPRINT_THREAD_ID);
    }

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// DATA FETCHERS (customize these for your sources)
// ============================================================

async function getUnreadEmails(): Promise<string> {
  // Placeholder — connect Gmail MCP in the full version
  return "";
}

async function getCalendarEvents(): Promise<string> {
  // Placeholder — connect Google Calendar MCP in the full version
  return "";
}

async function getActiveGoals(): Promise<string> {
  if (!supabase) return "";
  try {
    const { data } = await supabase.rpc("get_active_goals");
    if (!data || data.length === 0) return "";
    return data
      .map((g: { content: string; deadline?: string; priority: number }) => {
        let line = `- ${g.content}`;
        if (g.deadline) line += ` (deadline: ${new Date(g.deadline).toLocaleDateString("fr-FR")})`;
        return line;
      })
      .join("\n");
  } catch {
    return "";
  }
}

async function getKnownFacts(): Promise<string> {
  if (!supabase) return "";
  try {
    const { data } = await supabase.rpc("get_facts");
    if (!data || data.length === 0) return "";
    return data
      .slice(0, 5)
      .map((f: { content: string }) => `- ${f.content}`)
      .join("\n");
  } catch {
    return "";
  }
}

async function getRecentConversation(): Promise<string> {
  if (!supabase) return "";
  try {
    const { data } = await supabase.rpc("get_recent_messages", { limit_count: 5 });
    if (!data || data.length === 0) return "";
    return data
      .reverse()
      .map((m: { role: string; content: string }) =>
        `- ${m.role === "user" ? "Toi" : "Assistant"}: ${m.content.substring(0, 100)}`)
      .join("\n");
  } catch {
    return "";
  }
}

async function getWeather(): Promise<string> {
  // Placeholder — add weather API key for real data
  return "";
}

async function getAINews(): Promise<string> {
  // Placeholder — connect RSS/news API in the full version
  return "";
}

async function getSprintTasks(): Promise<string> {
  if (!supabase) return "";
  try {
    const { data } = await supabase
      .from("tasks")
      .select("title, status, priority, sprint")
      .neq("status", "done")
      .neq("status", "cancelled")
      .order("priority", { ascending: true })
      .limit(10);
    if (!data || data.length === 0) return "";
    return data
      .map((t: { title: string; status: string; priority: number; sprint?: string }) => {
        const status = t.status === "in_progress" ? "[EN COURS]" : "[A FAIRE]";
        return `${status} P${t.priority} ${t.title}${t.sprint ? ` (${t.sprint})` : ""}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

// ============================================================
// BUILD BRIEFING
// ============================================================

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const sections: string[] = [];

  sections.push(`Bonjour Edouard\n${dateStr}\n`);

  // Sprint tasks
  try {
    const tasks = await getSprintTasks();
    if (tasks) {
      sections.push(`BACKLOG ACTIF\n${tasks}\n`);
    }
  } catch (e) {
    console.error("Sprint tasks fetch failed:", e);
  }

  // Goals
  try {
    const goals = await getActiveGoals();
    if (goals) {
      sections.push(`OBJECTIFS\n${goals}\n`);
    }
  } catch (e) {
    console.error("Goals fetch failed:", e);
  }

  // Recent conversation
  try {
    const recent = await getRecentConversation();
    if (recent) {
      sections.push(`DERNIERE CONVERSATION\n${recent}\n`);
    }
  } catch (e) {
    console.error("Recent conversation fetch failed:", e);
  }

  // Calendar (placeholder)
  try {
    const calendar = await getCalendarEvents();
    if (calendar) {
      sections.push(`AGENDA\n${calendar}\n`);
    }
  } catch (e) {
    console.error("Calendar fetch failed:", e);
  }

  sections.push("Reponds ici pour discuter ou envoie un vocal.");

  return sections.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const briefing = await buildBriefing();

  console.log("Sending briefing...");
  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent successfully!");
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main();

// ============================================================
// LAUNCHD PLIST FOR SCHEDULING (macOS)
// ============================================================
/*
Save this as ~/Library/LaunchAgents/com.claude.morning-briefing.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.morning-briefing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/morning-briefing.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-telegram-relay</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/morning-briefing.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/morning-briefing.error.log</string>
</dict>
</plist>

Load with: launchctl load ~/Library/LaunchAgents/com.claude.morning-briefing.plist
*/

// ============================================================
// CRON FOR SCHEDULING (Linux)
// ============================================================
/*
Add to crontab with: crontab -e

# Run at 9:00 AM every day
0 9 * * * cd /path/to/claude-telegram-relay && /home/USER/.bun/bin/bun run examples/morning-briefing.ts >> /tmp/morning-briefing.log 2>&1
*/
