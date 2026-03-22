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
import { enqueue } from "./notification-queue.ts";

// ── Interfaces ───────────────────────────────────────────────

/** Full memory table row */
interface MemoryRecord {
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
interface MemoryLink {
  id: string;
  source_id: string;
  target_id: string;
  similarity: number;
  link_type: "related" | "extends" | "supports" | "contradicts";
  created_at: string;
}

/** Result from match_memory RPC / search Edge Function */
interface MemorySearchResult {
  id: string;
  content: string;
  type: string;
  created_at: string;
  similarity: number;
}

/** Result count from archive_old_memories RPC (returns integer) */
type MemoryArchiveResult = number;

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
interface IdeaRecord {
  id: string;
  content: string;
  type: string;
  idea_status: "new" | "reviewed" | "promoted" | "archived";
  metadata: Record<string, unknown>;
  created_at: string;
}

/** A cluster of semantically related memories */
export interface MemoryCluster {
  id: number;
  label: string;
  memories: Array<{ id: string; content: string; type: string }>;
  size: number;
}

/** A node in a multi-hop memory chain (from getMemoryChain) */
export interface MemoryChain {
  id: string;
  content: string;
  type: string;
  depth: number;
  links: Array<{
    targetId: string;
    similarity: number;
    linkType: string;
  }>;
}

/** Memory statistics summary */
interface MemoryStats {
  totalFacts: number;
  totalGoals: number;
  totalIdeas: number;
  totalLinks: number;
  avgImportanceScore: number;
}

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
  actionability_score?: number; // S36-06: 0-10 scale
  summary: string;
}

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 * S36-03/04/05: Applies conflict resolution for facts (dedup/update/merge).
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store] — with S36-03/04/05 conflict resolution
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const resolution = await resolveMemoryConflict(supabase, match[1]!);
    if (resolution.action === "skip") {
      // Duplicate found, access already bumped
    } else if (resolution.action === "update") {
      await updateMemoryWithRevision(supabase, resolution.existingId, match[1]!, "update");
    } else if (resolution.action === "merge") {
      await updateMemoryWithRevision(supabase, resolution.existingId, match[1]!, "merge");
    } else {
      const { error } = await supabase.from("memory").insert({
        type: "fact",
        content: match[1],
      });
      if (error) console.error("memory insert (fact) error:", error);
    }
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
    const duplicate = await findDuplicateIdea(supabase, match[1]!);
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
    else {
      const ideaPreview = match[1]!.length > 80 ? match[1]!.slice(0, 80) + "..." : match[1]!;
      const ts = new Date().toLocaleTimeString("fr-FR", {
        hour: "2-digit", minute: "2-digit",
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
          (l: LinkedMemory) => `  -> ${l.link_type}: ${l.linked_content}`
        );
        return [`- ${f.content}`, ...linkLines].join("\n");
      });
      parts.push("FACTS:\n" + factLines.join("\n"));
      servedIds.push(...topFacts.map((f) => f.id).filter(Boolean));
    }

    if (topGoals.length) {
      const goalLines = topGoals.map((g) => {
        const deadline = g.deadline
          ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
          : "";
        const links = linkedMap.get(g.id) || [];
        const linkLines = links.map(
          (l: LinkedMemory) => `  -> ${l.link_type}: ${l.linked_content}`
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
      .map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`)
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
        .map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`)
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
 * S36-03/04/05: Applies conflict resolution for facts.
 * S36-06: Applies actionability filter (bypass for ideas).
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

    // S36-06: Actionability filter (bypass for ideas)
    if (memoryType !== "idea") {
      const actionability = classification.actionability_score ?? 7; // EC-003: default 7
      if (actionability < ACTIONABILITY_THRESHOLD) {
        console.log(`Memory filtered by actionability (score: ${actionability}): "${memoryContent}"`);
        return;
      }
    }

    // Semantic deduplication for ideas (S21-04)
    if (memoryType === "idea") {
      const duplicate = await findDuplicateIdea(supabase, memoryContent);
      if (duplicate) {
        console.log(`Idea deduplicated (similar to: "${duplicate}")`);
        return;
      }
    }

    // S36-03/04/05: Conflict resolution for facts
    if (memoryType === "fact") {
      const resolution = await resolveMemoryConflict(supabase, memoryContent);
      if (resolution.action === "skip") {
        await autoCreateGoals(supabase, classification);
        return;
      }
      if (resolution.action === "update" || resolution.action === "merge") {
        await updateMemoryWithRevision(supabase, resolution.existingId, memoryContent, resolution.action);
        await autoCreateGoals(supabase, classification);
        return;
      }
      // action === "insert": fall through to normal insertion
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
    else if (memoryType === "idea") {
      const autoPreview = memoryContent.length > 80 ? memoryContent.slice(0, 80) + "..." : memoryContent;
      const ts = new Date().toLocaleTimeString("fr-FR", {
        hour: "2-digit", minute: "2-digit",
        timeZone: process.env.USER_TIMEZONE || "Europe/Paris",
      });
      await enqueue({
        type: "idea",
        severity: "normal",
        message: `[${ts}] Nouvelle idee (auto-detect): ${autoPreview}`,
      });
    }

    // Auto-create goals from action_items
    await autoCreateGoals(supabase, classification);
  } catch (error) {
    console.error("auto-remember error:", error);
  }
}

/**
 * Auto-create goals from classification action_items.
 * Extracted for reuse in conflict resolution paths (S36-03/04/05).
 */
async function autoCreateGoals(
  supabase: SupabaseClient,
  classification: ThoughtClassification
): Promise<void> {
  if (!classification.action_items?.length) return;

  for (const item of classification.action_items) {
    const { error: goalError } = await supabase.from("memory").insert({
      type: "goal",
      content: item,
      metadata: { auto_classified: true, source: "action-item", topics: classification.topics },
    });
    if (goalError) console.error("auto-remember goal insert error:", goalError);
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
    const match = (data as MemorySearchResult[]).find((m) => m.type === "idea");
    return match ? match.content : null;
  } catch {
    // Search not available — skip deduplication, allow insert
    return null;
  }
}

// ── Memory Linking (S36-01) ───────────────────────────────────

/**
 * Create semantic links between a memory and its nearest neighbors.
 * Wraps the link_memory RPC. The DB trigger handles auto-linking on
 * embedding creation; this function is for manual/on-demand use.
 *
 * @returns Number of links created (forward + reverse)
 */
export async function linkMemories(
  supabase: SupabaseClient | null,
  memoryId: string,
  threshold?: number,
  maxLinks?: number
): Promise<number> {
  if (!supabase || !memoryId) return 0;

  try {
    const params: Record<string, string | number> = { p_memory_id: memoryId };
    if (threshold !== undefined) params.p_threshold = threshold;
    if (maxLinks !== undefined) params.p_max_links = maxLinks;

    const { data, error } = await supabase.rpc("link_memory", params);

    if (error) {
      console.error("link_memory error:", error);
      return 0;
    }

    return data || 0;
  } catch (error) {
    console.error("link_memory error:", error);
    return 0;
  }
}

// ── Memory Link Retrieval (S36-02) ────────────────────────────

/** A linked memory returned by get_linked_memories RPC */
export interface LinkedMemory {
  origin_id: string;
  linked_id: string;
  linked_content: string;
  linked_type: string;
  similarity: number;
  link_type: string;
}

/** Max linked memories shown per memory in context */
const MAX_LINKS_PER_MEMORY_IN_CONTEXT = 3;

/**
 * Get all memories linked to a given memory ID.
 * Returns links sorted by similarity (descending), 1 level of depth only.
 */
export async function getLinkedMemories(
  supabase: SupabaseClient | null,
  memoryId: string
): Promise<LinkedMemory[]> {
  if (!supabase || !memoryId) return [];

  try {
    const { data, error } = await supabase.rpc("get_linked_memories", {
      p_memory_ids: [memoryId],
    });

    if (error) {
      console.error("get_linked_memories error:", error);
      return [];
    }

    return (data || []) as LinkedMemory[];
  } catch (error) {
    console.error("get_linked_memories error:", error);
    return [];
  }
}

/**
 * Batch fetch linked memories for multiple memory IDs.
 * Returns a Map of origin_id → linked memories (max 3 per origin).
 * Used by getMemoryContext() to enrich facts/goals with their links.
 */
export async function getLinkedMemoriesBatch(
  supabase: SupabaseClient | null,
  memoryIds: string[]
): Promise<Map<string, LinkedMemory[]>> {
  if (!supabase || memoryIds.length === 0) return new Map();

  try {
    const { data, error } = await supabase.rpc("get_linked_memories", {
      p_memory_ids: memoryIds,
    });

    if (error) {
      console.error("get_linked_memories batch error:", error);
      return new Map();
    }

    // Group by origin_id, limit MAX_LINKS_PER_MEMORY_IN_CONTEXT per origin
    const grouped = new Map<string, LinkedMemory[]>();
    for (const link of (data || []) as LinkedMemory[]) {
      const existing = grouped.get(link.origin_id) || [];
      if (existing.length < MAX_LINKS_PER_MEMORY_IN_CONTEXT) {
        existing.push(link);
        grouped.set(link.origin_id, existing);
      }
    }

    return grouped;
  } catch (error) {
    console.error("get_linked_memories batch error:", error);
    return new Map();
  }
}

// ── Memory Evolution (S36-03/04/05) ──────────────────────────

/** Threshold for duplicate detection (skip insertion) */
const DUPLICATE_THRESHOLD = 0.85;
/** Threshold for contradiction detection (update existing) */
const CONTRADICTION_THRESHOLD = 0.80;
/** Threshold for complement detection (merge into existing) */
const COMPLEMENT_THRESHOLD = 0.75;
/** Actionability threshold for auto-remember filtering (S36-06) */
const ACTIONABILITY_THRESHOLD = 5;

/** A semantically similar existing memory */
interface SimilarMemory {
  id: string;
  content: string;
  type: string;
  similarity: number;
}

/**
 * Find the most similar existing fact to a given content.
 * Uses the search Edge Function for semantic similarity.
 */
export async function findSimilarFact(
  supabase: SupabaseClient | null,
  content: string,
  threshold: number = COMPLEMENT_THRESHOLD
): Promise<SimilarMemory | null> {
  if (!supabase || !content) return null;

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query: content, table: "memory", match_count: 1, match_threshold: threshold },
    });

    if (error || !data?.length) return null;

    const match = (data as MemorySearchResult[]).find((m) => m.type === "fact");
    if (!match) return null;

    return {
      id: match.id,
      content: match.content,
      type: match.type,
      similarity: match.similarity,
    };
  } catch {
    return null;
  }
}

