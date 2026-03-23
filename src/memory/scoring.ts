/**
 * @module memory.scoring
 * @description Importance scoring with temporal decay, conflict resolution,
 * contradiction detection, memory access tracking.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "../logger.ts";

const log = createLogger("memory.scoring");

// ── Constants ─────────────────────────────────────────────────

/** Half-life in days for exponential decay */
const DECAY_HALF_LIFE_DAYS = 70;

/** Threshold for duplicate detection (skip insertion) */
const DUPLICATE_THRESHOLD = 0.85;
/** Threshold for contradiction detection (update existing) */
const CONTRADICTION_THRESHOLD = 0.8;
/** Threshold for complement detection (merge into existing) */
const COMPLEMENT_THRESHOLD = 0.75;
/** Actionability threshold for auto-remember filtering (S36-06) */
export const ACTIONABILITY_THRESHOLD = 5;
/** Max content length for promoted working memory items (R11) */
export const PROMOTION_MAX_CHARS = 500;

// ── Interfaces ────────────────────────────────────────────────

/** Result from match_memory RPC / search Edge Function */
export interface MemorySearchResult {
  id: string;
  content: string;
  type: string;
  created_at: string;
  similarity: number;
}

/** A semantically similar existing memory */
interface SimilarMemory {
  id: string;
  content: string;
  type: string;
  similarity: number;
}

export type ConflictResolution =
  | { action: "skip"; existingId: string }
  | { action: "update"; existingId: string }
  | { action: "merge"; existingId: string }
  | { action: "insert" };

// ── Functions ─────────────────────────────────────────────────

/**
 * Calculate the effective importance of a memory, applying temporal decay.
 *
 * Formula: effective = base_score * 2^(-age_days / half_life)
 * A memory with score 50 at 70 days old -> effective 25.
 * Access boosts: each access adds +2 to effective (capped at base_score).
 */
export function calculateEffectiveImportance(
  baseScore: number,
  createdAt: string | Date,
  lastAccessedAt: string | Date | null,
  accessCount: number = 0,
  referenceDate: Date = new Date(),
): number {
  const created = new Date(createdAt);
  const ageDays = (referenceDate.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);

  // Exponential decay
  const decayFactor = 2 ** (-ageDays / DECAY_HALF_LIFE_DAYS);
  let effective = baseScore * decayFactor;

  // Access boost: +2 per access, capped at base score
  const accessBoost = Math.min(accessCount * 2, baseScore * 0.5);
  effective += accessBoost;

  // Recency boost: if accessed in last 7 days, small bonus
  if (lastAccessedAt) {
    const lastAccess = new Date(lastAccessedAt);
    const daysSinceAccess =
      (referenceDate.getTime() - lastAccess.getTime()) / (1000 * 60 * 60 * 24);
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
  memoryIds: string[],
): Promise<void> {
  if (!supabase || memoryIds.length === 0) return;

  try {
    const { error } = await supabase.rpc("bump_memory_access", {
      memory_ids: memoryIds,
    });
    if (error) log.error("bump_memory_access error", { error: String(error) });
  } catch (error) {
    log.error("bump_memory_access error", { error: String(error) });
  }
}

/**
 * Find the most similar existing fact to a given content.
 * Uses the search Edge Function for semantic similarity.
 */
export async function findSimilarFact(
  supabase: SupabaseClient | null,
  content: string,
  threshold: number = COMPLEMENT_THRESHOLD,
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
    // R7: optional feature -> skip
    return null;
  }
}

/**
 * Determine how to handle a new fact based on similarity to existing facts.
 * - >= 0.85: duplicate -> skip, bump access
 * - >= 0.80: contradiction -> update existing
 * - >= 0.75: complement -> merge into existing
 * - < 0.75: new -> insert normally
 */
export async function resolveMemoryConflict(
  supabase: SupabaseClient | null,
  content: string,
): Promise<ConflictResolution> {
  if (!supabase) return { action: "insert" };

  const similar = await findSimilarFact(supabase, content, COMPLEMENT_THRESHOLD);
  if (!similar) return { action: "insert" };

  if (similar.similarity >= DUPLICATE_THRESHOLD) {
    await bumpMemoryAccess(supabase, [similar.id]);
    log.info(`Memory deduplicated (sim: ${similar.similarity.toFixed(2)}): "${content}"`);
    return { action: "skip", existingId: similar.id };
  }

  if (similar.similarity >= CONTRADICTION_THRESHOLD) {
    log.info(
      `Memory contradiction detected (sim: ${similar.similarity.toFixed(2)}): "${content}" vs "${similar.content}"`,
    );
    return { action: "update", existingId: similar.id };
  }

  log.info(
    `Memory complement detected (sim: ${similar.similarity.toFixed(2)}): "${content}" -> enriching "${similar.content}"`,
  );
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
  mode: "update" | "merge",
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

    const finalContent = mode === "update" ? newContent : `${existing.content}. ${newContent}`;

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
      log.error("updateMemoryWithRevision error", { error: String(error) });
      return false;
    }

    return true;
  } catch (error) {
    log.error("updateMemoryWithRevision error", { error: String(error) });
    return false;
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
  threshold: number = 0.8,
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
      (m) => m.type === "fact" && m.similarity >= threshold,
    );
    return match ? { id: match.id, content: match.content, similarity: match.similarity } : null;
  } catch {
    // R7: optional feature -> skip
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
  newContent: string,
): Promise<{ existingContent: string; similarity: number } | null> {
  if (!supabase) return null;

  const contradiction = await findContradiction(supabase, newContent);
  if (!contradiction) return null;

  log.info(
    `Potential contradiction detected: "${newContent}" vs existing "${contradiction.content}" (similarity: ${contradiction.similarity})`,
  );

  return {
    existingContent: contradiction.content,
    similarity: contradiction.similarity,
  };
}
