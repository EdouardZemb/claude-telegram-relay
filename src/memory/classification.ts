/**
 * @module memory.classification
 * @description Message classification, auto-remember, idea deduplication, link classification.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "../logger.ts";
import { enqueue } from "../notification-queue.ts";
import {
  ACTIONABILITY_THRESHOLD,
  type MemorySearchResult,
  resolveMemoryConflict,
  updateMemoryWithRevision,
} from "./scoring.ts";

const log = createLogger("memory.classification");

// ── Interfaces ────────────────────────────────────────────────

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

// ── Private Functions ─────────────────────────────────────────

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
 * Auto-create goals from classification action_items.
 * Extracted for reuse in conflict resolution paths (S36-03/04/05).
 */
async function autoCreateGoals(
  supabase: SupabaseClient,
  classification: ThoughtClassification,
): Promise<void> {
  if (!classification.action_items?.length) return;

  for (const item of classification.action_items) {
    const { error: goalError } = await supabase.from("memory").insert({
      type: "goal",
      content: item,
      metadata: { auto_classified: true, source: "action-item", topics: classification.topics },
    });
    if (goalError) log.error("auto-remember goal insert error", { error: String(goalError) });
  }
}

// ── Public Functions ──────────────────────────────────────────

/**
 * Classify a message via the classify-thought Edge Function.
 * Returns structured metadata (type, topics, action_items, is_memorable).
 * Fails silently if the Edge Function is not deployed.
 */
export async function classifyMessage(
  supabase: SupabaseClient | null,
  content: string,
  role: string = "user",
): Promise<ThoughtClassification | null> {
  if (!supabase || !content) return null;

  try {
    const { data, error } = await supabase.functions.invoke("classify-thought", {
      body: { content, role },
    });

    if (error || !data) return null;
    return data as ThoughtClassification;
  } catch {
    // R7: optional feature -> skip
    return null;
  }
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
  classification: ThoughtClassification,
): Promise<void> {
  if (!supabase || !classification.is_memorable) return;

  try {
    const memoryContent = classification.summary || content;
    const memoryType = resolveMemoryType(classification);

    // S36-06: Actionability filter (bypass for ideas)
    if (memoryType !== "idea") {
      const actionability = classification.actionability_score ?? 7; // EC-003: default 7
      if (actionability < ACTIONABILITY_THRESHOLD) {
        log.info(`Memory filtered by actionability (score: ${actionability}): "${memoryContent}"`);
        return;
      }
    }

    // Semantic deduplication for ideas (S21-04)
    if (memoryType === "idea") {
      const duplicate = await findDuplicateIdea(supabase, memoryContent);
      if (duplicate) {
        log.info(`Idea deduplicated (similar to: "${duplicate}")`);
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
        await updateMemoryWithRevision(
          supabase,
          resolution.existingId,
          memoryContent,
          resolution.action,
        );
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

    if (error) log.error("auto-remember insert error", { error: String(error) });
    else if (memoryType === "idea") {
      const autoPreview =
        memoryContent.length > 80 ? memoryContent.slice(0, 80) + "..." : memoryContent;
      const ts = new Date().toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
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
    log.error("auto-remember error", { error: String(error) });
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
  threshold: number = 0.85,
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
    // R7: optional feature -> skip
    return null;
  }
}

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
  const stopWords = new Set([
    "est",
    "les",
    "des",
    "une",
    "par",
    "sur",
    "dans",
    "pour",
    "avec",
    "que",
    "qui",
    "the",
    "and",
    "for",
    "are",
    "was",
    "has",
    "its",
    "this",
    "that",
    "with",
    "from",
  ]);
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
