#!/usr/bin/env npx tsx
/**
 * Memory MCP Server
 *
 * Wraps the memory-mcp Supabase Edge Function as a proper MCP server
 * so Claude Code can use memory tools (search, capture, list, stats).
 *
 * Transport: stdio (standard for Claude Code)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  process.exit(1);
}

const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/memory-mcp`;

async function callEdgeFunction(action: string, params: Record<string, unknown> = {}) {
  const response = await fetch(EDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action, ...params }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Edge function error (${response.status}): ${text}`);
  }

  return response.json();
}

const server = new McpServer({
  name: "memory",
  version: "1.0.0",
});

server.tool(
  "search_thoughts",
  "Semantic search across the memory database. Finds memories related to a query using embeddings.",
  {
    query: z.string().describe("Search query text"),
    limit: z.number().optional().describe("Max results (default 10)"),
    threshold: z.number().optional().describe("Similarity threshold 0-1 (default 0.7)"),
  },
  async ({ query, limit, threshold }) => {
    const results = await callEdgeFunction("search_thoughts", { query, limit, threshold });
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  "list_thoughts",
  "List recent memories, optionally filtered by type (fact, goal, preference, decision, context).",
  {
    type: z.string().optional().describe("Memory type filter"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ type, limit }) => {
    const results = await callEdgeFunction("list_thoughts", { type, limit });
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  "thought_stats",
  "Get aggregate statistics about the memory database: total count, breakdown by type, recent activity, top topics.",
  {},
  async () => {
    const results = await callEdgeFunction("thought_stats");
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  "capture_thought",
  "Store a new memory entry. Use for important facts, decisions, goals, or user preferences discovered during a session.",
  {
    content: z.string().describe("The memory content to store"),
    type: z
      .string()
      .optional()
      .describe("Memory type: fact, goal, preference, decision, context (default: fact)"),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("Additional metadata (topics, source, etc.)"),
  },
  async ({ content, type, metadata }) => {
    const result = await callEdgeFunction("capture_thought", { content, type, metadata });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── S32: Supabase REST helpers ────────────────────────────────

async function callSupabaseRest(path: string): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      Prefer: "return=representation",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase REST error (${response.status}): ${text}`);
  }

  return response.json();
}

async function callRpc(fn: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RPC error (${response.status}): ${text}`);
  }

  return response.json();
}

// ── S32: Project Context Tools ───────────────────────────────

server.tool(
  "get_tasks",
  "Get tasks from the project backlog. Filter by status, project, or sprint.",
  {
    status: z.string().optional().describe("Filter by status: backlog, in_progress, review, done"),
    project: z.string().optional().describe("Filter by project name"),
    sprint: z.string().optional().describe("Filter by sprint ID"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ status, project, sprint, limit }) => {
    let url =
      "tasks?select=id,title,status,priority,sprint,project,description" +
      "&order=priority.asc,created_at.asc" +
      `&limit=${limit || 20}` +
      "&status=neq.cancelled";
    if (status) url += `&status=eq.${status}`;
    if (project) url += `&project=eq.${project}`;
    if (sprint) url += `&sprint=eq.${sprint}`;

    const data = await callSupabaseRest(url);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_sprint_summary",
  "Get sprint progress summary: total, backlog, in_progress, review, done counts.",
  {
    sprint: z.string().describe("Sprint ID (e.g., 'S32')"),
  },
  async ({ sprint }) => {
    const data = await callRpc("get_sprint_summary", { p_sprint: sprint });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_project_context",
  "Get full project context: memory (facts/goals), sprint summary, recent tasks. One-shot context for agents.",
  {
    project: z.string().optional().describe("Project name filter"),
    sprint: z.string().optional().describe("Sprint ID for summary"),
  },
  async ({ project, sprint }) => {
    const results: Record<string, unknown> = {};
    const promises: Promise<void>[] = [];

    promises.push(
      callEdgeFunction("list_thoughts", { type: "fact", limit: 10 })
        .then((data: unknown) => {
          results.facts = data;
        })
        .catch(() => {
          results.facts = [];
        }),
    );

    promises.push(
      callEdgeFunction("list_thoughts", { type: "goal", limit: 5 })
        .then((data: unknown) => {
          results.goals = data;
        })
        .catch(() => {
          results.goals = [];
        }),
    );

    if (sprint) {
      promises.push(
        callRpc("get_sprint_summary", { p_sprint: sprint })
          .then((data: unknown) => {
            results.sprint_summary = data;
          })
          .catch(() => {
            results.sprint_summary = null;
          }),
      );
    }

    let taskUrl =
      "tasks?select=id,title,status,priority,sprint&order=updated_at.desc&limit=10&status=neq.cancelled";
    if (project) taskUrl += `&project=eq.${project}`;
    promises.push(
      callSupabaseRest(taskUrl)
        .then((data: unknown) => {
          results.recent_tasks = data;
        })
        .catch(() => {
          results.recent_tasks = [];
        }),
    );

    await Promise.all(promises);
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  },
);

// ── S32: Blackboard Tools ────────────────────────────────────

server.tool(
  "read_blackboard",
  "Read a blackboard section from a pipeline run. Sections: spec, plan, tasks, implementation, verification.",
  {
    session_id: z.string().describe("Blackboard session ID"),
    section: z.string().optional().describe("Section to read. Omit for full blackboard."),
  },
  async ({ session_id, section }) => {
    const url = `blackboard?session_id=eq.${session_id}&select=sections,version,status,pipeline_type`;
    // biome-ignore lint/suspicious/noExplicitAny: Supabase REST response
    const data = (await callSupabaseRest(url)) as any[];

    if (!data?.length) {
      return {
        content: [
          { type: "text" as const, text: `Blackboard not found for session: ${session_id}` },
        ],
      };
    }

    const bb = data[0];
    const result = section
      ? { [section]: bb.sections?.[section] ?? null, version: bb.version }
      : bb;
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "write_blackboard",
  "Write data to a blackboard section. Uses optimistic locking (version check).",
  {
    session_id: z.string().describe("Blackboard session ID"),
    section: z
      .enum(["spec", "plan", "tasks", "implementation", "verification"])
      .describe("Section to write"),
    data: z.record(z.unknown()).describe("Data to write to the section"),
    role: z.string().describe("Agent role performing the write"),
  },
  async ({ session_id, section, data, role }) => {
    const current = (await callSupabaseRest(
      `blackboard?session_id=eq.${session_id}&select=sections,version`,
      // biome-ignore lint/suspicious/noExplicitAny: Supabase REST response
    )) as any[];
    if (!current?.length) {
      return { content: [{ type: "text" as const, text: "Blackboard not found" }] };
    }

    const bb = current[0];
    const newVersion = bb.version + 1;
    const newSections = { ...bb.sections, [section]: data };

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/blackboard?session_id=eq.${session_id}&version=eq.${bb.version}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          sections: newSections,
          version: newVersion,
          updated_at: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        content: [{ type: "text" as const, text: `Write failed (version conflict?): ${text}` }],
      };
    }

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ success: true, version: newVersion }) },
      ],
    };
  },
);

// ── S44: Business Logic Server (Task Tools) ─────────────────

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { rename as fsRename, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { runAllChecks } from "../src/alerts.ts";
import { listFeatures, setFeature } from "../src/feature-flags.ts";
import { getSprintCostSummary, getTotalCost } from "../src/llm-ops.ts";
import {
  addTask,
  getBacklog,
  getCurrentSprint,
  getSprintSummary,
  updateTaskStatus,
} from "../src/tasks.ts";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const MCP_PENDING_FILE = join(RELAY_DIR, "mcp-pending-notifications.json");

interface McpNotification {
  type: "task" | "pr" | "idea" | "alert";
  severity: "critical" | "normal";
  message: string;
  data?: Record<string, unknown>;
  createdAt: number;
}

async function enqueueMcpNotification(notif: Omit<McpNotification, "createdAt">): Promise<void> {
  try {
    let pending: McpNotification[] = [];
    try {
      const content = await readFile(MCP_PENDING_FILE, "utf-8");
      pending = JSON.parse(content);
    } catch {
      // File doesn't exist yet — start fresh
    }
    pending.push({ ...notif, createdAt: Date.now() });
    await mkdir(RELAY_DIR, { recursive: true });
    const tmp = MCP_PENDING_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(pending, null, 2));
    await fsRename(tmp, MCP_PENDING_FILE);
  } catch (error) {
    console.error("MCP notification enqueue error:", error);
  }
}

// ── Async MCP Job Launcher ────────────────────────────────────
// Long-running MCP tools use this to run
// work in background and return immediately with a job ID.
// Completion notifications go through the existing mcp-pending-notifications bridge.

function _launchMcpBackgroundJob(
  type: string,
  _description: string,
  fn: () => Promise<string>,
): string {
  const jobId = randomUUID().slice(0, 8);

  // Fire-and-forget: run in background, notify on completion
  fn()
    .then(async (result) => {
      await enqueueMcpNotification({
        type: "task",
        severity: "normal",
        message: `[Job ${jobId}] ${type} termine\n${result}`,
        data: { jobId, jobType: type },
      });
    })
    .catch(async (error) => {
      const errMsg = error instanceof Error ? error.message : String(error);
      await enqueueMcpNotification({
        type: "alert",
        severity: "critical",
        message: `[Job ${jobId}] ${type} echoue: ${errMsg}`,
        data: { jobId, jobType: type },
      });
    });

  return jobId;
}

server.tool(
  "task_create",
  "Create a new task in the project backlog. Same effect as /task on Telegram. Sends a notification to Telegram.",
  {
    title: z.string().describe("Task title (required)"),
    description: z.string().optional().describe("Task description"),
    priority: z.number().min(1).max(5).optional().describe("Priority 1-5 (1=highest, default 3)"),
    sprint: z.string().optional().describe("Sprint ID (e.g., 'S44')"),
    project: z.string().optional().describe("Project name (default: telegram-relay)"),
    tags: z.array(z.string()).optional().describe("Tags array"),
  },
  async ({ title, description, priority, sprint, project, tags }) => {
    try {
      const task = await addTask(supabase, title, {
        description,
        priority,
        sprint,
        project,
        tags,
      });

      if (!task) {
        return {
          content: [{ type: "text" as const, text: "Error: failed to create task in Supabase" }],
        };
      }

      await enqueueMcpNotification({
        type: "task",
        severity: "normal",
        message: `Tache creee: ${task.title} (P${task.priority})${task.sprint ? ` [${task.sprint}]` : ""}`,
        data: { taskId: task.id, taskStatus: task.status },
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  "task_update",
  "Update a task's status. Same effect as /start or /done on Telegram. Sends a notification to Telegram.",
  {
    task_id: z.string().describe("Task ID (full UUID or prefix, e.g., 'a1b2c3d4')"),
    status: z
      .enum(["backlog", "in_progress", "review", "done", "cancelled"])
      .describe("New status"),
  },
  async ({ task_id, status }) => {
    try {
      // Support ID prefix matching (same as the bot)
      let resolvedId = task_id;
      if (task_id.length < 36) {
        const tasks = await getBacklog(supabase);
        const match = tasks.find((t) => t.id.startsWith(task_id));
        if (!match) {
          return {
            content: [
              { type: "text" as const, text: `Error: no task found with ID prefix '${task_id}'` },
            ],
          };
        }
        resolvedId = match.id;
      }

      const task = await updateTaskStatus(supabase, resolvedId, status);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: `Error: failed to update task '${task_id}'` }],
        };
      }

      const statusLabels: Record<string, string> = {
        backlog: "remise au backlog",
        in_progress: "demarree",
        review: "en review",
        done: "terminee",
        cancelled: "annulee",
      };

      await enqueueMcpNotification({
        type: "task",
        severity: "normal",
        message: `Tache ${statusLabels[status] || status}: ${task.title}`,
        data: { taskId: task.id, taskStatus: task.status },
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// ── MCP Business Tools: Sprint, Metrics, Cost, Alerts, Features, Planner ──

server.tool(
  "get_sprint_detail",
  "Get full sprint status: progress counts + task list with priorities. " +
    "Preconditions: none (root query). " +
    "Suggested next: get_metrics (performance), get_cost_summary (budget), get_alerts (anomalies), analyze_backlog (recommendations).",
  {
    sprint: z.string().optional().describe("Sprint ID (e.g., 'S44'). Omit for current sprint."),
  },
  async ({ sprint }) => {
    try {
      const sprintId = sprint || (await getCurrentSprint(supabase)) || "unknown";
      const [summary, tasks] = await Promise.all([
        getSprintSummary(supabase, sprintId),
        callSupabaseRest(
          `tasks?sprint=eq.${sprintId}&status=neq.cancelled` +
            `&select=id,title,status,priority,description,estimated_hours,actual_hours,tags` +
            `&order=priority.asc,status.asc`,
          // biome-ignore lint/suspicious/noExplicitAny: Supabase REST response
        ) as Promise<any[]>,
      ]);
      const completionRate =
        summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sprint: sprintId,
                summary: { ...summary, completionRate: `${completionRate}%` },
                tasks,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  "get_metrics",
  "Get sprint performance metrics: velocity, rework rate, cycle time, task completion. " +
    "Preconditions: better after get_sprint_detail (to know which sprint). " +
    "Suggested next: get_cost_summary (budget impact), get_alerts (anomalies), analyze_backlog (improvement suggestions).",
  {
    sprint: z.string().optional().describe("Sprint ID (e.g., 'S44'). Omit for current sprint."),
  },
  async ({ sprint }) => {
    try {
      const sprintId = sprint || (await getCurrentSprint(supabase)) || "unknown";
      const metricsUrl = `sprint_metrics?sprint_id=eq.${sprintId}&select=*&limit=1`;
      // biome-ignore lint/suspicious/noExplicitAny: Supabase REST response
      const metricsData = (await callSupabaseRest(metricsUrl)) as any[];

      // Also fetch task stats for the sprint
      const summary = await getSprintSummary(supabase, sprintId);

      // Fetch last 3 sprints for comparison
      const recentUrl =
        `sprint_metrics?select=sprint_id,velocity,rework_rate,cycle_time_hours,total_tasks,completed_tasks` +
        `&order=created_at.desc&limit=3`;
      // biome-ignore lint/suspicious/noExplicitAny: Supabase REST response
      const recent = (await callSupabaseRest(recentUrl)) as any[];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sprint: sprintId,
                metrics: metricsData?.[0] ?? null,
                taskSummary: summary,
                recentSprints: recent,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  "get_cost_summary",
  "Get token usage and cost breakdown by agent and task. " +
    "Preconditions: none (root query, but more useful after get_sprint_detail to know sprint scope). " +
    "Suggested next: analyze_backlog (cost-aware planning).",
  {
    sprint: z
      .string()
      .optional()
      .describe("Sprint ID for sprint-scoped costs. Omit for total across all sprints."),
  },
  async ({ sprint }) => {
    try {
      if (sprint) {
        const summary = await getSprintCostSummary(supabase, sprint);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ sprint, ...summary }, null, 2),
            },
          ],
        };
      } else {
        const total = await getTotalCost(supabase);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(total, null, 2),
            },
          ],
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  "get_alerts",
  "Run anomaly detection: stuck tasks, high rework rate, schedule slips, stale tasks, review score drops, agent failure patterns. " +
    "Preconditions: none (root query). " +
    "Suggested next: get_tasks (inspect flagged tasks), get_sprint_detail (sprint context), analyze_backlog (fix suggestions).",
  {
    sprint: z
      .string()
      .optional()
      .describe("Sprint ID for sprint-scoped checks. Omit for general checks."),
  },
  async ({ sprint }) => {
    try {
      const sprintId = sprint || (await getCurrentSprint(supabase)) || undefined;
      const alerts = await runAllChecks(supabase, sprintId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sprintChecked: sprintId ?? "none",
                alertCount: alerts.length,
                alerts: alerts.map((a) => ({
                  type: a.type,
                  severity: a.severity,
                  message: a.message,
                  data: a.data,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  "manage_feature",
  "List, enable, or disable feature flags. Controls optional features like intent_detection, deliberation, progressive_autonomy, etc. " +
    "Preconditions: none (independent). " +
    "Suggested next: none (standalone action).",
  {
    action: z
      .enum(["list", "enable", "disable"])
      .describe("Action: list all flags, enable a flag, or disable a flag"),
    flag: z
      .string()
      .optional()
      .describe("Flag name (required for enable/disable, e.g., 'intent_detection')"),
  },
  async ({ action, flag }) => {
    try {
      if (action === "list") {
        const features = listFeatures();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ features }, null, 2),
            },
          ],
        };
      }

      if (!flag) {
        return {
          content: [
            { type: "text" as const, text: "Error: flag name required for enable/disable" },
          ],
        };
      }

      const enabled = action === "enable";
      setFeature(flag, enabled);

      await enqueueMcpNotification({
        type: "alert",
        severity: "normal",
        message: `Feature flag ${flag} ${enabled ? "activee" : "desactivee"} via MCP`,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ flag, enabled, status: "updated" }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// ── Audit Tool ───────────────────────────────────────────────

server.tool(
  "audit_codebase",
  "Get the latest codebase audit results: global score, per-axis scores, and findings (gaps). " +
    "Reads from the audit_results table (populated by the heartbeat audit engine). " +
    "If no audit has been run yet, returns an empty result. " +
    "Preconditions: none (read-only query; audit must have been run at least once for data to exist). " +
    "Suggested next: get_alerts (anomalies), analyze_backlog (improvement suggestions).",
  {
    axis: z
      .string()
      .optional()
      .describe(
        "Filter by audit axis (e.g., 'security', 'structure', 'tests'). Omit for all axes.",
      ),
  },
  async ({ axis }) => {
    try {
      const url =
        "audit_results?select=id,global_score,axis_scores,findings,created_at" +
        "&order=created_at.desc&limit=1";
      // biome-ignore lint/suspicious/noExplicitAny: Supabase REST response
      const data = (await callSupabaseRest(url)) as any[];

      if (!data?.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message: "No audit results found. The audit engine has not run yet.",
                  score: null,
                  axis_scores: {},
                  findings: [],
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const row = data[0];

      if (axis) {
        const axisScore = row.axis_scores?.[axis] ?? null;
        const axisFindings = Array.isArray(row.findings)
          ? row.findings.filter(
              // biome-ignore lint/suspicious/noExplicitAny: dynamic findings shape
              (g: any) => g.axis === axis || g.type?.toLowerCase().includes(axis.toLowerCase()),
            )
          : [];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  axis,
                  score: axisScore,
                  globalScore: row.global_score,
                  findings: axisFindings,
                  created_at: row.created_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                score: row.global_score,
                axis_scores: row.axis_scores,
                findings: row.findings,
                created_at: row.created_at,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
