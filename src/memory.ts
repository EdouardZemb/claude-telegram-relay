/**
 * @module memory
 * @description Intelligent memory: intent tags, auto-classification, semantic archive,
 * ideas pipeline, importance scoring with temporal decay, contradiction detection.
 */

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
 *
 * S23: Importance scoring with temporal decay. Memories have an
 * importance_score (0-100) that decays exponentially over time
 * and is boosted when accessed. getMemoryContext returns top-ranked
 * memories instead of all.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyIdeaCreated } from "./notifications.ts";

// ── Memory Importance & Decay (S23-02) ───────────────────────

/** Half-life in days for exponential decay */
const DECAY_HALF_LIFE_DAYS = 70;

/** Max facts injected into prompt context */
const MAX_FACTS_IN_CONTEXT = 20;

/** Max goals injected into prompt context */
const MAX_GOALS_IN_CONTEXT = 10;

/**
 * Calculate the effective importance of a memory, applying temporal decay.
 *
 * Formula: effective = base_score * 2^(-age_days / half_life)
 * A memory with score 50 at 70 days old → effective 25.
 * Access boosts: each access adds +2 to effective (capped at base_score).
 */
export function calculateEffectiveImportance(
  baseScore: number,
  createdAt: string | Date,
  lastAccessedAt: string | Date | null,
  accessCount: number = 0,
  referenceDate: Date = new Date()
): number {
  const created = new Date(createdAt);
  const ageDays = (referenceDate.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);

  // Exponential decay
  const decayFactor = Math.pow(2, -ageDays / DECAY_HALF_LIFE_DAYS);
  let effective = baseScore * decayFactor;

  // Access boost: +2 per access, capped at base score
  const accessBoost = Math.min(accessCount * 2, baseScore * 0.5);
  effective += accessBoost;

  // Recency boost: if accessed in last 7 days, small bonus
  if (lastAccessedAt) {
    const lastAccess = new Date(lastAccessedAt);
    const daysSinceAccess = (referenceDate.getTime() - lastAccess.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceAccess < 7) {
      effective += 5 * (1 - daysSinceAccess / 7);
    }
  }

  return Math.max(0, Math.min(100, Math.round(effective * 100) / 100));
}

/**
 * Bump access stats for memories used in context.
 * Called after getMemoryContext to track which memories were served.
 */
export async function bumpMemoryAccess(
  supabase: SupabaseClient | null,
  memoryIds: string[]
): Promise<void> {
  if (!supabase || memoryIds.length === 0) return;

  try {
    const { error } = await supabase.rpc("bump_memory_access", {
      memory_ids: memoryIds,
    });
    if (error) console.error("bump_memory_access error:", error);
  } catch (error) {
    console.error("bump_memory_access error:", error);
  }
}

/** Classification result from the classify-thought Edge Function */
export interface ThoughtClassification {
  type: string;
  topics: string[];
  people: string[];
  action_items: string[];
  is_memorable: boolean;
  is_idea?: boolean;
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

