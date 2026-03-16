/**
 * @module agent-context
 * @description Supabase context assembly for BMad agents: memory, sprint, tasks, profile with token budgets per role.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRole } from "./orchestrator.ts";
import { readFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();

// ── Token Budgets per Role ───────────────────────────────────

/** Approximate chars per token for budget estimation */
const CHARS_PER_TOKEN = 4;

/**
 * Token budget per agent role.
 * Analyst/PM need more context (strategic), Dev needs less (tactical).
 */
const ROLE_TOKEN_BUDGETS: Record<string, number> = {
  analyst: 3000,
  pm: 2500,
  architect: 2500,
  dev: 1500,
  qa: 2000,
  sm: 1500,
};

export function getTokenBudget(role: AgentRole | string): number {
  return ROLE_TOKEN_BUDGETS[role] ?? 2000;
}

// ── Context Assembly ─────────────────────────────────────────

export interface AgentContextOptions {
  role: AgentRole | string;
  projectId?: string;
  sprintId?: string;
}

/**
 * Assemble Supabase context for a BMad agent.
 *
 * Fetches memory (facts/goals), sprint summary, recent tasks, and user profile
 * in parallel. Returns a formatted string ready for --append-system-prompt.
 * Returns "" if supabase is null or all fetches fail.
 *
 * Output is truncated to the role's token budget via priority-based allocation:
 *   40% memory, 20% sprint, 25% tasks, 15% profile (capped at 500 tokens)
 */
export async function buildAgentContext(
  supabase: SupabaseClient | null,
  options: AgentContextOptions
): Promise<string> {
  if (!supabase) return "";

  const { role, projectId, sprintId } = options;
  const budget = getTokenBudget(role);
  const charBudget = budget * CHARS_PER_TOKEN;

  try {
    const [memoryCtx, sprintCtx, tasksCtx, profileCtx] = await Promise.all([
      fetchMemoryContext(supabase),
      fetchSprintContext(supabase, sprintId),
      fetchRecentTasks(supabase, projectId),
      loadProfile(),
    ]);

    // Priority-based truncation: memory > tasks > sprint > profile
    const sections: Array<{ label: string; content: string; share: number }> = [];

    if (memoryCtx) sections.push({ label: "CONTEXTE MEMOIRE", content: memoryCtx, share: 0.40 });
    if (sprintCtx) sections.push({ label: "SPRINT ACTUEL", content: sprintCtx, share: 0.20 });
    if (tasksCtx) sections.push({ label: "TACHES RECENTES", content: tasksCtx, share: 0.25 });
    if (profileCtx) sections.push({ label: "PROFIL UTILISATEUR", content: profileCtx, share: 0.15 });

    if (sections.length === 0) return "";

    const parts: string[] = ["--- CONTEXTE PROJET (Supabase) ---"];
    let totalChars = parts[0].length;

    for (const section of sections) {
      const maxChars = section.label === "PROFIL UTILISATEUR"
        ? Math.min(Math.floor(charBudget * section.share), 500 * CHARS_PER_TOKEN)
        : Math.floor(charBudget * section.share);

      const truncated = section.content.length > maxChars
        ? section.content.substring(0, maxChars) + "..."
        : section.content;

      if (totalChars + truncated.length + section.label.length + 4 > charBudget) break;

      parts.push(`\n${section.label}:\n${truncated}`);
      totalChars += truncated.length + section.label.length + 4;
    }

    return parts.join("\n");
  } catch (error) {
    console.error("buildAgentContext error:", error);
    return "";
  }
}

// ── Data Fetchers ────────────────────────────────────────────

async function fetchMemoryContext(supabase: SupabaseClient): Promise<string> {
  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push("Faits cles:\n" + factsResult.data
        .slice(0, 10)
        .map((f: any) => `- ${f.content}`)
        .join("\n"));
    }

    if (goalsResult.data?.length) {
      parts.push("Objectifs actifs:\n" + goalsResult.data
        .slice(0, 5)
        .map((g: any) => {
          const deadline = g.deadline ? ` (echeance: ${new Date(g.deadline).toLocaleDateString("fr-FR")})` : "";
          return `- ${g.content}${deadline}`;
        })
        .join("\n"));
    }

    return parts.join("\n\n");
  } catch {
    return "";
  }
}

async function fetchSprintContext(
  supabase: SupabaseClient,
  sprintId?: string
): Promise<string> {
  try {
    let sprint = sprintId;

    // Auto-detect current sprint if not provided
    if (!sprint) {
      const { data } = await supabase
        .from("tasks")
        .select("sprint")
        .not("sprint", "is", null)
        .neq("status", "done")
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      sprint = data?.sprint;
    }

    if (!sprint) return "";

    const { data, error } = await supabase.rpc("get_sprint_summary", { p_sprint: sprint });
    if (error || !data) return "";

    const progress = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
    return [
      `Sprint: ${sprint}`,
      `Progression: ${data.done}/${data.total} (${progress}%)`,
      `En cours: ${data.in_progress} | Review: ${data.review} | Backlog: ${data.backlog}`,
    ].join("\n");
  } catch {
    return "";
  }
}

async function fetchRecentTasks(
  supabase: SupabaseClient,
  projectId?: string
): Promise<string> {
  try {
    let query = supabase
      .from("tasks")
      .select("title, status, priority, sprint")
      .neq("status", "cancelled")
      .order("updated_at", { ascending: false })
      .limit(10);

    if (projectId) {
      query = query.eq("project_id", projectId);
    }

    const { data, error } = await query;
    if (error || !data?.length) return "";

    return data
      .map((t: any) => {
        const icon = t.status === "done" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
        return `${icon} P${t.priority} ${t.title}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

function loadProfile(): Promise<string> {
  try {
    const profilePath = join(PROJECT_ROOT, "config", "profile.md");
    const content = readFileSync(profilePath, "utf-8");
    // Keep only key info lines (headers + list items)
    const lines = content
      .split("\n")
      .filter((l) => l.startsWith("- ") || l.startsWith("## "));
    return Promise.resolve(lines.join("\n"));
  } catch {
    return Promise.resolve("");
  }
}
