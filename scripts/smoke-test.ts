/**
 * Smoke Tests — Post-deploy validation (S29-T3)
 *
 * 5 checks: PM2 services, Dashboard health, Supabase connectivity,
 * Claude CLI, Telegram bot. Each with 10s timeout.
 *
 * Run: bun run smoke
 */

import { createClient } from "@supabase/supabase-js";
import { spawn, spawnSync } from "bun";
import "dotenv/config";

// ── Types ────────────────────────────────────────────────────

interface SmokeResult {
  check: string;
  status: "pass" | "fail" | "warning";
  detail: string;
  durationMs: number;
}

// ── Helpers ──────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ]);
}

// ── Checks ───────────────────────────────────────────────────

async function checkPM2(): Promise<SmokeResult> {
  const start = Date.now();
  try {
    const result = spawnSync(["npx", "pm2", "jlist"], { timeout: 10000 });
    const output = new TextDecoder().decode(result.stdout).trim();
    const apps = JSON.parse(output) as Array<{
      name: string;
      pm2_env: { status: string; restart_time: number };
    }>;

    const expected = ["claude-relay", "claude-dashboard"];
    const issues: string[] = [];

    for (const name of expected) {
      const app = apps.find((a) => a.name === name);
      if (!app) {
        issues.push(`${name}: missing`);
      } else if (app.pm2_env.status !== "online") {
        issues.push(`${name}: ${app.pm2_env.status}`);
      }
    }

    const totalRestarts = apps.reduce((sum, a) => sum + (a.pm2_env?.restart_time || 0), 0);

    if (issues.length > 0) {
      return {
        check: "PM2",
        status: "fail",
        detail: issues.join(", "),
        durationMs: Date.now() - start,
      };
    }

    return {
      check: "PM2",
      status: "pass",
      detail: `${apps.length} services online, ${totalRestarts} restarts total`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { check: "PM2", status: "fail", detail: String(err), durationMs: Date.now() - start };
  }
}

async function checkDashboard(): Promise<SmokeResult> {
  const start = Date.now();
  const port = process.env.DASHBOARD_PORT || "3456";
  try {
    const res = await withTimeout(fetch(`http://localhost:${port}/api/health`), 10000);
    if (!res.ok) {
      return {
        check: "Dashboard",
        status: "fail",
        detail: `HTTP ${res.status}`,
        durationMs: Date.now() - start,
      };
    }
    const body = await res.json();
    return {
      check: "Dashboard",
      status: "pass",
      detail: `status=${body.status || "ok"}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      check: "Dashboard",
      status: "fail",
      detail: String(err),
      durationMs: Date.now() - start,
    };
  }
}

async function checkSupabase(): Promise<SmokeResult> {
  const start = Date.now();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return {
      check: "Supabase",
      status: "warning",
      detail: "SUPABASE_URL or SUPABASE_ANON_KEY not set",
      durationMs: Date.now() - start,
    };
  }

  try {
    const supabase = createClient(url, key);
    const testRow = { event: "smoke_test", metadata: { ts: Date.now() } };
    const { data, error: insertErr } = await withTimeout(
      supabase.from("logs").insert(testRow).select(),
      10000,
    );

    if (insertErr) {
      return {
        check: "Supabase",
        status: "fail",
        detail: `Insert failed: ${insertErr.message}`,
        durationMs: Date.now() - start,
      };
    }

    // Cleanup
    if (data?.[0]?.id) {
      await supabase.from("logs").delete().eq("id", data[0].id);
    }

    return {
      check: "Supabase",
      status: "pass",
      detail: "insert+delete OK",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      check: "Supabase",
      status: "fail",
      detail: String(err),
      durationMs: Date.now() - start,
    };
  }
}

async function checkClaudeCLI(): Promise<SmokeResult> {
  const start = Date.now();
  try {
    const claudePath = process.env.CLAUDE_PATH || "claude";
    const proc = spawn(
      [
        claudePath,
        "-p",
        "Reply with exactly: SMOKE_OK",
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      },
    );

    const stdout = await withTimeout(new Response(proc.stdout).text(), 15000);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return {
        check: "Claude CLI",
        status: "fail",
        detail: `exit code ${exitCode}`,
        durationMs: Date.now() - start,
      };
    }

    if (!stdout.includes("SMOKE_OK")) {
      return {
        check: "Claude CLI",
        status: "warning",
        detail: "Response didn't contain SMOKE_OK",
        durationMs: Date.now() - start,
      };
    }

    return { check: "Claude CLI", status: "pass", detail: "OK", durationMs: Date.now() - start };
  } catch (err) {
    // Rate limit or timeout -> warning, not failure
    const msg = String(err);
    if (msg.includes("Timeout") || msg.includes("rate")) {
      return {
        check: "Claude CLI",
        status: "warning",
        detail: msg,
        durationMs: Date.now() - start,
      };
    }
    return { check: "Claude CLI", status: "fail", detail: msg, durationMs: Date.now() - start };
  }
}

async function checkTelegram(): Promise<SmokeResult> {
  const start = Date.now();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const userId = process.env.TELEGRAM_USER_ID;

  if (!token || !userId) {
    return {
      check: "Telegram",
      status: "warning",
      detail: "TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID not set",
      durationMs: Date.now() - start,
    };
  }

  try {
    const res = await withTimeout(
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          text: "Smoke test OK",
        }),
      }),
      10000,
    );

    if (!res.ok) {
      // Telegram API down -> warning
      return {
        check: "Telegram",
        status: "warning",
        detail: `HTTP ${res.status}`,
        durationMs: Date.now() - start,
      };
    }

    return {
      check: "Telegram",
      status: "pass",
      detail: "message sent",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      check: "Telegram",
      status: "warning",
      detail: String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("Running smoke tests...\n");

  const results: SmokeResult[] = [];

  // Run all checks
  const checks = [checkPM2, checkDashboard, checkSupabase, checkClaudeCLI, checkTelegram];

  for (const check of checks) {
    try {
      const result = await check();
      results.push(result);
      const icon = result.status === "pass" ? "OK" : result.status === "warning" ? "!!" : "XX";
      console.log(`  [${icon}] ${result.check}: ${result.detail} (${result.durationMs}ms)`);
    } catch (err) {
      console.log(`  [XX] Unknown: ${err}`);
    }
  }

  // Report
  const failed = results.filter((r) => r.status === "fail");
  const warned = results.filter((r) => r.status === "warning");
  const passed = results.filter((r) => r.status === "pass");

  console.log("");
  console.log(`Results: ${passed.length} pass, ${warned.length} warning, ${failed.length} fail`);

  // Build report for Telegram notification
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  const report = [
    `Smoke Test — ${failed.length === 0 ? "OK" : "ECHEC"}`,
    "",
    ...results.map((r) => {
      const icon = r.status === "pass" ? "OK" : r.status === "warning" ? "!!" : "XX";
      return `  [${icon}] ${r.check}: ${r.detail} (${r.durationMs}ms)`;
    }),
    "",
    `Total: ${Math.round(totalDuration / 1000)}s`,
  ].join("\n");

  // Send report to Telegram if configured
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groupId = process.env.TELEGRAM_GROUP_ID;
  const userId = process.env.TELEGRAM_USER_ID;
  const chatId = groupId || userId;
  const threadId = process.env.SERVER_THREAD_ID || "7";

  if (token && chatId) {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text: report };
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

  // Exit code
  if (failed.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

export type { SmokeResult };
// Export for testing
export { checkClaudeCLI, checkDashboard, checkPM2, checkSupabase, checkTelegram };

// Only run main when executed directly (not when imported for testing)
if (import.meta.main) {
  main();
}