  // [IDEA: idea to capture]
  for (const match of response.matchAll(/\[IDEA:\s*(.+?)\]/gi)) {
    // Semantic deduplication (S21-04)
    const duplicate = await findDuplicateIdea(supabase, match[1]);
    if (duplicate) {
      console.log(`Idea deduplicated (similar to: "${duplicate}")`);
      clean = clean.replace(match[0], "");
      continue;
    }
    const { error } = await supabase.from("memory").insert({
      type: "idea",
      content: match[1],
      idea_status: "new",
      metadata: { source: "intent-tag" },
    });
    if (error) console.error("memory insert (idea) error:", error);
    else await notifyIdeaCreated(match[1], "intent-tag");
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
 * Get top-ranked facts and active goals for prompt context.
 * S23-03: Ranked by importance score (DB-side), limited to top N.
 * Bumps access stats for served memories.
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
    const servedIds: string[] = [];

    if (factsResult.data?.length) {
      // Take top N facts (already ordered by importance_score DESC from DB)
      const topFacts = factsResult.data.slice(0, MAX_FACTS_IN_CONTEXT);
      parts.push(
        "FACTS:\n" +
          topFacts.map((f: any) => `- ${f.content}`).join("\n")
      );
      servedIds.push(...topFacts.map((f: any) => f.id).filter(Boolean));
    }

    if (goalsResult.data?.length) {
      // Take top N goals (already ordered by importance_score DESC from DB)
      const topGoals = goalsResult.data.slice(0, MAX_GOALS_IN_CONTEXT);
      parts.push(
        "GOALS:\n" +
          topGoals
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
      servedIds.push(...topGoals.map((g: any) => g.id).filter(Boolean));
    }

    // Bump access stats asynchronously (fire and forget)
    if (servedIds.length > 0) {
      bumpMemoryAccess(supabase, servedIds).catch(() => {});
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
 * Resolve the memory type from a classification.
 * Routes ideas, preferences, and decisions to their proper DB types.
 */
function resolveMemoryType(classification: ThoughtClassification): "idea" | "preference" | "fact" {
  if (classification.is_idea === true || classification.type === "idea") return "idea";
  if (classification.type === "decision" || classification.type === "reference") return "fact";
  // classify-thought doesn't return "preference" as type, but guard for future
  if (classification.type === "preference") return "preference";
  return "fact";
}

/**
 * Auto-store a memorable message in the memory table.
 * Called when classify-thought flags is_memorable=true.
 * Routes to the correct memory type: idea, preference, or fact.
 * Also auto-creates goals from detected action_items.
 */
export async function autoRemember(
  supabase: SupabaseClient | null,
  content: string,
  classification: ThoughtClassification
): Promise<void> {
  if (!supabase || !classification.is_memorable) return;

  try {
    const memoryContent = classification.summary || content;
    const memoryType = resolveMemoryType(classification);

    // Semantic deduplication for ideas (S21-04)
    if (memoryType === "idea") {
      const duplicate = await findDuplicateIdea(supabase, memoryContent);
      if (duplicate) {
        console.log(`Idea deduplicated (similar to: "${duplicate}")`);
        return;
      }
    }

    const metadata: Record<string, unknown> = {
      auto_classified: true,
      thought_type: classification.type,
      topics: classification.topics,
      people: classification.people,
      action_items: classification.action_items,
      source: "auto-detect",
    };

    // For ideas, keep original content for better deduplication
    if (memoryType === "idea" && classification.summary && classification.summary !== content) {
      metadata.original_content = content;
    }

    const { error } = await supabase.from("memory").insert({
      type: memoryType,
      content: memoryContent,
      ...(memoryType === "idea" ? { idea_status: "new" } : {}),
      metadata,
    });

    if (error) console.error("auto-remember insert error:", error);
    else if (memoryType === "idea") await notifyIdeaCreated(memoryContent, "auto-detect");

    // Auto-create goals from action_items
    if (classification.action_items?.length) {
      for (const item of classification.action_items) {
        const { error: goalError } = await supabase.from("memory").insert({
          type: "goal",
          content: item,
          metadata: { auto_classified: true, source: "action-item", topics: classification.topics },
        });
        if (goalError) console.error("auto-remember goal insert error:", goalError);
      }
    }
  } catch (error) {
    console.error("auto-remember error:", error);
  }
}

/**
 * Check if a similar idea already exists in memory (semantic deduplication).
 * Uses the search Edge Function with a high threshold (0.85) to find near-duplicates.
 * Returns the matching idea content if found, null otherwise.
 */
export async function findDuplicateIdea(
  supabase: SupabaseClient | null,
  content: string,
  threshold: number = 0.85
): Promise<string | null> {
  if (!supabase || !content) return null;

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query: content, table: "memory", match_count: 1, match_threshold: threshold },
    });

    if (error || !data?.length) return null;

    // Only consider ideas as duplicates
    const match = data.find((m: any) => m.type === "idea");
    return match ? match.content : null;
  } catch {
    // Search not available — skip deduplication, allow insert
    return null;
  }
}

// ── Contradiction Detection (S23-04) ─────────────────────────

/**
 * Check if a new fact contradicts existing facts using semantic search.
 * Looks for highly similar facts (>0.80) and flags potential contradictions.
 * Returns the conflicting memory content if found, null otherwise.
 */
export async function findContradiction(
  supabase: SupabaseClient | null,
  content: string,
  threshold: number = 0.80
): Promise<{ id: string; content: string; similarity: number } | null> {
  if (!supabase || !content) return null;

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query: content, table: "memory", match_count: 3, match_threshold: threshold },
    });

    if (error || !data?.length) return null;

    // Look for facts that are semantically very similar but might contradict
    // (same topic, different assertion)
    const match = data.find(
      (m: any) => m.type === "fact" && m.similarity >= threshold
    );
    return match ? { id: match.id, content: match.content, similarity: match.similarity } : null;
  } catch {
    return null;
  }
}

