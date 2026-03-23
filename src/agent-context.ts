/**
 * @module agent-context
 * @description Supabase context assembly for BMad agents: memory, sprint, tasks, profile,
 * code graph, trust scores, sprint metrics, and document shards with token budgets per role.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { findAffectedModules, formatGraphContext, getGraph } from "./code-graph.ts";
import { buildTaskContext } from "./document-sharding.ts";
import { createLogger } from "./logger.ts";
import { buildMemoryChains, findSimilarPastTasks } from "./memory.ts";
import type { AgentRole } from "./orchestrator.ts";
import { getCachedTrustScore, getCachedTrustScores } from "./trust-scores.ts";

const log = createLogger("agent-context");
const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();

// ── Token Budgets per Role ───────────────────────────────────

/** Approximate chars per token for budget estimation */
const CHARS_PER_TOKEN = 4;

/**
 * Token budget per agent role.
 * S40: Increased by ~30% to accommodate trust scores, metrics, and doc shards.
 * Analyst/PM need more context (strategic), Dev needs less (tactical).
 * SPEC-memoire-hybride: added planner(3000) and explorer(3000) (F-SS-2 fix).
 */
const ROLE_TOKEN_BUDGETS: Record<string, number> = {
  analyst: 4000,
  pm: 3500,
  architect: 3500,
  dev: 2000,
  qa: 2500,
  sm: 2000,
  planner: 3000,
  explorer: 3000,
};

/**
 * Share of char budget allocated to MEMOIRE ROLE section.
 * Fixed at 0.10 (without exploration) / 0.08 (with exploration).
 * V7: must be in range [0.08, 0.12].
 */
export const ROLE_MEMORY_SHARE = 0.1;
export const ROLE_MEMORY_SHARE_WITH_EXPLORATION = 0.08;

export function getTokenBudget(role: AgentRole | string): number {
  return ROLE_TOKEN_BUDGETS[role] ?? 2500;
}

// ── Context Assembly ─────────────────────────────────────────

export interface AgentContextOptions {
  role: AgentRole | string;
  projectId?: string;
  sprintId?: string;
  taskTitle?: string;
  /** S43: Conversation context from the session that triggered this agent */
  conversationContext?: string;
  /** Exploration phase: formatted exploration report to inject into agent context */
  explorationReport?: string;
}

/**
 * Assemble Supabase context for a BMad agent.
 *
 * Fetches memory (facts/goals), sprint summary, recent tasks, user profile,
 * code graph, trust scores, sprint metrics, and document shards in parallel.
 * Returns a formatted string ready for --append-system-prompt.
 * Returns "" if supabase is null or all fetches fail.
 *
 * S40: Enhanced with trust scores, sprint metrics, and document shards.
 * Priority-based allocation across 8 sections with role-aware weights.
 */
