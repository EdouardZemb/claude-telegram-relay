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
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { readFile } from "fs/promises";
import { cpus, freemem, totalmem } from "os";
import { dirname, join } from "path";

const PORT = parseInt(process.env.DASHBOARD_PORT || "3456", 10);
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const ROOT = dirname(import.meta.path);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";

if (!DASHBOARD_TOKEN) {
  console.warn("WARNING: DASHBOARD_TOKEN not set. Dashboard is unprotected!");
}

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Track server start time for uptime
const SERVER_START = Date.now();

function checkAuth(req: Request): Response | null {
  if (!DASHBOARD_TOKEN) return null; // No token = no auth required
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token === DASHBOARD_TOKEN) return null; // Auth OK
  return new Response("Unauthorized. Add ?token=YOUR_TOKEN to the URL.", { status: 401 });
}

const _server = import.meta.main
  ? Bun.serve({
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

        if (url.pathname === "/api/code-reviews") {
          return handleCodeReviews();
        }

        if (url.pathname === "/api/autonomy-status") {
          return handleAutonomyStatus();
        }

        if (url.pathname === "/api/audit") {
          const limitParam = url.searchParams.get("limit");
          const axisParam = url.searchParams.get("axis") || undefined;
          return handleAudit(limitParam, axisParam);
        }

        return new Response("Not found", { status: 404 });
      },
    })
  : null;

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
  let query = supabase.from("prds").select("*").order("created_at", { ascending: false });

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
      load_avg: (() => {
        try {
          return require("os").loadavg();
        } catch {
          return [];
        }
      })(),
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
  let query = supabase.from("sprint_metrics").select("*").order("created_at", { ascending: true });

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
    .select(
      "sprint_id, what_worked, what_didnt, patterns_detected, actions_proposed, actions_accepted, validated_at, created_at",
    )
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