export type ConflictResolution =
  | { action: "skip"; existingId: string }
  | { action: "update"; existingId: string }
  | { action: "merge"; existingId: string }
  | { action: "insert" };

/**
 * Determine how to handle a new fact based on similarity to existing facts.
 * - >= 0.85: duplicate → skip, bump access
 * - >= 0.80: contradiction → update existing
 * - >= 0.75: complement → merge into existing
 * - < 0.75: new → insert normally
 */
export async function resolveMemoryConflict(
  supabase: SupabaseClient | null,
  content: string
): Promise<ConflictResolution> {
  if (!supabase) return { action: "insert" };

  const similar = await findSimilarFact(supabase, content, COMPLEMENT_THRESHOLD);
  if (!similar) return { action: "insert" };

  if (similar.similarity >= DUPLICATE_THRESHOLD) {
    await bumpMemoryAccess(supabase, [similar.id]);
    console.log(`Memory deduplicated (sim: ${similar.similarity.toFixed(2)}): "${content}"`);
    return { action: "skip", existingId: similar.id };
  }

  if (similar.similarity >= CONTRADICTION_THRESHOLD) {
    console.log(`Memory contradiction detected (sim: ${similar.similarity.toFixed(2)}): "${content}" vs "${similar.content}"`);
    return { action: "update", existingId: similar.id };
  }

  console.log(`Memory complement detected (sim: ${similar.similarity.toFixed(2)}): "${content}" → enriching "${similar.content}"`);
  return { action: "merge", existingId: similar.id };
}

