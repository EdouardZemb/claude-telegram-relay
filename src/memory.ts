/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * The relay parses these tags, saves to Supabase, and strips them
 * from the response before sending to the user.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Classification result from the classify-thought Edge Function */
export interface ThoughtClassification {
  type: string;
  topics: string[];
  people: string[];
  action_items: string[];
  is_memorable: boolean;
  summary: string;
}

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const { error } = await supabase.from("memory").insert({
      type: "fact",
      content: match[1],
    });
    if (error) console.error("memory insert (fact) error:", error);
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    const { error } = await supabase.from("memory").insert({
      type: "goal",
      content: match[1],
      deadline: match[2] || null,
    });
    if (error) console.error("memory insert (goal) error:", error);
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "goal")
      .ilike("content", `%${match[1]}%`)
      .limit(1);

    if (data?.[0]) {
      const { error } = await supabase
        .from("memory")
        .update({
          type: "completed_goal",
          completed_at: new Date().toISOString(),
        })
        .eq("id", data[0].id);
      if (error) console.error("memory update (complete goal) error:", error);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null
): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

/**
 * Get the most recent messages for conversational continuity.
 */
export async function getRecentMessages(
  supabase: SupabaseClient | null,
  limit: number = 20
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!data?.length) return "";

    const messages = data
      .reverse()
      .map((m: any) => `[${m.role}]: ${m.content}`)
      .join("\n");

    return "RECENT CONVERSATION:\n" + messages;
  } catch (error) {
    console.error("Recent messages error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant past messages via the search Edge Function.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query, match_count: 5, table: "messages" },
    });

    if (error || !data?.length) return "";

    return (
      "RELEVANT PAST MESSAGES:\n" +
      data
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
}

/**
 * Classify a message via the classify-thought Edge Function.
 * Returns structured metadata (type, topics, action_items, is_memorable).
 * Fails silently if the Edge Function is not deployed.
 */
export async function classifyMessage(
  supabase: SupabaseClient | null,
  content: string,
  role: string = "user"
): Promise<ThoughtClassification | null> {
  if (!supabase || !content) return null;

  try {
    const { data, error } = await supabase.functions.invoke("classify-thought", {
      body: { content, role },
    });

    if (error || !data) return null;
    return data as ThoughtClassification;
  } catch {
    return null;
  }
}

/**
 * Auto-store a memorable message as a fact in the memory table.
 * Called when classify-thought flags is_memorable=true.
 * Stores the classification metadata in the metadata jsonb column.
 */
export async function autoRemember(
  supabase: SupabaseClient | null,
  content: string,
  classification: ThoughtClassification
): Promise<void> {
  if (!supabase || !classification.is_memorable) return;

  try {
    const memoryContent = classification.summary || content;

    const { error } = await supabase.from("memory").insert({
      type: "fact",
      content: memoryContent,
      metadata: {
        auto_classified: true,
        thought_type: classification.type,
        topics: classification.topics,
        people: classification.people,
        action_items: classification.action_items,
        source: "auto-detect",
      },
    });

    if (error) console.error("auto-remember insert error:", error);
  } catch (error) {
    console.error("auto-remember error:", error);
  }
}

/**
 * Archive old memories (completed goals > 90 days, stale facts > 90 days).
 * Calls the archive_old_memories RPC.
 */
export async function archiveOldMemories(
  supabase: SupabaseClient | null,
  daysThreshold: number = 90
): Promise<number> {
  if (!supabase) return 0;

  try {
    const { data, error } = await supabase.rpc("archive_old_memories", {
      days_threshold: daysThreshold,
    });

    if (error) {
      console.error("archive memories error:", error);
      return 0;
    }

    return data || 0;
  } catch (error) {
    console.error("archive memories error:", error);
    return 0;
  }
}
