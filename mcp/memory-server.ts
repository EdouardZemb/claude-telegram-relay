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

const transport = new StdioServerTransport();
await server.connect(transport);
