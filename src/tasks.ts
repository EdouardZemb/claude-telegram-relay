/**
 * Task/Backlog Management
 *
 * CRUD operations on the `tasks` table in Supabase.
 * Used by Telegram commands and the dashboard API.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface Subtask {
  title: string;
  ac_mapping?: string;
  done?: boolean;
}

export interface Task {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  description: string | null;
  project: string;
  status: "backlog" | "in_progress" | "review" | "done" | "cancelled";
  priority: number;
  sprint: string | null;
  tags: string[];
  estimated_hours: number | null;
  actual_hours: number | null;
  blocked_by: string | null;
  notes: string | null;
  completed_at: string | null;
  // BMad Story File fields
  acceptance_criteria: string | null;
  dev_notes: string | null;
  architecture_ref: string | null;
  subtasks: Subtask[];
}

// ── Queries ──────────────────────────────────────────────────

export async function addTask(
  supabase: SupabaseClient,
  title: string,
  opts?: {
    description?: string;
    project?: string;
    priority?: number;
    sprint?: string;
    tags?: string[];
    acceptance_criteria?: string;
    dev_notes?: string;
    architecture_ref?: string;
    subtasks?: Subtask[];
  }
): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      title,
      description: opts?.description ?? null,
      project: opts?.project ?? "telegram-relay",
      priority: opts?.priority ?? 3,
      sprint: opts?.sprint ?? null,
      tags: opts?.tags ?? [],
      acceptance_criteria: opts?.acceptance_criteria ?? null,
      dev_notes: opts?.dev_notes ?? null,
      architecture_ref: opts?.architecture_ref ?? null,
      subtasks: opts?.subtasks ?? [],
    })
    .select()
    .single();

  if (error) {
    console.error("addTask error:", error);
    return null;
  }
  return data as Task;
}

export async function getBacklog(
  supabase: SupabaseClient,
  opts?: { project?: string; sprint?: string; status?: string }
): Promise<Task[]> {
  let query = supabase
    .from("tasks")
    .select("*")
    .neq("status", "cancelled")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (opts?.project) query = query.eq("project", opts.project);
  if (opts?.sprint) query = query.eq("sprint", opts.sprint);
  if (opts?.status) query = query.eq("status", opts.status);

  const { data, error } = await query;
  if (error) {
    console.error("getBacklog error:", error);
    return [];
  }
  return (data ?? []) as Task[];
}

export async function updateTaskStatus(
  supabase: SupabaseClient,
  taskId: string,
  status: Task["status"]
): Promise<Task | null> {
  const update: Record<string, unknown> = { status };
  if (status === "done") update.completed_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("tasks")
    .update(update)
    .eq("id", taskId)
    .select()
    .single();

  if (error) {
    console.error("updateTaskStatus error:", error);
    return null;
  }
  return data as Task;
}

export async function assignSprint(
  supabase: SupabaseClient,
  taskId: string,
  sprint: string
): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .update({ sprint })
    .eq("id", taskId)
    .select()
    .single();

  if (error) {
    console.error("assignSprint error:", error);
    return null;
  }
  return data as Task;
}

export async function getSprintSummary(
  supabase: SupabaseClient,
  sprint: string
): Promise<{ total: number; backlog: number; in_progress: number; review: number; done: number }> {
  const { data, error } = await supabase.rpc("get_sprint_summary", { p_sprint: sprint });
  if (error || !data) {
    console.error("getSprintSummary error:", error);
    return { total: 0, backlog: 0, in_progress: 0, review: 0, done: 0 };
  }
  return data;
}

export async function getCurrentSprint(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase
    .from("tasks")
    .select("sprint")
    .not("sprint", "is", null)
    .neq("status", "done")
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data?.sprint ?? null;
}

// ── Formatting ───────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  backlog: "[ ]",
  in_progress: "[>]",
  review: "[?]",
  done: "[x]",
  cancelled: "[-]",
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
  5: "P5",
};

export function formatTask(task: Task, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const status = STATUS_LABELS[task.status] || task.status;
  const prio = PRIORITY_LABELS[task.priority] || "";
  const sprint = task.sprint ? ` (${task.sprint})` : "";
  return `${prefix}${status} ${prio} ${task.title}${sprint}`;
}

export function formatBacklog(tasks: Task[], title?: string): string {
  if (tasks.length === 0) return "Backlog vide. Utilise /task pour ajouter des taches.";

  const header = title || "Backlog";
  const grouped: Record<string, Task[]> = {};

  for (const t of tasks) {
    const key = t.status;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  }

  const sections: string[] = [header, ""];

  const order = ["in_progress", "review", "backlog", "done"];
  const sectionNames: Record<string, string> = {
    in_progress: "En cours",
    review: "En review",
    backlog: "A faire",
    done: "Fait",
  };

  for (const status of order) {
    const items = grouped[status];
    if (!items || items.length === 0) continue;
    sections.push(`-- ${sectionNames[status]} --`);
    for (const t of items) {
      const prio = PRIORITY_LABELS[t.priority] || "";
      const sprint = t.sprint ? ` (${t.sprint})` : "";
      const id = t.id.substring(0, 8);
      sections.push(`  ${prio} ${t.title}${sprint}  [${id}]`);
    }
    sections.push("");
  }

  return sections.join("\n").trim();
}

export function formatSprintSummary(sprint: string, summary: { total: number; backlog: number; in_progress: number; review: number; done: number }): string {
  const progress = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
  return [
    `Sprint ${sprint}`,
    "",
    `Progression: ${summary.done}/${summary.total} (${progress}%)`,
    `A faire: ${summary.backlog}`,
    `En cours: ${summary.in_progress}`,
    `En review: ${summary.review}`,
    `Fait: ${summary.done}`,
  ].join("\n");
}