export async function buildAgentContext(
  supabase: SupabaseClient | null,
  options: AgentContextOptions,
): Promise<string> {
  if (!supabase) return "";

  const { role, projectId, sprintId } = options;
  const budget = getTokenBudget(role);
  const charBudget = budget * CHARS_PER_TOKEN;
  try {
    // Base fetches — S41: use memory chains
    const memoryFetch = buildMemoryChains(supabase, role);

    const baseFetches: Promise<string>[] = [
      memoryFetch,
      fetchSprintContext(supabase, sprintId),
      fetchRecentTasks(supabase, projectId),
      loadProfile(),
    ];

    // S40: Enhanced fetches (parallel)
    // S41: Add similar past tasks fetch
    const enhancedFetches: Promise<string>[] = [
      fetchTrustContext(role),
      fetchSprintMetrics(supabase, sprintId),
      fetchDocumentContext(supabase, projectId, options.taskTitle),
      fetchSimilarTasksContext(supabase, options.taskTitle),
    ];

    const [memoryCtx, sprintCtx, tasksCtx, profileCtx, trustCtx, metricsCtx, docCtx, similarCtx] =
      await Promise.all([...baseFetches, ...enhancedFetches]);

    // S39: Code graph context
    let graphCtx = "";
    if (options.taskTitle) {
      try {
        const graph = getGraph();
        const affected = findAffectedModules(graph, options.taskTitle);
        if (affected.length > 0) {
          graphCtx = affected
            .slice(0, 3)
            .map((m) => formatGraphContext(graph, m, role))
            .filter(Boolean)
            .join("\n---\n");
        }
      } catch {
        // Best-effort
      }
    }

    // Priority-based truncation with role-aware weights
    // S41: Rebalanced shares to include similar tasks section
    // SPEC-memoire-hybride: Rebalanced to accommodate MEMOIRE ROLE section (spec 6.5)
    const sections: Array<{ label: string; content: string; share: number }> = [];

    // Shares rebalanced to accommodate exploration report and MEMOIRE ROLE (spec 6.5)
    // Without exploration total: 0.20+0.08+0.11+0.08+0.06+0.08+0.08+0.07+0.08+0.06+0.10 = 1.00
    // With exploration total: 0.18+0.10+0.07+0.09+0.07+0.05+0.06+0.07+0.05+0.06+0.05+0.08 = 0.93
    const hasExploration = !!options.explorationReport;
    if (memoryCtx)
      sections.push({
        label: "CONTEXTE MEMOIRE",
        content: memoryCtx,
        share: hasExploration ? 0.18 : 0.2,
      });
    if (options.explorationReport)
      sections.push({
        label: "RAPPORT EXPLORATION",
        content: options.explorationReport,
        share: 0.1,
      });
    if (sprintCtx)
      sections.push({
        label: "SPRINT ACTUEL",
        content: sprintCtx,
        share: hasExploration ? 0.07 : 0.08,
      });
    if (tasksCtx)
      sections.push({
        label: "TACHES RECENTES",
        content: tasksCtx,
        share: hasExploration ? 0.09 : 0.11,
      });
    if (graphCtx)
      sections.push({
        label: "GRAPHE CODE",
        content: graphCtx,
        share: hasExploration ? 0.07 : 0.08,
      });
    if (trustCtx)
      sections.push({
        label: "CONFIANCE AGENTS",
        content: trustCtx,
        share: hasExploration ? 0.05 : 0.06,
      });
    if (metricsCtx)
      sections.push({
        label: "METRIQUES SPRINT",
        content: metricsCtx,
        share: hasExploration ? 0.06 : 0.08,
      });
    if (docCtx)
      sections.push({
        label: "DOCUMENTS PROJET",
        content: docCtx,
        share: hasExploration ? 0.07 : 0.08,
      });
    if (profileCtx)
      sections.push({
        label: "PROFIL UTILISATEUR",
        content: profileCtx,
        share: hasExploration ? 0.05 : 0.07,
      });
    if (similarCtx)
      sections.push({
        label: "TACHES SIMILAIRES",
        content: similarCtx,
        share: hasExploration ? 0.06 : 0.08,
      });
    if (options.conversationContext)
      sections.push({
        label: "CONTEXTE CONVERSATION",
        content: options.conversationContext,
        share: hasExploration ? 0.05 : 0.06,
      });

    // SPEC-memoire-hybride V4/V7: MEMOIRE ROLE content is already injected into memoryCtx
    // by buildMemoryChains() when agent_role_memory flag is enabled.
    // The shares above (CONTEXTE MEMOIRE: 0.20) already account for the role memory content.
    // The rebalanced shares in spec 6.5 ensure the total remains <= 1.0 after adding role memory.

    if (sections.length === 0) return "";

    const parts: string[] = ["--- CONTEXTE PROJET (Supabase) ---"];
    let totalChars = parts[0].length;

    for (const section of sections) {
      const maxChars =
        section.label === "PROFIL UTILISATEUR"
          ? Math.min(Math.floor(charBudget * section.share), 500 * CHARS_PER_TOKEN)
          : Math.floor(charBudget * section.share);

      const truncated =
        section.content.length > maxChars
          ? section.content.substring(0, maxChars) + "..."
          : section.content;

      if (totalChars + truncated.length + section.label.length + 4 > charBudget) break;

      parts.push(`\n${section.label}:\n${truncated}`);
      totalChars += truncated.length + section.label.length + 4;
    }

    return parts.join("\n");
  } catch (error) {
    log.error("buildAgentContext error", { error: String(error) });
    return "";
  }
}

// ── Data Fetchers ────────────────────────────────────────────

