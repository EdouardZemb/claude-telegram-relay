/**
 * @module memory.agent-memory
 * @description Role-specific agent memory: CRUD, conflict resolution, graduation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "../logger.ts";

const log = createLogger("memory.agent-memory");

// ── Constants ─────────────────────────────────────────────────

/**
 * Canonical tags per BMad agent role.
 * Statically determined — no LLM call required.
 * Covers all 8 roles defined in AgentRole type (R5, R15, V17).
 */
export const ROLE_CANONICAL_TAGS: Record<string, string[]> = {
  analyst: ["analyse-metier", "exigence", "besoin-utilisateur", "risque"],
  pm: ["planification", "estimation", "priorite", "dependance"],
  architect: ["pattern-architectural", "decision-technique", "contrainte", "dette-technique"],
  dev: ["implementation", "fix", "refactoring", "api"],
  qa: ["pattern-bug", "regression", "cas-limite", "test-manquant"],
  sm: ["processus", "blocage", "retrospective", "velocite"],
  planner: ["decomposition", "estimation", "priorisation", "scope"],
  explorer: ["recherche", "benchmark", "etat-art", "alternative"],
};

// ── Interfaces ────────────────────────────────────────────────

/** A row from the agent_memory table */
export interface AgentMemoryRecord {
  id: string;
  content: string;
  agent_role: string;
  tags: string[];
  importance_score: number;
  created_at: string;
  last_accessed_at: string | null;
  access_count: number;
  metadata: Record<string, unknown>;
}

// ── Functions ─────────────────────────────────────────────────

/**
 * Normalize content for exact-match deduplication.
 * Lowercase, trim, and collapse internal whitespace.
 * (R9, R10 — binary exact-match, no semantic thresholds)
 */
export function normalizeContent(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Resolve conflict for agent_memory table using exact-match binary comparison.
 * Queries agent_memory filtered by agent_role, compares normalized content.
 * Returns { action: "skip" } if identical content exists, { action: "insert" } otherwise.
 * Does NOT use the Edge Function search (no embeddings dependency). (R9, spec 6.3)
 */
export async function resolveAgentMemoryConflict(
  supabase: SupabaseClient | null,
  role: string,
  content: string,
): Promise<{ action: "skip" | "insert"; existingId?: string }> {
  if (!supabase) return { action: "insert" };

  try {
    const { data, error } = await supabase
      .from("agent_memory")
      .select("id, content")
      .eq("agent_role", role);

    if (error || !data) return { action: "insert" };

    const normalizedNew = normalizeContent(content);
    const duplicate = (data as Array<{ id: string; content: string }>).find(
      (row) => normalizeContent(row.content) === normalizedNew,
    );

    if (duplicate) {
      return { action: "skip", existingId: duplicate.id };
    }

    return { action: "insert" };
  } catch (error) {
    log.error("resolveAgentMemoryConflict error", { error: String(error) });
    return { action: "insert" };
  }
}

/**
 * Fetch role-specific memories from agent_memory, ordered by importance DESC.
 * Limited to at most p_limit entries (default 15, R7).
 * Returns empty array on error or null supabase.
 */
export async function getAgentMemories(
  supabase: SupabaseClient | null,
  role: string,
  limit: number = 15,
): Promise<AgentMemoryRecord[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase.rpc("get_agent_memories", {
      p_role: role,
      p_limit: limit,
    });

    if (error) {
      log.error("getAgentMemories error", { error: String(error), role });
      return [];
    }

    return (data || []) as AgentMemoryRecord[];
  } catch (error) {
    log.error("getAgentMemories error", { error: String(error), role });
    return [];
  }
}

/**
 * Save a role-specific memory to agent_memory.
 *
 * - Validates role against ROLE_CANONICAL_TAGS (R15, V19): logs warn + returns 0 if invalid
 * - Resolves conflict via exact-match binary comparison (R9, V2)
 * - Enforces hard limit of 15 per role (R7, V20): evicts least important before insert
 * - Returns number of inserted records (0 or 1)
 */