/**
 * Detect contradictions when inserting a new fact.
 * If a very similar fact exists, log a warning and add contradiction metadata.
 * Returns the contradiction info or null.
 */
export async function detectAndLogContradiction(
  supabase: SupabaseClient | null,
  newContent: string
): Promise<{ existingContent: string; similarity: number } | null> {
  if (!supabase) return null;

  const contradiction = await findContradiction(supabase, newContent);
  if (!contradiction) return null;

  console.log(
    `Potential contradiction detected: "${newContent}" vs existing "${contradiction.content}" (similarity: ${contradiction.similarity})`
  );

  return {
    existingContent: contradiction.content,
    similarity: contradiction.similarity,
  };
}

// ── Ideas CRUD (S21-05) ─────────────────────────────────────

export interface Idea {
  id: string;
  content: string;
  idea_status: "new" | "reviewed" | "promoted" | "archived";
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * List ideas filtered by status.
 * Defaults to showing new + reviewed ideas.
 */
export async function listIdeas(
  supabase: SupabaseClient | null,
  statusFilter: string[] = ["new", "reviewed"]
): Promise<Idea[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from("memory")
      .select("id, content, idea_status, metadata, created_at")
      .eq("type", "idea")
      .in("idea_status", statusFilter)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("list ideas error:", error);
      return [];
    }

    return (data || []) as Idea[];
  } catch (error) {
    console.error("list ideas error:", error);
    return [];
  }
}

/**
 * Get a single idea by ID.
 */
export async function getIdea(
  supabase: SupabaseClient | null,
  id: string
): Promise<Idea | null> {
  if (!supabase || !id) return null;

  try {
    const { data, error } = await supabase
      .from("memory")
      .select("id, content, idea_status, metadata, created_at")
      .eq("id", id)
      .eq("type", "idea")
      .single();

    if (error) return null;
    return data as Idea;
  } catch {
    return null;
  }
}

/**
 * Update idea status to "reviewed".
 */
export async function reviewIdea(
  supabase: SupabaseClient | null,
  id: string
): Promise<boolean> {
  if (!supabase || !id) return false;

  try {
    const { error } = await supabase
      .from("memory")
      .update({ idea_status: "reviewed" })
      .eq("id", id)
      .eq("type", "idea");

    if (error) {
      console.error("review idea error:", error);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Promote an idea: set status to "promoted".
 * Returns the idea content for task creation by the caller.
 */
export async function promoteIdea(
  supabase: SupabaseClient | null,
  id: string
): Promise<string | null> {
  if (!supabase || !id) return null;

  try {
    const { data, error } = await supabase
      .from("memory")
      .update({ idea_status: "promoted" })
      .eq("id", id)
      .eq("type", "idea")
      .select("content")
      .single();

    if (error) {
      console.error("promote idea error:", error);
      return null;
    }
    return data?.content || null;
  } catch {
    return null;
  }
}

/**
 * Archive an idea (soft-delete).
 */
export async function archiveIdea(
  supabase: SupabaseClient | null,
  id: string
): Promise<boolean> {
  if (!supabase || !id) return false;

  try {
    const { error } = await supabase
      .from("memory")
      .update({ idea_status: "archived" })
      .eq("id", id)
      .eq("type", "idea");

    if (error) {
      console.error("archive idea error:", error);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Format ideas list for Telegram (plain text, no markdown).
 */
export function formatIdeasList(ideas: Idea[]): string {
  if (!ideas.length) return "Aucune idee trouvee.";

  const lines: string[] = ["IDEES (" + ideas.length + ")"];
  for (const idea of ideas) {
    const status = idea.idea_status.toUpperCase();
    const date = new Date(idea.created_at).toLocaleDateString("fr-FR");
    const topics = Array.isArray(idea.metadata?.topics)
      ? " [" + (idea.metadata.topics as string[]).join(", ") + "]"
      : "";
    lines.push(`${status} | ${idea.id.slice(0, 8)} | ${idea.content}${topics} (${date})`);
  }
  return lines.join("\n");
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
