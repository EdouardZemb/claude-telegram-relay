/**
 * Multi-Project Management
 *
 * CRUD operations for the `projects` table.
 * Provides project context resolution (from topic, from active project).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface Project {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
  description: string | null;
  repo_url: string | null;
  directory: string | null;
  status: "active" | "paused" | "archived";
  telegram_topic_id: number | null;
  current_sprint: string | null;
  workflow_config: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

// ── Active project tracking ──────────────────────────────────

/** Default project when no topic-based or explicit selection */
let activeProjectSlug: string = "telegram-relay";

export function getActiveProjectSlug(): string {
  return activeProjectSlug;
}

export function setActiveProjectSlug(slug: string): void {
  activeProjectSlug = slug;
}

// ── Queries ──────────────────────────────────────────────────

export async function createProject(
  supabase: SupabaseClient,
  opts: {
    name: string;
    slug: string;
    description?: string;
    repo_url?: string;
    directory?: string;
    telegram_topic_id?: number;
  }
): Promise<Project | null> {
  const { data, error } = await supabase
    .from("projects")
    .insert({
      name: opts.name,
      slug: opts.slug,
      description: opts.description ?? null,
      repo_url: opts.repo_url ?? null,
      directory: opts.directory ?? null,
      telegram_topic_id: opts.telegram_topic_id ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error("createProject error:", error);
    return null;
  }
  return data as Project;
}

export async function getProject(
  supabase: SupabaseClient,
  slugOrId: string
): Promise<Project | null> {
  // Try by slug first
  const { data: bySlug } = await supabase
    .from("projects")
    .select("*")
    .eq("slug", slugOrId)
    .limit(1)
    .single();

  if (bySlug) return bySlug as Project;

  // Try by ID prefix
  const { data: byId } = await supabase
    .from("projects")
    .select("*")
    .like("id", `${slugOrId}%`)
    .limit(1)
    .single();

  return byId as Project | null;
}

export async function getProjectById(
  supabase: SupabaseClient,
  id: string
): Promise<Project | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;
  return data as Project;
}

export async function listProjects(
  supabase: SupabaseClient,
  opts?: { status?: string }
): Promise<Project[]> {
  let query = supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: true });

  if (opts?.status) query = query.eq("status", opts.status);

  const { data, error } = await query;
  if (error) {
    console.error("listProjects error:", error);
    return [];
  }
  return (data ?? []) as Project[];
}

export async function updateProject(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Pick<Project, "name" | "description" | "status" | "telegram_topic_id" | "current_sprint" | "directory" | "repo_url" | "workflow_config">>
): Promise<Project | null> {
  const { data, error } = await supabase
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("updateProject error:", error);
    return null;
  }
  return data as Project;
}

export async function archiveProject(
  supabase: SupabaseClient,
  id: string
): Promise<boolean> {
  const result = await updateProject(supabase, id, { status: "archived" });
  return result !== null;
}

// ── Topic-based project resolution ──────────────────────────

/**
 * Resolve project from a Telegram topic thread ID.
 * Returns null if no project is linked to the topic.
 */
export async function resolveProjectFromTopic(
  supabase: SupabaseClient,
  topicThreadId: number
): Promise<Project | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("telegram_topic_id", topicThreadId)
    .limit(1)
    .single();

  if (error) return null;
  return data as Project;
}

/**
 * Resolve the current project context.
 * Priority: topic > explicit active > default
 */
export async function resolveProjectContext(
  supabase: SupabaseClient,
  topicThreadId?: number
): Promise<Project | null> {
  // 1. Try topic-based resolution
  if (topicThreadId) {
    const fromTopic = await resolveProjectFromTopic(supabase, topicThreadId);
    if (fromTopic) return fromTopic;
  }

  // 2. Fall back to active project slug
  return getProject(supabase, activeProjectSlug);
}

// ── Formatting ───────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  active: "ACTIF",
  paused: "PAUSE",
  archived: "ARCHIVE",
};

export function formatProjectList(projects: Project[]): string {
  if (projects.length === 0) return "Aucun projet. Utilise /project create <nom> pour en creer un.";

  const lines = ["PROJETS", ""];

  for (const p of projects) {
    const status = STATUS_LABELS[p.status] || p.status;
    const sprint = p.current_sprint ? ` | Sprint ${p.current_sprint}` : "";
    const active = p.slug === activeProjectSlug ? " << actif" : "";
    lines.push(`[${status}] ${p.name} (${p.slug})${sprint}${active}`);
    if (p.description) lines.push(`  ${p.description}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function formatProjectDetail(p: Project): string {
  const status = STATUS_LABELS[p.status] || p.status;
  const lines = [
    `${p.name} (${p.slug})`,
    `Statut: ${status}`,
    p.current_sprint ? `Sprint: ${p.current_sprint}` : "Pas de sprint actif",
    p.description ? `Description: ${p.description}` : "",
    p.repo_url ? `Repo: ${p.repo_url}` : "",
    p.directory ? `Dossier: ${p.directory}` : "",
    p.telegram_topic_id ? `Topic Telegram: ${p.telegram_topic_id}` : "Pas de topic lie",
    `ID: ${p.id.substring(0, 8)}`,
  ];
  return lines.filter(Boolean).join("\n");
}