/**
 * Update an existing memory with revision tracking.
 * - "update" mode: replace content (contradiction)
 * - "merge" mode: append new content (complement)
 * Stores previous version in metadata.previous_versions[].
 * Clears embedding to trigger regeneration via webhook.
 */
export async function updateMemoryWithRevision(
  supabase: SupabaseClient | null,
  existingId: string,
  newContent: string,
  mode: "update" | "merge"
): Promise<boolean> {
  if (!supabase || !existingId) return false;

  try {
    const { data: existing, error: fetchError } = await supabase
      .from("memory")
      .select("content, metadata")
      .eq("id", existingId)
      .single();

    if (fetchError || !existing) return false;

    const metadata = (existing.metadata || {}) as Record<string, unknown>;
    const previousVersions = Array.isArray(metadata.previous_versions)
      ? [...metadata.previous_versions]
      : [];
    previousVersions.push(existing.content);

    const finalContent = mode === "update"
      ? newContent
      : `${existing.content}. ${newContent}`;

    const { error } = await supabase
      .from("memory")
      .update({
        content: finalContent,
        metadata: {
          ...metadata,
          previous_versions: previousVersions,
          revision_count: (Number(metadata.revision_count) || 0) + 1,
          last_revised_at: new Date().toISOString(),
        },
        embedding: null, // Clear to trigger regeneration via webhook
      })
      .eq("id", existingId);

    if (error) {
      console.error("updateMemoryWithRevision error:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("updateMemoryWithRevision error:", error);
    return false;
  }
}

// ── Working Memory Promotion (S36-08) ────────────────────────

/** Working memory data structure from blackboard */
export interface WorkingMemoryData {
  decisions?: Array<{ agent: string; decision: string; reasoning: string }>;
  discoveries?: Array<{ agent: string; fact: string; source: string }>;
  blockers?: Array<{ agent: string; issue: string; status: string }>;
  context_updates?: Array<{ agent: string; key: string; value: string }>;
}

/**
 * Promote significant working memory items to permanent memories.
 * Extracts decisions and discoveries, persists them with conflict resolution.
 * Called at pipeline end by the orchestrator.
 */
export async function promoteWorkingMemory(
  supabase: SupabaseClient | null,
  workingMemory: WorkingMemoryData | null,
  sessionId: string
): Promise<number> {
  if (!supabase || !workingMemory) return 0;

  try {
    let promoted = 0;
    const items: Array<{ content: string; agent: string }> = [];

    // Collect decisions (always promote)
    if (Array.isArray(workingMemory.decisions)) {
      for (const d of workingMemory.decisions) {
        items.push({ content: `${d.decision} (raison: ${d.reasoning})`, agent: d.agent });
      }
    }

    // Collect discoveries
    if (Array.isArray(workingMemory.discoveries)) {
      for (const d of workingMemory.discoveries) {
        items.push({ content: d.fact, agent: d.agent });
      }
    }

    // Persist each item with conflict resolution
    for (const item of items) {
      const resolution = await resolveMemoryConflict(supabase, item.content);
      if (resolution.action === "skip") continue;

      if (resolution.action === "update" || resolution.action === "merge") {
        const ok = await updateMemoryWithRevision(
          supabase, resolution.existingId, item.content, resolution.action
        );
        if (ok) promoted++;
        continue;
      }

      // Insert new fact
      const { error } = await supabase.from("memory").insert({
        type: "fact",
        content: item.content,
        metadata: {
          source: "working_memory_promotion",
          pipeline_session_id: sessionId,
          agent: item.agent,
        },
      });
      if (!error) promoted++;
    }

    return promoted;
  } catch (error) {
    console.error("promoteWorkingMemory error:", error);
    return 0;
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
    const match = (data as MemorySearchResult[]).find(
      (m) => m.type === "fact" && m.similarity >= threshold
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

// ── Link Classification (S41-02) ────────────────────────────

/**
 * Classify the relationship between two memory contents using heuristics.
 * - "contradicts": one negates/replaces the other (high entity overlap + negation)
 * - "extends": one elaborates on the other (high overlap, different length)
 * - "supports": similar conclusions (high overlap, similar length)
 * - "related": default fallback
 */
export function classifyLinkContent(sourceContent: string, targetContent: string): string {
  const srcLower = sourceContent.toLowerCase();
  const tgtLower = targetContent.toLowerCase();

  const negationPatterns = [
    /\bne\s+\w+\s+pas\b/,
    /\bn[']\w+\s+pas\b/,
    /\bpas\b/,
    /\bnon\b/,
    /\bplus\s+de\b/,
    /\bau lieu de\b/,
    /\bcontrairement\b/,
    /\binstead\b/,
    /\bnot\b/,
    /\bno longer\b/,
    /\bremplac/,
    /\breplac/,
    /\bannul/,
    /\bcancel/,
    /\brevert/,
  ];

  // Extract meaningful words (3+ chars, exclude common stop words)
  const stopWords = new Set(["est", "les", "des", "une", "par", "sur", "dans", "pour", "avec", "que", "qui", "the", "and", "for", "are", "was", "has", "its", "this", "that", "with", "from"]);
  const srcWords = new Set(srcLower.split(/\W+/).filter((w) => w.length >= 3 && !stopWords.has(w)));
  const tgtWords = new Set(tgtLower.split(/\W+/).filter((w) => w.length >= 3 && !stopWords.has(w)));
  const overlap = [...srcWords].filter((w) => tgtWords.has(w));
  // Use min(sizes) so asymmetric comparisons work (short text fully covered = high ratio)
  const minSize = Math.min(srcWords.size, tgtWords.size, Infinity);
  const overlapRatio = minSize > 0 && overlap.length >= 2 ? overlap.length / minSize : 0;

  // Contradicts: high entity overlap but one has negation
  if (overlapRatio > 0.3) {
    const srcHasNeg = negationPatterns.some((p) => p.test(srcLower));
    const tgtHasNeg = negationPatterns.some((p) => p.test(tgtLower));
    if (srcHasNeg !== tgtHasNeg) {
      return "contradicts";
    }
  }

  // Extends: high overlap, one is significantly longer
  if (overlapRatio > 0.4) {
    const lenRatio =
      Math.max(sourceContent.length, targetContent.length) /
      Math.max(Math.min(sourceContent.length, targetContent.length), 1);
    if (lenRatio > 1.5) {
      return "extends";
    }
  }

  // Supports: moderate overlap, similar length
  if (overlapRatio > 0.3) {
    return "supports";
  }

  return "related";
}

// ── Memory Chains (S41-01) ──────────────────────────────────

/** A node in a multi-hop memory chain (alias for MemoryChain) */
type MemoryChainNode = MemoryChain;

/** Max nodes in a chain traversal */
const MAX_CHAIN_NODES = 50;

/**
 * Multi-hop BFS traversal of memory links.
 * Starting from a memory ID, follows links up to `maxDepth` levels.
 * Returns all visited nodes with their links and depth info.
 */
export async function getMemoryChain(
  supabase: SupabaseClient | null,
  memoryId: string,
  maxDepth: number = 3
): Promise<MemoryChainNode[]> {
  if (!supabase || !memoryId) return [];

  try {
    // Fetch the root node
    const { data: rootData } = await supabase
      .from("memory")
      .select("id, content, type")
      .eq("id", memoryId)
      .single();

    if (!rootData) return [];

    const visited = new Map<string, MemoryChainNode>();
    visited.set(memoryId, {
      id: rootData.id,
      content: rootData.content,
      type: rootData.type,
      depth: 0,
      links: [],
    });

    let frontier = [memoryId];
    let depth = 0;

    while (depth < maxDepth && frontier.length > 0 && visited.size < MAX_CHAIN_NODES) {
      const { data: links, error } = await supabase.rpc("get_linked_memories", {
        p_memory_ids: frontier,
      });

      if (error || !links?.length) break;

      const nextFrontier: string[] = [];

      for (const link of links as LinkedMemory[]) {
        // Enrich link type using content heuristic
        const origin = visited.get(link.origin_id);
        const enrichedType = origin
          ? classifyLinkContent(origin.content, link.linked_content)
          : link.link_type;

        // Add link to origin node
        if (origin) {
          origin.links.push({
            targetId: link.linked_id,
            similarity: link.similarity,
            linkType: enrichedType,
          });
        }

        // Add linked node if not visited
        if (!visited.has(link.linked_id) && visited.size < MAX_CHAIN_NODES) {
          visited.set(link.linked_id, {
            id: link.linked_id,
            content: link.linked_content,
            type: link.linked_type,
            depth: depth + 1,
            links: [],
          });
          nextFrontier.push(link.linked_id);
        }
      }

      frontier = nextFrontier;
      depth++;
    }

    return Array.from(visited.values());
  } catch (error) {
    console.error("getMemoryChain error:", error);
    return [];
  }
}

// ── Memory Clustering (S41-03) ──────────────────────────────

/**
 * Find connected components in the memory link graph.
 * Fetches top facts and their links, groups into clusters.
 * Only returns clusters with 2+ members. Max 10 clusters.
 */
export async function clusterMemories(
  supabase: SupabaseClient | null,
  maxFacts: number = 50,
  maxClusters: number = 10
): Promise<MemoryCluster[]> {
  if (!supabase) return [];

  try {
    const { data: facts } = await supabase.rpc("get_facts");
    if (!facts?.length) return [];

    const topFacts = (facts as FactRecord[]).slice(0, maxFacts);
    const factIds = topFacts.map((f) => f.id).filter(Boolean);

    // Fetch all links (use RPC directly to avoid 3-link cap)
    const { data: allLinks } = await supabase.rpc("get_linked_memories", {
      p_memory_ids: factIds,
    });

    // Build adjacency list and node map
    const adj = new Map<string, Set<string>>();
    const nodeMap = new Map<string, { id: string; content: string; type: string }>();

    for (const fact of topFacts) {
      nodeMap.set(fact.id, { id: fact.id, content: fact.content, type: "fact" });
      if (!adj.has(fact.id)) adj.set(fact.id, new Set());
    }

    for (const link of (allLinks || []) as LinkedMemory[]) {
      if (!adj.has(link.origin_id)) adj.set(link.origin_id, new Set());
      adj.get(link.origin_id)!.add(link.linked_id);

      if (!adj.has(link.linked_id)) adj.set(link.linked_id, new Set());
      adj.get(link.linked_id)!.add(link.origin_id);

      if (!nodeMap.has(link.linked_id)) {
        nodeMap.set(link.linked_id, {
          id: link.linked_id,
          content: link.linked_content,
          type: link.linked_type,
        });
      }
    }

    // Find connected components via BFS
    const visited = new Set<string>();
    const clusters: MemoryCluster[] = [];
    let clusterId = 0;

    for (const nodeId of nodeMap.keys()) {
      if (visited.has(nodeId)) continue;

      const component: string[] = [];
      const queue = [nodeId];
      visited.add(nodeId);

      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);

        for (const neighbor of adj.get(current) || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      // Only include clusters with 2+ members
      if (component.length >= 2) {
        const memories = component
          .map((id) => nodeMap.get(id))
          .filter(Boolean) as Array<{ id: string; content: string; type: string }>;

        clusters.push({
          id: clusterId++,
          label: memories[0]!.content.slice(0, 80),
          memories,
          size: memories.length,
        });
      }
    }

    return clusters.sort((a, b) => b.size - a.size).slice(0, maxClusters);
  } catch (error) {
    console.error("clusterMemories error:", error);
    return [];
  }
}

/**
 * Format memory clusters for display (plain text, no markdown).
 */
export function formatClusters(clusters: MemoryCluster[]): string {
  if (clusters.length === 0) return "Aucun cluster detecte.";

  const lines: string[] = [`CLUSTERS DE MEMOIRE (${clusters.length})`];

  for (const cluster of clusters) {
    lines.push("");
    lines.push(`Cluster ${cluster.id + 1} (${cluster.size} memoires):`);
    for (const mem of cluster.memories.slice(0, 5)) {
      lines.push(`  - [${mem.type}] ${mem.content}`);
    }
    if (cluster.memories.length > 5) {
      lines.push(`  ... et ${cluster.memories.length - 5} autres`);
    }
  }

  return lines.join("\n");
}

// ── Memory Chains for Agents (S41-04) ───────────────────────

/**
 * Build structured memory chains for agent context.
 * Strategic roles (analyst, pm, architect, qa) get chains with linked context.
 * Tactical roles (dev, sm) get flat facts for efficiency.
 */
export async function buildMemoryChains(
  supabase: SupabaseClient | null,
  role: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const facts = ((factsResult.data || []) as FactRecord[]).slice(0, MAX_FACTS_IN_CONTEXT);
    const goals = ((goalsResult.data || []) as GoalRecord[]).slice(0, MAX_GOALS_IN_CONTEXT);

    if (facts.length === 0 && goals.length === 0) return "";

    // Fetch links for all memories
    const allIds = [
      ...facts.map((f) => f.id),
      ...goals.map((g) => g.id),
    ].filter(Boolean);

    const linkedMap = await getLinkedMemoriesBatch(supabase, allIds);
    const parts: string[] = [];
    const servedIds: string[] = [];

    if (role === "dev" || role === "sm") {
      // Tactical roles: flat facts
      if (facts.length) {
        parts.push(
          "Faits cles:\n" +
            facts
              .slice(0, 10)
              .map((f) => `- ${f.content}`)
              .join("\n")
        );
        servedIds.push(...facts.slice(0, 10).map((f) => f.id));
      }
      if (goals.length) {
        parts.push(
          "Objectifs:\n" +
            goals
              .slice(0, 5)
              .map((g) => `- ${g.content}`)
              .join("\n")
        );
        servedIds.push(...goals.slice(0, 5).map((g) => g.id));
      }
    } else {
      // Strategic roles: structured chains
      const usedInChain = new Set<string>();
      const chains: string[] = [];

      for (const fact of facts) {
        if (usedInChain.has(fact.id)) continue;
        servedIds.push(fact.id);
        usedInChain.add(fact.id);

        const links = linkedMap.get(fact.id) || [];
        if (links.length > 0) {
          const chainLines = [`- ${fact.content}`];
          for (const link of links) {
            const enrichedType = classifyLinkContent(fact.content, link.linked_content);
            chainLines.push(`  [${enrichedType}] ${link.linked_content}`);
            usedInChain.add(link.linked_id);
          }
          chains.push(chainLines.join("\n"));
        } else {
          chains.push(`- ${fact.content}`);
        }
      }

      if (chains.length) {
        parts.push("Faits et chaines:\n" + chains.join("\n"));
      }

      // Goals with linked context
      if (goals.length) {
        const goalLines = goals.map((g) => {
          const deadline = g.deadline
            ? ` (echeance: ${new Date(g.deadline).toLocaleDateString("fr-FR")})`
            : "";
          const links = linkedMap.get(g.id) || [];
          servedIds.push(g.id);
          if (links.length > 0) {
            const linkLines = links.map(
              (l: LinkedMemory) =>
                `  [${classifyLinkContent(g.content, l.linked_content)}] ${l.linked_content}`
            );
            return [`- ${g.content}${deadline}`, ...linkLines].join("\n");
          }
          return `- ${g.content}${deadline}`;
        });
        parts.push("Objectifs et contexte:\n" + goalLines.join("\n"));
      }
    }

    // Bump access (fire and forget)
    if (servedIds.length > 0) {
      bumpMemoryAccess(supabase, servedIds).catch(() => {});
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("buildMemoryChains error:", error);
    return "";
  }
}

// ── Similar Past Tasks (S41-05) ─────────────────────────────

/** A completed task similar to the current one */
export interface SimilarTask {
  id: string;
  title: string;
  estimatedHours: number | null;
  actualHours: number | null;
  sprint: string | null;
  tags: string[];
}

/**
 * Find completed tasks similar to a given title using keyword matching.
 * Returns historical data: estimated vs actual hours, sprint, tags.
 * Used by agents to calibrate effort estimation.
 */
export async function findSimilarPastTasks(
  supabase: SupabaseClient | null,
  taskTitle: string,
  limit: number = 5
): Promise<SimilarTask[]> {
  if (!supabase || !taskTitle) return [];

  try {
    // Extract keywords (words with 4+ chars)
    const keywords = taskTitle
      .toLowerCase()
      .split(/[\s\-_:]+/)
      .filter((w) => w.length >= 4)
      .slice(0, 3);

    if (keywords.length === 0) return [];

    // Search done tasks with matching keywords
    const filters = keywords.map((k) => `title.ilike.%${k}%`);

    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, estimated_hours, actual_hours, sprint, tags")
      .eq("status", "done")
      .or(filters.join(","))
      .order("completed_at", { ascending: false })
      .limit(limit);

    if (error || !data?.length) return [];

    return data.map((t: { id: string; title: string; estimated_hours: number | null; actual_hours: number | null; sprint: string | null; tags: string[] | null }) => ({
      id: t.id,
      title: t.title,
      estimatedHours: t.estimated_hours,
      actualHours: t.actual_hours,
      sprint: t.sprint,
      tags: t.tags || [],
    }));
  } catch (error) {
    console.error("findSimilarPastTasks error:", error);
    return [];
  }
}
