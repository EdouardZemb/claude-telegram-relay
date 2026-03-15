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

const transport = new StdioServerTransport();
await server.connect(transport);
