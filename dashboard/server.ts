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
    // Extract optional project_id filter from query params
    const projectId = url.searchParams.get("project_id") || undefined;

    if (url.pathname === "/api/projects") {
      return handleProxyProjects();
    }

    if (url.pathname === "/api/tasks") {
      return handleProxyTasks(projectId);
    }

    if (url.pathname === "/api/prds") {
      return handleProxyPRDs(projectId);
    }

    if (url.pathname === "/api/metrics") {
      return handleProxyMetrics(projectId);
    }

    if (url.pathname === "/api/retros") {
      return handleProxyRetros(projectId);
    }

    if (url.pathname === "/api/agent-metrics") {
      return handleAgentMetrics(projectId);
    }

    if (url.pathname === "/api/workflow-audit") {
      return handleWorkflowAudit();
    }

    if (url.pathname === "/api/sprint-live") {
      return handleSprintLive();
    }

    return new Response("Not found", { status: 404 });
  },
});

async function handleProxyProjects(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  const { data, error } = await supabase
    .from("projects")
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

async function handleProxyTasks(projectId?: string): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  let query = supabase
    .from("tasks")
    .select("*")
    .neq("status", "cancelled")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (projectId) query = query.eq("project_id", projectId);

  const { data, error } = await query;
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

async function handleProxyPRDs(projectId?: string): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  let query = supabase
    .from("prds")
    .select("*")
    .order("created_at", { ascending: false });

  if (projectId) query = query.eq("project_id", projectId);

  const { data, error } = await query;
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

async function handleProxyMetrics(projectId?: string): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  let query = supabase
    .from("sprint_metrics")
    .select("*")
    .order("created_at", { ascending: true });

  if (projectId) query = query.eq("project_id", projectId);

  const { data, error } = await query;
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

async function handleProxyRetros(projectId?: string): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }
  let query = supabase
    .from("retros")
    .select("sprint_id, what_worked, what_didnt, patterns_detected, actions_proposed, actions_accepted, validated_at, created_at")
    .order("created_at", { ascending: false });

  if (projectId) query = query.eq("project_id", projectId);

  const { data, error } = await query;
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

async function handleAgentMetrics(projectId?: string): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
  }

  // Query orchestration logs from workflow_logs
  const { data: logs, error } = await supabase
    .from("workflow_logs")
    .select("step, metadata, created_at, duration_seconds, checkpoint_result")
    .or("step.like.orchestration_%,step.eq.orchestration,step.eq.code_review")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Aggregate per-agent stats
  const agentStats: Record<string, {
    runs: number;
    successes: number;
    totalDurationMs: number;
    avgDurationMs: number;
    lastRun: string | null;
  }> = {};

  for (const log of logs || []) {
    // Orchestration logs have metadata.results array
    const results = log.metadata?.results;
    if (Array.isArray(results)) {
      for (const r of results) {
        if (!r.agent) continue;
        if (!agentStats[r.agent]) {
          agentStats[r.agent] = { runs: 0, successes: 0, totalDurationMs: 0, avgDurationMs: 0, lastRun: null };
        }
        const stats = agentStats[r.agent];
        stats.runs++;
        if (r.success) stats.successes++;
        stats.totalDurationMs += r.durationMs || 0;
        if (!stats.lastRun) stats.lastRun = log.created_at;
      }
    }

    // Code review logs
    if (log.step === "code_review" && log.metadata) {
      const agent = "qa";
      if (!agentStats[agent]) {
        agentStats[agent] = { runs: 0, successes: 0, totalDurationMs: 0, avgDurationMs: 0, lastRun: null };
      }
      agentStats[agent].runs++;
      if (log.metadata.passes_gate) agentStats[agent].successes++;
      if (!agentStats[agent].lastRun) agentStats[agent].lastRun = log.created_at;
    }
  }

  // Compute averages
  for (const stats of Object.values(agentStats)) {
    stats.avgDurationMs = stats.runs > 0 ? Math.round(stats.totalDurationMs / stats.runs) : 0;
  }

  // Gate pass rates
  const { data: gateLogs } = await supabase
    .from("workflow_logs")
    .select("step, checkpoint_result, metadata")
    .eq("step", "code_review")
    .order("created_at", { ascending: false })
    .limit(50);

  const gateStats = {
    total: gateLogs?.length || 0,
    passed: gateLogs?.filter((l: any) => l.metadata?.passes_gate).length || 0,
    avgScore: 0,
  };
  const scores = (gateLogs || [])
    .map((l: any) => l.metadata?.score)
    .filter((s: any) => typeof s === "number");
  if (scores.length > 0) {
    gateStats.avgScore = Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length);
  }

  const response = {
    agents: agentStats,
    gates: gateStats,
    totalOrchestrations: logs?.filter((l: any) => l.step === "orchestration").length || 0,
  };

  return new Response(JSON.stringify(response, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleWorkflowAudit(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }

  const { data, error } = await supabase
    .from("workflow_audit")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

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

async function handleSprintLive(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify({ sprint: null }), { headers: { "Content-Type": "application/json" } });
  }

  // Find the current sprint by looking at tasks with the latest sprint ID
  const { data: latestTasks } = await supabase
    .from("tasks")
    .select("sprint")
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1);

  const currentSprint = latestTasks?.[0]?.sprint;
  if (!currentSprint) {
    return new Response(JSON.stringify({ sprint: null }), { headers: { "Content-Type": "application/json" } });
  }

  // Get all tasks for this sprint
  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, status, priority, updated_at, completed_at")
    .eq("sprint", currentSprint)
    .neq("status", "cancelled")
    .order("priority", { ascending: true });

  const allTasks = tasks || [];
  const done = allTasks.filter((t: any) => t.status === "done");
  const inProgress = allTasks.filter((t: any) => t.status === "in_progress");
  const backlog = allTasks.filter((t: any) => t.status === "backlog");

  // Get feedback rules status
  const { data: rules } = await supabase
    .from("feedback_rules")
    .select("id, agent_id, active, occurrences")
    .limit(20);

  // Get latest retro
  const { data: retros } = await supabase
    .from("retros")
    .select("sprint_id, validated_at")
    .order("created_at", { ascending: false })
    .limit(1);

  const response = {
    sprint: currentSprint,
    timestamp: new Date().toISOString(),
    progress: {
      total: allTasks.length,
      done: done.length,
      inProgress: inProgress.length,
      backlog: backlog.length,
      completionPct: allTasks.length > 0 ? Math.round((done.length / allTasks.length) * 100) : 0,
    },
    tasks: allTasks.map((t: any) => ({
      id: t.id.substring(0, 8),
      title: t.title,
      status: t.status,
      priority: t.priority,
      updatedAt: t.updated_at,
      completedAt: t.completed_at,
    })),
    feedbackRules: {
      total: rules?.length || 0,
      active: rules?.filter((r: any) => r.active).length || 0,
    },
    lastRetro: retros?.[0] || null,
  };

  return new Response(JSON.stringify(response, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

console.log(`Dashboard running at http://${HOST}:${PORT}`);
