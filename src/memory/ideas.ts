/**
 * @module memory.ideas
 * @description Ideas CRUD: list, get, review, promote, archive, format.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sectionTitle } from "../html-format-helpers.ts";
import { escapeHtml } from "../html-utils.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("memory.ideas");

// ── Interfaces ────────────────────────────────────────────────

export interface Idea {
  id: string;
  content: string;
  idea_status: "new" | "reviewed" | "promoted" | "archived";
  metadata: Record<string, unknown>;
  created_at: string;
}

// ── Functions ─────────────────────────────────────────────────

/**
 * List ideas filtered by status.
 * Defaults to showing new + reviewed ideas.
 */
export async function listIdeas(
  supabase: SupabaseClient | null,
  statusFilter: string[] = ["new", "reviewed"],
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
      log.error("list ideas error", { error: String(error) });
      return [];
    }

    return (data || []) as Idea[];
  } catch (error) {
    log.error("list ideas error", { error: String(error) });
    return [];
  }
}

/**
 * Get a single idea by ID.
 */
export async function getIdea(supabase: SupabaseClient | null, id: string): Promise<Idea | null> {
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
    // R8: business error -> log.warn
    log.warn("getIdeaByPrefix catch", { id });
    return null;
  }
}

/**
 * Update idea status to "reviewed".
 */
export async function reviewIdea(supabase: SupabaseClient | null, id: string): Promise<boolean> {
  if (!supabase || !id) return false;

  try {
    const { error } = await supabase
      .from("memory")
      .update({ idea_status: "reviewed" })
      .eq("id", id)
      .eq("type", "idea");

    if (error) {
      log.error("review idea error", { error: String(error) });
      return false;
    }
    return true;
  } catch {
    // R8: business error -> log.warn
    log.warn("reviewIdea catch", { id });
    return false;
  }
}

/**
 * Promote an idea: set status to "promoted".
 * Returns the idea content for task creation by the caller.
 */
export async function promoteIdea(
  supabase: SupabaseClient | null,
  id: string,
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
      log.error("promote idea error", { error: String(error) });
      return null;
    }
    return data?.content || null;
  } catch {
    // R8: business error -> log.warn
    log.warn("promoteIdea catch", { id });
    return null;
  }
}

/**
 * Archive an idea (soft-delete).
 */
export async function archiveIdea(supabase: SupabaseClient | null, id: string): Promise<boolean> {
  if (!supabase || !id) return false;

  try {
    const { error } = await supabase
      .from("memory")
      .update({ idea_status: "archived" })
      .eq("id", id)
      .eq("type", "idea");

    if (error) {
      log.error("archive idea error", { error: String(error) });
      return false;
    }
    return true;
  } catch {
    // R8: business error -> log.warn
    log.warn("archiveIdea catch", { id });
    return false;
  }
}

/**
 * Format ideas list for Telegram (HTML formatting via sendResponseHtml).
 */
const IDEA_STATUS_ICONS: Record<string, string> = {
  new: "\uD83C\uDD95",
  reviewed: "\uD83D\uDD0D",
  promoted: "\u2B50",
  archived: "\uD83D\uDCE6",
};

export function formatIdeasList(ideas: Idea[]): string {
  if (!ideas.length) return "Aucune idee trouvee.";

  const lines: string[] = [sectionTitle(`Idees (${ideas.length})`), ""];
  for (const idea of ideas) {
    const icon = IDEA_STATUS_ICONS[idea.idea_status] || "";
    const date = new Date(idea.created_at).toLocaleDateString("fr-FR");
    const topics = Array.isArray(idea.metadata?.topics)
      ? " [" + (idea.metadata.topics as string[]).map((t) => escapeHtml(t)).join(", ") + "]"
      : "";
    lines.push(`${icon} <code>${idea.id.slice(0, 8)}</code> ${escapeHtml(idea.content)}${topics}`);
    lines.push(`     <i>${date}</i>`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