export async function saveAgentMemory(
  supabase: SupabaseClient | null,
  role: string,
  content: string,
  tags?: string[],
  metadata: Record<string, unknown> = {},
): Promise<number> {
  if (!supabase) return 0;

  // R15: Validate role against ROLE_CANONICAL_TAGS (V19)
  if (!Object.hasOwn(ROLE_CANONICAL_TAGS, role)) {
    log.warn("saveAgentMemory: invalid role, skipping", { role });
    return 0;
  }

  // Use canonical tags for the role if none provided
  const canonicalTags = tags ?? ROLE_CANONICAL_TAGS[role];

  // R9: Exact-match conflict resolution (V2)
  const resolution = await resolveAgentMemoryConflict(supabase, role, content);
  if (resolution.action === "skip") {
    log.info("saveAgentMemory: duplicate skipped", { role, existingId: resolution.existingId });
    return 0;
  }

  // V20: Hard limit eviction — check current count (R7)
  // Note: AGENT_MEMORY_HARD_LIMIT (15) is used inline here to avoid circular dependency
  const HARD_LIMIT = 15;
  try {
    const { data: existing, error: countError } = await supabase
      .from("agent_memory")
      .select("id, importance_score, created_at")
      .eq("agent_role", role)
      .order("importance_score", { ascending: true });

    if (!countError && existing && existing.length >= HARD_LIMIT) {
      // Evict the entry with the lowest importance score (first after ascending sort)
      const leastImportant = existing[0] as { id: string; importance_score: number };
      const { error: deleteError } = await supabase
        .from("agent_memory")
        .delete()
        .eq("id", leastImportant.id);

      if (!deleteError) {
        log.info("agent_memory eviction", {
          role,
          evictedId: leastImportant.id,
          evictedScore: leastImportant.importance_score,
        });
      } else {
        log.error("saveAgentMemory eviction error", { error: String(deleteError), role });
      }
    }
  } catch (evictError) {
    log.error("saveAgentMemory eviction check error", { error: String(evictError), role });
  }

  // Insert new agent memory
  const { error } = await supabase.from("agent_memory").insert({
    agent_role: role,
    content,
    tags: canonicalTags,
    importance_score: 75,
    metadata: {
      ...metadata,
      source: "working_memory_promotion",
      promotion_type: metadata.promotion_type ?? "decision",
      pipeline_session_id: metadata.pipeline_session_id ?? null,
      graduated: false,
    },
  });

  if (error) {
    log.error("saveAgentMemory insert error", { error: String(error), role });
    return 0;
  }

  return 1;
}

/**
 * Graduate an agent memory pattern to global memory when confirmed by >= 2 distinct roles.
 *
 * Uses exact-match on normalized content to find confirming entries across roles.
 * SELECT-before-INSERT idempotence: checks metadata.graduated on source entries.
 * Non-blocking: called fire-and-forget (pattern: bumpMemoryAccess). (R10, R11, V10, V11)
 */
export async function graduateAgentMemory(
  supabase: SupabaseClient | null,
  content: string,
): Promise<void> {
  if (!supabase || !content) return;

  try {
    const normalizedContent = normalizeContent(content);
    if (!normalizedContent) return;

    // SELECT all agent_memory entries with same normalized content
    const { data: candidates, error: selectError } = await supabase
      .from("agent_memory")
      .select("id, agent_role, content, metadata");

    if (selectError || !candidates) return;

    // Filter by exact-match on normalized content
    const matching = (
      candidates as Array<{
        id: string;
        agent_role: string;
        content: string;
        metadata: Record<string, unknown>;
      }>
    ).filter((row) => normalizeContent(row.content) === normalizedContent);

    // Idempotence: skip if any source already graduated
    const alreadyGraduated = matching.some((row) => row.metadata?.graduated === true);
    if (alreadyGraduated) return;

    // Find distinct roles confirming the same content
    const roles = [...new Set(matching.map((row) => row.agent_role))];
    if (roles.length < 2) return;

    // INSERT into global memory with graduation metadata
    const { error: insertError } = await supabase.from("memory").insert({
      type: "fact",
      content: matching[0].content, // Use original casing of first entry
      metadata: {
        source: "agent_memory_graduation",
        confirming_roles: roles,
        graduated_from_ids: matching.map((m) => m.id),
        graduation_date: new Date().toISOString(),
      },
    });

    if (insertError) {
      log.warn("graduateAgentMemory insert failed", { error: String(insertError) });
      return;
    }

    // UPDATE graduated=true on source entries (R11, V10, V11)
    const sourceIds = matching.map((m) => m.id);
    for (const sourceId of sourceIds) {
      // Find existing metadata for this entry
      const entry = matching.find((m) => m.id === sourceId);
      const existingMeta = entry?.metadata ?? {};
      await supabase
        .from("agent_memory")
        .update({
          metadata: {
            ...existingMeta,
            graduated: true,
            graduation_date: new Date().toISOString(),
          },
        })
        .eq("id", sourceId);
    }

    log.info("agent_memory graduated to global memory", {
      content: normalizedContent.slice(0, 80),
      confirming_roles: roles,
      sourceCount: matching.length,
    });
  } catch (error) {
    log.warn("graduateAgentMemory failed (non-blocking)", { error: String(error) });
  }
}
