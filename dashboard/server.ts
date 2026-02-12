/**
 * Dashboard Server
 *
 * Serves a kanban board that reads tasks from Supabase.
 * Run: bun run dashboard/server.ts
 *
 * Authentication: token-based via ?token= query parameter.
 * Set DASHBOARD_TOKEN in .env to protect access.
 */

import "dotenv/config";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { cpus, totalmem, freemem } from "os";

const PORT = parseInt(process.env.DASHBOARD_PORT || "3456");
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const ROOT = dirname(import.meta.path);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";

if (!DASHBOARD_TOKEN) {
  console.warn("WARNING: DASHBOARD_TOKEN not set. Dashboard is unprotected!");
}

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// Track server start time for uptime
const SERVER_START = Date.now();

function checkAuth(req: Request): Response | null {
  if (!DASHBOARD_TOKEN) return null; // No token = no auth required
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token === DASHBOARD_TOKEN) return null; // Auth OK
  return new Response("Unauthorized. Add ?token=YOUR_TOKEN to the URL.", { status: 401 });
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);

    // Health-check endpoint — no auth required
    if (url.pathname === "/api/health") {
      return handleHealthCheck();
    }

    // All other routes require auth
    const authError = checkAuth(req);
    if (authError) return authError;

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(join(ROOT, "index.html"), "utf-8");
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // API proxy — serve Supabase data without exposing keys to client
    if (url.pathname === "/api/tasks") {
      return handleProxyTasks();
    }

    if (url.pathname === "/api/prds") {
      return handleProxyPRDs();
    }

    if (url.pathname === "/api/metrics") {
      return handleProxyMetrics();
    }

    if (url.pathname === "/api/retros") {
      return handleProxyRetros();
    }

    return new Response("Not found", { status: 404 });
  },
});

async function handleProxyTasks(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .neq("status", "cancelled")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(data ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleProxyPRDs(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  const { data, error } = await supabase
    .from("prds")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(data ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleHealthCheck(): Promise<Response> {
  const health: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round((Date.now() - SERVER_START) / 1000),
    system: {
      cpus: cpus().length,
      memory_total_mb: Math.round(totalmem() / 1024 / 1024),
      memory_free_mb: Math.round(freemem() / 1024 / 1024),
      memory_used_pct: Math.round((1 - freemem() / totalmem()) * 100),
      load_avg: (() => { try { return require("os").loadavg(); } catch { return []; } })(),
    },
    services: {} as Record<string, unknown>,
  };

  // PM2 status
  try {
    const pm2Output = execSync("npx pm2 jlist 2>/dev/null", { timeout: 5000 }).toString();
    const pm2Apps = JSON.parse(pm2Output);
    for (const app of pm2Apps) {
      (health.services as Record<string, unknown>)[app.name] = {
        status: app.pm2_env?.status || "unknown",
        pid: app.pid,
        uptime_ms: app.pm2_env?.pm_uptime ? Date.now() - app.pm2_env.pm_uptime : null,
        restarts: app.pm2_env?.restart_time || 0,
        memory_mb: Math.round((app.monit?.memory || 0) / 1024 / 1024),
      };
    }
  } catch {
    (health.services as Record<string, unknown>).pm2 = "unavailable";
  }

  // Supabase connectivity
  if (supabase) {
    try {
      const { count, error } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true });
      (health as any).supabase = {
        connected: !error,
        message_count: count ?? 0,
      };
    } catch {
      (health as any).supabase = { connected: false };
    }
  }

  // Last message processed
  if (supabase) {
    try {
      const { data } = await supabase
        .from("messages")
        .select("created_at, role")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (data) {
        (health as any).last_message = {
          role: data.role,
          at: data.created_at,
        };
      }
    } catch {}
  }

  return new Response(JSON.stringify(health, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleProxyMetrics(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  const { data, error } = await supabase
    .from("sprint_metrics")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(data ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleProxyRetros(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  const { data, error } = await supabase
    .from("retros")
    .select("sprint_id, what_worked, what_didnt, patterns_detected, actions_proposed, actions_accepted, validated_at, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(data ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

console.log(`Dashboard running at http://${HOST}:${PORT}`);
