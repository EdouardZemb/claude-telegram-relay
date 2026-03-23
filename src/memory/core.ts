/**
 * @module memory.core
 * @description Core memory functions: processMemoryIntents, getMemoryContext,
 * getRecentMessages, getRelevantContext, archiveOldMemories.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "../logger.ts";
import { enqueue } from "../notification-queue.ts";
import { findDuplicateIdea } from "./classification.ts";
import { getLinkedMemoriesBatch, type LinkedMemory } from "./graph.ts";
import { bumpMemoryAccess, resolveMemoryConflict, updateMemoryWithRevision } from "./scoring.ts";

const log = createLogger("memory.core");

// ── Interfaces ────────────────────────────────────────────────

/** Full memory table row */
interface _MemoryRecord {
  id: string;
  created_at: string;
  updated_at: string;
  type: "fact" | "goal" | "completed_goal" | "preference" | "idea";
  content: string;
  deadline: string | null;
  completed_at: string | null;
  priority: number;
  importance_score: number;
  last_accessed_at: string | null;
  access_count: number;
  idea_status: "new" | "reviewed" | "promoted" | "archived" | null;
  metadata: Record<string, unknown>;
}

/** memory_links table row */
interface _MemoryLink {
  id: string;
  source_id: string;
  target_id: string;
  similarity: number;
  link_type: "related" | "extends" | "supports" | "contradicts";
  created_at: string;
}

/** Result count from archive_old_memories RPC (returns integer) */
type _MemoryArchiveResult = number;

/** A fact from get_facts RPC */
interface FactRecord {
  id: string;
  content: string;
  importance_score: number;
  access_count: number;
}

/** A goal from get_active_goals RPC */
interface GoalRecord {
  id: string;
  content: string;
  deadline: string | null;
  priority: number;
  importance_score: number;
}

