/**
 * Smart Check-in Example
 *
 * A proactive assistant pattern where Claude decides:
 * - IF to check in (based on context)
 * - WHAT to say (based on goals, time, etc.)
 *
 * Run periodically (e.g., every 30 minutes) and Claude
 * intelligently decides whether to message you.
 *
 * Run: bun run examples/smart-checkin.ts
 */

import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_USER_ID || "";
const SPRINT_THREAD_ID = process.env.SPRINT_THREAD_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const STATE_FILE =
  process.env.CHECKIN_STATE_FILE || "/tmp/checkin-state.json";

// Supabase client
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface CheckinState {
  lastMessageTime: string; // Last time user messaged
  lastCheckinTime: string; // Last time we checked in
  pendingItems: string[]; // Things to follow up on
}

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastMessageTime: new Date().toISOString(),
      lastCheckinTime: "",
      pendingItems: [],
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CONTEXT GATHERING
// ============================================================

async function getGoals(): Promise<string[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase.rpc("get_active_goals");
    return (data || []).map((g: { content: string; deadline?: string }) =>
      g.deadline ? `${g.content} (deadline: ${g.deadline})` : g.content
    );
  } catch {
    return [];
  }
}

async function getFacts(): Promise<string[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase.rpc("get_facts");
    return (data || []).map((f: { content: string }) => f.content);
  } catch {
    return [];
  }
}

async function getCalendarContext(): Promise<string> {
  // Placeholder — connect Google Calendar MCP in the full version
  return "No calendar connected";
}

async function getLastActivity(): Promise<string> {
  // Try Supabase first for accurate last message time
  if (supabase) {
    try {
      const { data } = await supabase
        .from("messages")
        .select("created_at")
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(1);
      if (data && data.length > 0) {
        const lastMsg = new Date(data[0].created_at);
        const now = new Date();
        const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);
        return `Last message: ${hoursSince.toFixed(1)} hours ago`;
      }
    } catch {}
  }

  const state = await loadState();
  const lastMsg = new Date(state.lastMessageTime);
  const now = new Date();
  const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);
  return `Last message: ${hoursSince.toFixed(1)} hours ago`;
}

// ============================================================
// TELEGRAM
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
  } catch {
    return false;
  }
}

// ============================================================
// CLAUDE DECISION
// ============================================================

async function askClaudeToDecide(): Promise<{
  shouldCheckin: boolean;
  message: string;
}> {
  const state = await loadState();
  const goals = await getGoals();
  const facts = await getFacts();
  const calendar = await getCalendarContext();
  const activity = await getLastActivity();

  const now = new Date();
  const hour = now.getHours();
  const timeContext =
    hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const prompt = `
You are a proactive AI assistant. Decide if you should check in with the user.

CONTEXT:
- Current time: ${now.toLocaleTimeString()} (${timeContext})
- ${activity}
- Last check-in: ${state.lastCheckinTime || "Never"}
- Active goals: ${goals.join(", ") || "None"}
- Known facts about user: ${facts.slice(0, 5).join(", ") || "None"}
- Calendar: ${calendar}
- Pending follow-ups: ${state.pendingItems.join(", ") || "None"}

RULES:
1. Don't be annoying - max 2-3 check-ins per day
2. Only check in if there's a REASON (goal deadline, long silence, important event)
3. Be brief and helpful, not intrusive
4. Consider time of day (don't interrupt deep work hours)
5. If nothing important, respond with NO_CHECKIN

RESPOND IN THIS EXACT FORMAT:
DECISION: YES or NO
MESSAGE: [Your message if YES, or "none" if NO]
REASON: [Why you decided this]
`;

  try {
    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();

    // Parse Claude's response
    const decisionMatch = output.match(/DECISION:\s*(YES|NO)/i);
    const messageMatch = output.match(/MESSAGE:\s*(.+?)(?=\nREASON:|$)/is);
    const reasonMatch = output.match(/REASON:\s*(.+)/is);

    const shouldCheckin = decisionMatch?.[1]?.toUpperCase() === "YES";
    const message = messageMatch?.[1]?.trim() || "";
    const reason = reasonMatch?.[1]?.trim() || "";

    console.log(`Decision: ${shouldCheckin ? "YES" : "NO"}`);
    console.log(`Reason: ${reason}`);

    return { shouldCheckin, message };
  } catch (error) {
    console.error("Claude error:", error);
    return { shouldCheckin: false, message: "" };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running smart check-in...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const { shouldCheckin, message } = await askClaudeToDecide();

  if (shouldCheckin && message && message !== "none") {
    console.log("Sending check-in...");
    const success = await sendTelegram(message);

    if (success) {
      // Update state
      const state = await loadState();
      state.lastCheckinTime = new Date().toISOString();
      await saveState(state);
      console.log("Check-in sent!");
    } else {
      console.error("Failed to send check-in");
    }
  } else {
    console.log("No check-in needed");
  }
}

main();

// ============================================================
// SCHEDULING
// ============================================================
/*
Run every 30 minutes:

CRON (Linux):
*/30 * * * * cd /path/to/relay && bun run examples/smart-checkin.ts

LAUNCHD (macOS) - save as ~/Library/LaunchAgents/com.claude.smart-checkin.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.smart-checkin</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOU/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/smart-checkin.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/relay</string>
    <key>StartInterval</key>
    <integer>1800</integer>  <!-- 30 minutes in seconds -->
</dict>
</plist>

WINDOWS Task Scheduler:
- Create task with "Daily" trigger
- Set to repeat every 30 minutes
*/