async function _fetchMemoryContext(supabase: SupabaseClient): Promise<string> {
  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push(
        "Faits cles:\n" +
          factsResult.data
            .slice(0, 10)
            .map((f: { content: string }) => `- ${f.content}`)
            .join("\n"),
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "Objectifs actifs:\n" +
          goalsResult.data
            .slice(0, 5)
            .map((g: { content: string; deadline?: string | null }) => {
              const deadline = g.deadline
                ? ` (echeance: ${new Date(g.deadline).toLocaleDateString("fr-FR")})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n"),
      );
    }

    return parts.join("\n\n");
  } catch {
    return "";
  }
}

async function fetchSprintContext(supabase: SupabaseClient, sprintId?: string): Promise<string> {
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

async function fetchRecentTasks(supabase: SupabaseClient, projectId?: string): Promise<string> {
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
      .map((t: { status: string; priority: number; title: string }) => {
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
    const lines = content.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("## "));
    return Promise.resolve(lines.join("\n"));
  } catch {
    return Promise.resolve("");
  }
}

// ── S40: Enhanced Context Fetchers ───────────────────────────

/**
 * Fetch trust score context for the current agent role.
 * Reads from in-memory cache (no DB call needed).
 * Shows this agent's trust + peers for collaborative awareness.
 */
export async function fetchTrustContext(role: AgentRole | string): Promise<string> {
  try {
    const ownScore = getCachedTrustScore(role);
    const allScores = getCachedTrustScores();
    const roles = Object.keys(allScores);

    if (roles.length === 0 && ownScore.totalEvaluations === 0) return "";

    const lines: string[] = [];
    lines.push(
      `Ton score de confiance: ${ownScore.score}/100 (${ownScore.totalPasses}/${ownScore.totalEvaluations} passes)`,
    );

    if (ownScore.score >= 80) {
      lines.push("Statut: fiable — auto-approbation possible pour les gates spec/plan (P3+)");
    }
    if (ownScore.score >= 90) {
      lines.push(
        "Statut: tres fiable — auto-approbation possible pour les gates implementation (P3+)",
      );
    }
    if (ownScore.consecutiveFailures > 0) {
      lines.push(
        `Attention: ${ownScore.consecutiveFailures} echec(s) consecutif(s) — sois plus rigoureux`,
      );
    }

    // Peer scores (compact)
    const peers = roles.filter((r) => r !== role);
    if (peers.length > 0) {
      const peerSummary = peers.map((r) => `${r}:${allScores[r].score}`).join(", ");
      lines.push(`Pairs: ${peerSummary}`);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Fetch sprint metrics: velocity and rework rate from sprint_metrics table.
 * Provides historical context for the agent.
 */
export async function fetchSprintMetrics(
  supabase: SupabaseClient,
  _sprintId?: string,
): Promise<string> {
  try {
    const { data, error } = await supabase
      .from("sprint_metrics")
      .select("sprint_id, velocity, rework_rate, cycle_time_avg, created_at")
      .order("created_at", { ascending: false })
      .limit(3);

    if (error || !data?.length) return "";

    const lines: string[] = [];

    for (const m of data) {
      const parts: string[] = [`${m.sprint_id}:`];
      if (m.velocity != null) parts.push(`velocite=${m.velocity}`);
      if (m.rework_rate != null) parts.push(`rework=${Math.round(m.rework_rate * 100)}%`);
      if (m.cycle_time_avg != null) parts.push(`cycle=${Math.round(m.cycle_time_avg)}h`);
      lines.push(parts.join(" "));
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Fetch relevant document shards (PRDs, architecture docs) for the task.
 * Delegates to document-sharding.ts buildTaskContext().
 */
export async function fetchDocumentContext(
  supabase: SupabaseClient,
  projectId?: string,
  taskTitle?: string,
): Promise<string> {
  if (!projectId || !taskTitle) return "";

  try {
    return await buildTaskContext(supabase, taskTitle, projectId, 1500);
  } catch {
    return "";
  }
}

/**
 * Fetch similar past tasks for estimation context (S41-05).
 * Shows completed tasks with matching keywords: estimated vs actual hours.
 */
export async function fetchSimilarTasksContext(
  supabase: SupabaseClient,
  taskTitle?: string,
): Promise<string> {
  if (!taskTitle) return "";

  try {
    const similar = await findSimilarPastTasks(supabase, taskTitle);
    if (similar.length === 0) return "";

    return similar
      .map((t) => {
        const parts: string[] = [`- ${t.title}`];
        if (t.estimatedHours != null) parts.push(`est:${t.estimatedHours}h`);
        if (t.actualHours != null) parts.push(`reel:${t.actualHours}h`);
        if (t.sprint) parts.push(`(${t.sprint})`);
        return parts.join(" ");
      })
      .join("\n");
  } catch {
    return "";
  }
}
