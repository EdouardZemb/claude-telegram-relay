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
  }
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
  }
);

server.tool(
  "thought_stats",
  "Get aggregate statistics about the memory database: total count, breakdown by type, recent activity, top topics.",
  {},
  async () => {
    const results = await callEdgeFunction("thought_stats");
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  "capture_thought",
  "Store a new memory entry. Use for important facts, decisions, goals, or user preferences discovered during a session.",
  {
    content: z.string().describe("The memory content to store"),
    type: z.string().optional().describe("Memory type: fact, goal, preference, decision, context (default: fact)"),
    metadata: z.record(z.unknown()).optional().describe("Additional metadata (topics, source, etc.)"),
  },
  async ({ content, type, metadata }) => {
    const result = await callEdgeFunction("capture_thought", { content, type, metadata });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
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
    let url = "tasks?select=id,title,status,priority,sprint,project,description"
      + "&order=priority.asc,created_at.asc"
      + `&limit=${limit || 20}`
      + "&status=neq.cancelled";
    if (status) url += `&status=eq.${status}`;
    if (project) url += `&project=eq.${project}`;
    if (sprint) url += `&sprint=eq.${sprint}`;

    const data = await callSupabaseRest(url);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
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
  }
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
        .then((data: unknown) => { results.facts = data; })
        .catch(() => { results.facts = []; })
    );

    promises.push(
      callEdgeFunction("list_thoughts", { type: "goal", limit: 5 })
        .then((data: unknown) => { results.goals = data; })
        .catch(() => { results.goals = []; })
    );

    if (sprint) {
      promises.push(
        callRpc("get_sprint_summary", { p_sprint: sprint })
          .then((data: unknown) => { results.sprint_summary = data; })
          .catch(() => { results.sprint_summary = null; })
      );
    }

    let taskUrl = "tasks?select=id,title,status,priority,sprint&order=updated_at.desc&limit=10&status=neq.cancelled";
    if (project) taskUrl += `&project=eq.${project}`;
    promises.push(
      callSupabaseRest(taskUrl)
        .then((data: unknown) => { results.recent_tasks = data; })
        .catch(() => { results.recent_tasks = []; })
    );

    await Promise.all(promises);
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  }
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
    const data = await callSupabaseRest(url) as any[];

    if (!data?.length) {
      return { content: [{ type: "text" as const, text: `Blackboard not found for session: ${session_id}` }] };
    }

    const bb = data[0];
    const result = section
      ? { [section]: bb.sections?.[section] ?? null, version: bb.version }
      : bb;
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "write_blackboard",
  "Write data to a blackboard section. Uses optimistic locking (version check).",
  {
    session_id: z.string().describe("Blackboard session ID"),
    section: z.enum(["spec", "plan", "tasks", "implementation", "verification"]).describe("Section to write"),
    data: z.record(z.unknown()).describe("Data to write to the section"),
    role: z.string().describe("Agent role performing the write"),
  },
  async ({ session_id, section, data, role }) => {
    const current = await callSupabaseRest(`blackboard?session_id=eq.${session_id}&select=sections,version`) as any[];
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
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return { content: [{ type: "text" as const, text: `Write failed (version conflict?): ${text}` }] };
    }

    return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, version: newVersion }) }] };
  }
);

// ── S39: Code Graph Tools ────────────────────────────────────

import {
  loadGraph,
  indexCodebase,
  saveGraph,
  getModuleDependencies,
  getDependents,
  getImpactRadius,
  getGraphStats,
  findNode,
  formatGraphContext,
  estimateComplexity,
} from "../src/code-graph.ts";

