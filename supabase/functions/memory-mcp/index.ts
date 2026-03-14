/**
 * Memory MCP Edge Function
 *
 * Exposes the memory system as an MCP-compatible API.
 * 4 endpoints matching the Open Brain pattern:
 *
 * POST /memory-mcp
 *   body: { action, ...params }
 *
 * Actions:
 *   search_thoughts  - Semantic search across memory (query, limit?, threshold?)
 *   list_thoughts    - List recent memories with optional type filter (type?, limit?)
 *   thought_stats    - Aggregate stats (count by type, topics, recent activity)
 *   capture_thought  - Insert a new memory entry (content, type?, metadata?)
 *
 * Secrets required:
 *   OPENAI_API_KEY — for semantic search embedding generation
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from "npm:@supabase/supabase-js@2";

function getClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

async function searchThoughts(params: {
  query: string;
  limit?: number;
  threshold?: number;
}) {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");

  const embeddingResponse = await fetch(
    "https://api.openai.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: params.query,
      }),
    }
  );

  if (!embeddingResponse.ok) {
    throw new Error(`OpenAI error: ${await embeddingResponse.text()}`);
  }

  const { data } = await embeddingResponse.json();
  const embedding = data[0].embedding;

  const supabase = getClient();
  const { data: results, error } = await supabase.rpc("match_memory", {
    query_embedding: embedding,
    match_threshold: params.threshold ?? 0.7,
    match_count: params.limit ?? 10,
  });

  if (error) throw new Error(error.message);
  return results || [];
}

async function listThoughts(params: { type?: string; limit?: number }) {
  const supabase = getClient();
  let query = supabase
    .from("memory")
    .select("id, type, content, metadata, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 20);

  if (params.type) {
    query = query.eq("type", params.type);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function thoughtStats() {
  const supabase = getClient();

  const { data: all, error } = await supabase
    .from("memory")
    .select("type, metadata, created_at");

  if (error) throw new Error(error.message);
  if (!all) return { total: 0, by_type: {}, recent_7d: 0 };

  const byType: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let recent = 0;

  for (const row of all) {
    byType[row.type] = (byType[row.type] || 0) + 1;
    if (new Date(row.created_at) > sevenDaysAgo) recent++;
    const topics = row.metadata?.topics;
    if (Array.isArray(topics)) {
      for (const t of topics) {
        topicCounts[t] = (topicCounts[t] || 0) + 1;
      }
    }
  }

  // Top 10 topics
  const topTopics = Object.entries(topicCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));

  return {
    total: all.length,
    by_type: byType,
    recent_7d: recent,
    top_topics: topTopics,
  };
}

async function captureThought(params: {
  content: string;
  type?: string;
  metadata?: Record<string, unknown>;
}) {
  const supabase = getClient();

  const { data, error } = await supabase
    .from("memory")
    .insert({
      type: params.type || "fact",
      content: params.content,
      metadata: {
        ...(params.metadata || {}),
        source: "mcp",
      },
    })
    .select("id, type, content, created_at")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

Deno.serve(async (req) => {
  try {
    const { action, ...params } = await req.json();

    let result: unknown;

    switch (action) {
      case "search_thoughts":
        result = await searchThoughts(params as any);
        break;
      case "list_thoughts":
        result = await listThoughts(params as any);
        break;
      case "thought_stats":
        result = await thoughtStats();
        break;
      case "capture_thought":
        result = await captureThought(params as any);
        break;
      default:
        return new Response(
          JSON.stringify({
            error: `Unknown action: ${action}`,
            available: [
              "search_thoughts",
              "list_thoughts",
              "thought_stats",
              "capture_thought",
            ],
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