/** An idea from memory (alias for the Idea interface with all fields) */
interface _IdeaRecord {
  id: string;
  content: string;
  type: string;
  idea_status: "new" | "reviewed" | "promoted" | "archived";
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Memory statistics summary */
interface _MemoryStats {
  totalFacts: number;
  totalGoals: number;
  totalIdeas: number;
  totalLinks: number;
  avgImportanceScore: number;
}

// ── Constants ─────────────────────────────────────────────────

/** Max facts injected into prompt context */
const MAX_FACTS_IN_CONTEXT = 20;

/** Max goals injected into prompt context */
const MAX_GOALS_IN_CONTEXT = 10;

// ── Functions ─────────────────────────────────────────────────

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 * S36-03/04/05: Applies conflict resolution for facts (dedup/update/merge).
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store] — with S36-03/04/05 conflict resolution
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const resolution = await resolveMemoryConflict(supabase, match[1]);
    if (resolution.action === "skip") {
      // Duplicate found, access already bumped
    } else if (resolution.action === "update") {
      await updateMemoryWithRevision(supabase, resolution.existingId, match[1], "update");
    } else if (resolution.action === "merge") {
      await updateMemoryWithRevision(supabase, resolution.existingId, match[1], "merge");
    } else {
      const { error } = await supabase.from("memory").insert({
        type: "fact",
        content: match[1],
      });
      if (error) log.error("memory insert (fact) error", { error: String(error) });
    }
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(/\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi)) {
    const { error } = await supabase.from("memory").insert({
      type: "goal",
      content: match[1],
      deadline: match[2] || null,
    });
    if (error) log.error("memory insert (goal) error", { error: String(error) });
    clean = clean.replace(match[0], "");
  }

  // [IDEA: idea to capture]
  for (const match of response.matchAll(/\[IDEA:\s*(.+?)\]/gi)) {
    // Semantic deduplication (S21-04)
    const duplicate = await findDuplicateIdea(supabase, match[1]);
    if (duplicate) {
      log.info(`Idea deduplicated (similar to: "${duplicate}")`);
      clean = clean.replace(match[0], "");
      continue;
    }
    const { error } = await supabase.from("memory").insert({
      type: "idea",
      content: match[1],
      idea_status: "new",
      metadata: { source: "intent-tag" },
    });
    if (error) log.error("memory insert (idea) error", { error: String(error) });
    else {
      const ideaPreview = match[1].length > 80 ? match[1].slice(0, 80) + "..." : match[1];
      const ts = new Date().toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: process.env.USER_TIMEZONE || "Europe/Paris",
      });
      await enqueue({
        type: "idea",
        severity: "normal",
        message: `[${ts}] Nouvelle idee (intent-tag): ${ideaPreview}`,
      });
    }
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
      if (error) log.error("memory update (complete goal) error", { error: String(error) });
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
export async function getMemoryContext(supabase: SupabaseClient | null): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const parts: string[] = [];
    const servedIds: string[] = [];

    const topFacts = ((factsResult.data || []) as FactRecord[]).slice(0, MAX_FACTS_IN_CONTEXT);
    const topGoals = ((goalsResult.data || []) as GoalRecord[]).slice(0, MAX_GOALS_IN_CONTEXT);

    // Batch fetch linked memories for all served facts/goals (S36-02)
    const allIds = [
      ...topFacts.map((f) => f.id).filter(Boolean),
      ...topGoals.map((g) => g.id).filter(Boolean),
    ];
    const linkedMap = await getLinkedMemoriesBatch(supabase, allIds);

    if (topFacts.length) {
      const factLines = topFacts.map((f) => {
        const links = linkedMap.get(f.id) || [];
        const linkLines = links.map(
          (l: LinkedMemory) => `  -> ${l.link_type}: ${l.linked_content}`,
        );
        return [`- ${f.content}`, ...linkLines].join("\n");
      });
      parts.push("FACTS:\n" + factLines.join("\n"));
      servedIds.push(...topFacts.map((f) => f.id).filter(Boolean));
    }

    if (topGoals.length) {
      const goalLines = topGoals.map((g) => {
        const deadline = g.deadline ? ` (by ${new Date(g.deadline).toLocaleDateString()})` : "";
        const links = linkedMap.get(g.id) || [];
        const linkLines = links.map(
          (l: LinkedMemory) => `  -> ${l.link_type}: ${l.linked_content}`,
        );
        return [`- ${g.content}${deadline}`, ...linkLines].join("\n");
      });
      parts.push("GOALS:\n" + goalLines.join("\n"));
      servedIds.push(...topGoals.map((g) => g.id).filter(Boolean));
    }

    // Bump access stats asynchronously (fire and forget)
    if (servedIds.length > 0) {
      bumpMemoryAccess(supabase, servedIds).catch(() => {});
    }

    return parts.join("\n\n");
  } catch (error) {
    log.error("Memory context error", { error: String(error) });
    return "";
  }
}

/**
 * Get the most recent messages for conversational continuity.
 */
export async function getRecentMessages(
  supabase: SupabaseClient | null,
  limit: number = 20,
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
      .map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`)
      .join("\n");

    return "RECENT CONVERSATION:\n" + messages;
  } catch (error) {
    log.error("Recent messages error", { error: String(error) });
    return "";
  }
}

/**
 * Semantic search for relevant past messages via the search Edge Function.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string,
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query, match_count: 5, table: "messages" },
    });

    if (error || !data?.length) return "";

    return (
      "RELEVANT PAST MESSAGES:\n" +
      data.map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`).join("\n")
    );
  } catch {
    // R7: optional feature -> skip
    return "";
  }
}

/**
 * Archive old memories (completed goals > 90 days, stale facts > 90 days).
 * Calls the archive_old_memories RPC.
 */
export async function archiveOldMemories(
  supabase: SupabaseClient | null,
  daysThreshold: number = 90,
): Promise<number> {
  if (!supabase) return 0;

  try {
    const { data, error } = await supabase.rpc("archive_old_memories", {
      days_threshold: daysThreshold,
    });

    if (error) {
      log.error("archive memories error", { error: String(error) });
      return 0;
    }

    return data || 0;
  } catch (error) {
    log.error("archive memories error", { error: String(error) });
    return 0;
  }
}