server.tool(
  "query_dependencies",
  "Get direct dependencies of a module (what it imports).",
  {
    module: z.string().describe("Module path (e.g., 'src/orchestrator.ts' or 'orchestrator')"),
  },
  async ({ module }) => {
    const graph = loadGraph() || indexCodebase();
    const node = findNode(graph, module);
    if (!node) {
      return { content: [{ type: "text" as const, text: `Module not found: ${module}` }] };
    }
    const deps = getModuleDependencies(graph, node.id);
    const result = {
      module: node.id,
      exports: node.exports,
      lineCount: node.lineCount,
      dependencies: deps.map((d) => ({
        target: d.target,
        imports: d.imports,
        typeOnly: d.isTypeOnly,
      })),
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "query_dependents",
  "Get modules that depend on a given module (what imports it).",
  {
    module: z.string().describe("Module path (e.g., 'src/orchestrator.ts' or 'orchestrator')"),
  },
  async ({ module }) => {
    const graph = loadGraph() || indexCodebase();
    const node = findNode(graph, module);
    if (!node) {
      return { content: [{ type: "text" as const, text: `Module not found: ${module}` }] };
    }
    const deps = getDependents(graph, node.id);
    const result = {
      module: node.id,
      dependents: deps.map((d) => ({
        source: d.source,
        imports: d.imports,
      })),
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "query_impact_radius",
  "Get transitive impact radius of changing a module (BFS of dependents).",
  {
    module: z.string().describe("Module path"),
    depth: z.number().optional().describe("Max traversal depth (default 3)"),
  },
  async ({ module, depth }) => {
    const graph = loadGraph() || indexCodebase();
    const node = findNode(graph, module);
    if (!node) {
      return { content: [{ type: "text" as const, text: `Module not found: ${module}` }] };
    }
    const impact = getImpactRadius(graph, node.id, depth || 3);
    const complexity = estimateComplexity(graph, node.id);
    const result = {
      module: node.id,
      complexity: `${complexity}/10`,
      impactedModules: impact,
      stats: getGraphStats(graph),
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ── S44: Business Logic Server (Task Tools) ─────────────────

import { createClient } from "@supabase/supabase-js";
import {
  addTask,
  updateTaskStatus,
  getBacklog,
} from "../src/tasks.ts";
import {
  generatePRD,
  savePRD,
  getPRD,
  getPRDs,
  updatePRDStatus,
} from "../src/prd.ts";
import { readFile, writeFile, mkdir, rename as fsRename } from "fs/promises";
import { join } from "path";

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
        return { content: [{ type: "text" as const, text: "Error: failed to create task in Supabase" }] };
      }

      await enqueueMcpNotification({
        type: "task",
        severity: "normal",
        message: `Tache creee: ${task.title} (P${task.priority})${task.sprint ? ` [${task.sprint}]` : ""}`,
        data: { taskId: task.id, taskStatus: task.status },
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "task_update",
  "Update a task's status. Same effect as /start or /done on Telegram. Sends a notification to Telegram.",
  {
    task_id: z.string().describe("Task ID (full UUID or prefix, e.g., 'a1b2c3d4')"),
    status: z.enum(["backlog", "in_progress", "review", "done", "cancelled"]).describe("New status"),
  },
  async ({ task_id, status }) => {
    try {
      // Support ID prefix matching (same as the bot)
      let resolvedId = task_id;
      if (task_id.length < 36) {
        const tasks = await getBacklog(supabase);
        const match = tasks.find(t => t.id.startsWith(task_id));
        if (!match) {
          return { content: [{ type: "text" as const, text: `Error: no task found with ID prefix '${task_id}'` }] };
        }
        resolvedId = match.id;
      }

      const task = await updateTaskStatus(supabase, resolvedId, status);
      if (!task) {
        return { content: [{ type: "text" as const, text: `Error: failed to update task '${task_id}'` }] };
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
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// ── S44: Business Logic Server (PRD Tools) ──────────────────

server.tool(
  "prd_create",
  "Generate and save a PRD (Product Requirements Document) via Claude. Same effect as /prd create on Telegram. Sends a notification to Telegram.",
  {
    description: z.string().describe("Description of the feature/change to generate a PRD for"),
    project: z.string().optional().describe("Project name (default: telegram-relay)"),
    tags: z.array(z.string()).optional().describe("Tags array"),
    requested_by: z.string().optional().describe("Who requested this PRD"),
  },
  async ({ description, project, tags, requested_by }) => {
    try {
      const projectName = project ?? "telegram-relay";
      const generated = await generatePRD(description, projectName);

      if (!generated) {
        return { content: [{ type: "text" as const, text: "Error: PRD generation failed (Claude CLI may be unavailable)" }] };
      }

      const prd = await savePRD(supabase, generated, {
        project: projectName,
        tags,
        requested_by,
      });

      if (!prd) {
        return { content: [{ type: "text" as const, text: "Error: failed to save PRD in Supabase" }] };
      }

      await enqueueMcpNotification({
        type: "task",
        severity: "normal",
        message: `PRD cree: ${prd.title} [${prd.id.substring(0, 8)}] (${prd.project})`,
        data: { taskId: prd.id },
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(prd, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "prd_list",
  "List PRDs, optionally filtered by project and/or status. Same as /prd list on Telegram.",
  {
    project: z.string().optional().describe("Filter by project name"),
    status: z.string().optional().describe("Filter by status: draft, approved, rejected, superseded"),
  },
  async ({ project, status }) => {
    try {
      const prds = await getPRDs(supabase, { project, status });
      return { content: [{ type: "text" as const, text: JSON.stringify(prds, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "prd_get",
  "Get a specific PRD by ID or ID prefix. Same as /prd view on Telegram.",
  {
    prd_id: z.string().describe("PRD ID (full UUID or prefix, e.g., 'a1b2c3d4')"),
  },
  async ({ prd_id }) => {
    try {
      const prd = await getPRD(supabase, prd_id);
      if (!prd) {
        return { content: [{ type: "text" as const, text: `Error: no PRD found with ID prefix '${prd_id}'` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(prd, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "prd_approve",
  "Approve a PRD (change status to approved). Same as /prd approve on Telegram. Sends a notification to Telegram.",
  {
    prd_id: z.string().describe("PRD ID (full UUID or prefix)"),
  },
  async ({ prd_id }) => {
    try {
      const existing = await getPRD(supabase, prd_id);
      if (!existing) {
        return { content: [{ type: "text" as const, text: `Error: no PRD found with ID prefix '${prd_id}'` }] };
      }

      const prd = await updatePRDStatus(supabase, existing.id, "approved");
      if (!prd) {
        return { content: [{ type: "text" as const, text: `Error: failed to approve PRD '${prd_id}'` }] };
      }

      await enqueueMcpNotification({
        type: "task",
        severity: "normal",
        message: `PRD approuve: ${prd.title} [${prd.id.substring(0, 8)}]`,
        data: { taskId: prd.id },
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(prd, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

server.tool(
  "prd_reject",
  "Reject a PRD (change status to rejected). Same as /prd reject on Telegram. Sends a notification to Telegram.",
  {
    prd_id: z.string().describe("PRD ID (full UUID or prefix)"),
  },
  async ({ prd_id }) => {
    try {
      const existing = await getPRD(supabase, prd_id);
      if (!existing) {
        return { content: [{ type: "text" as const, text: `Error: no PRD found with ID prefix '${prd_id}'` }] };
      }

      const prd = await updatePRDStatus(supabase, existing.id, "rejected");
      if (!prd) {
        return { content: [{ type: "text" as const, text: `Error: failed to reject PRD '${prd_id}'` }] };
      }

      await enqueueMcpNotification({
        type: "task",
        severity: "normal",
        message: `PRD rejete: ${prd.title} [${prd.id.substring(0, 8)}]`,
        data: { taskId: prd.id },
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(prd, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