async function handleAgentMetrics(_projectId?: string): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
  }

  // Query orchestration logs from workflow_logs (filter via metadata->>type)
  const { data: logs, error } = await supabase
    .from("workflow_logs")
    .select("metadata, created_at, duration_seconds, checkpoint_result")
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Aggregate per-agent stats
  const agentStats: Record<
    string,
    {
      runs: number;
      successes: number;
      totalDurationMs: number;
      avgDurationMs: number;
      lastRun: string | null;
    }
  > = {};

  for (const log of logs || []) {
    const metadataType = log.metadata?.type;

    // Orchestration logs have metadata.results array
    if (metadataType === "orchestration") {
      const results = log.metadata?.results;
      if (Array.isArray(results)) {
        for (const r of results) {
          if (!r.agent) continue;
          if (!agentStats[r.agent]) {
            agentStats[r.agent] = {
              runs: 0,
              successes: 0,
              totalDurationMs: 0,
              avgDurationMs: 0,
              lastRun: null,
            };
          }
          const stats = agentStats[r.agent];
          stats.runs++;
          if (r.success) stats.successes++;
          stats.totalDurationMs += r.durationMs || 0;
          if (!stats.lastRun) stats.lastRun = log.created_at;
        }
      }
    }

    // Code review logs
    if (metadataType === "code_review" && log.metadata) {
      const agent = "qa";
      if (!agentStats[agent]) {
        agentStats[agent] = {
          runs: 0,
          successes: 0,
          totalDurationMs: 0,
          avgDurationMs: 0,
          lastRun: null,
        };
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
    .select("checkpoint_result, metadata")
    .eq("metadata->>type", "code_review")
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
    gateStats.avgScore = Math.round(
      scores.reduce((a: number, b: number) => a + b, 0) / scores.length,
    );
  }

  const response = {
    agents: agentStats,
    gates: gateStats,
    totalOrchestrations: logs?.filter((l: any) => l.metadata?.type === "orchestration").length || 0,
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
    return new Response(JSON.stringify({ sprint: null }), {
      headers: { "Content-Type": "application/json" },
    });
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
    return new Response(JSON.stringify({ sprint: null }), {
      headers: { "Content-Type": "application/json" },
    });
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

async function handleCodeReviews(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }

  // Fetch code review entries from workflow_logs
  const { data, error } = await supabase
    .from("workflow_logs")
    .select("task_id, metadata, created_at, duration_seconds")
    .eq("metadata->>type", "code_review")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Enrich with task titles
  const taskIds = [...new Set((data || []).map((d: any) => d.task_id).filter(Boolean))];
  let taskMap: Record<string, string> = {};
  if (taskIds.length > 0) {
    const { data: tasks } = await supabase.from("tasks").select("id, title").in("id", taskIds);
    if (tasks) {
      taskMap = Object.fromEntries(tasks.map((t: any) => [t.id, t.title]));
    }
  }

  const reviews = (data || []).map((r: any) => ({
    task_id: r.task_id,
    task_title: taskMap[r.task_id] || "Unknown",
    created_at: r.created_at,
    score: r.metadata?.score ?? null,
    passes_gate: r.metadata?.passes_gate ?? null,
    findings_count: r.metadata?.findings_count ?? 0,
    critical_count: r.metadata?.critical_count ?? 0,
    branch: r.metadata?.branch ?? null,
    summary: r.metadata?.summary ?? null,
  }));

  return new Response(JSON.stringify(reviews, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleAutonomyStatus(): Promise<Response> {
  if (!supabase) {
    return new Response(JSON.stringify({ error: "Supabase not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Trust scores
  const { data: trustData } = await supabase.from("trust_scores").select("*").order("agent_role");

  const trustScores = (trustData || []).map((row: any) => {
    const passRate =
      row.total_evaluations > 0 ? Math.round((row.total_passes / row.total_evaluations) * 100) : 0;
    return {
      role: row.agent_role,
      score: row.score,
      consecutivePasses: row.consecutive_passes,
      consecutiveFailures: row.consecutive_failures,
      totalEvaluations: row.total_evaluations,
      passRate,
      lastEvaluationAt: row.last_evaluation_at,
    };
  });

  // Recent gate evaluations (last 10)
  const { data: gateData } = await supabase
    .from("gate_evaluations")
    .select(
      "agent_role, gate_name, score, passed, auto_approved, rework_iteration, rubric_dimensions, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(10);

  const recentGates = (gateData || []).map((row: any) => ({
    agentRole: row.agent_role,
    gateName: row.gate_name,
    score: row.score,
    passed: row.passed,
    autoApproved: row.auto_approved,
    reworkIteration: row.rework_iteration,
    rubricDimensions: row.rubric_dimensions,
    createdAt: row.created_at,
  }));

  // Active feedback rules
  const { data: rulesData } = await supabase
    .from("feedback_rules")
    .select("agent_id, pattern, instruction, occurrences, active, promoted, archived")
    .order("occurrences", { ascending: false })
    .limit(20);

  const feedbackRules = (rulesData || []).map((row: any) => ({
    agentId: row.agent_id,
    pattern: row.pattern,
    instruction: row.instruction?.substring(0, 100),
    occurrences: row.occurrences,
    active: row.active,
    promoted: row.promoted || false,
    archived: row.archived || false,
  }));

  const response = {
    timestamp: new Date().toISOString(),
    trustScores,
    recentGates,
    feedbackRules: {
      total: feedbackRules.length,
      active: feedbackRules.filter((r: any) => r.active).length,
      promoted: feedbackRules.filter((r: any) => r.promoted).length,
      archived: feedbackRules.filter((r: any) => r.archived).length,
      rules: feedbackRules,
    },
  };

  return new Response(JSON.stringify(response, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleAudit(
  limitParam: string | null,
  axisParam?: string,
  sb?: typeof supabase,
): Promise<Response> {
  const client = sb ?? supabase;
  if (!client) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }

  const limit = Math.max(1, Math.min(50, parseInt(limitParam || "1", 10) || 1));

  const { data, error } = await client
    .from("audit_results")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let results = data ?? [];

  if (axisParam) {
    results = results.filter(
      (row: any) =>
        row.axis_scores && typeof row.axis_scores === "object" && axisParam in row.axis_scores,
    );
  }

  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" },
  });
}

if (import.meta.main) {
  console.log(`Dashboard running at http://${HOST}:${PORT}`);
}
