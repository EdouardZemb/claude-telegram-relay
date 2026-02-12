/**
 * Proactive Planner — S16-10
 *
 * Analyzes the backlog periodically and proposes:
 * - Priority reordering based on dependencies
 * - Task grouping by similarity
 * - Sprint pacing recommendations
 * - Blockers and risk identification
 *
 * Designed to run on a schedule (e.g., daily morning) and send
 * a notification to Telegram with inline buttons for validation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "./tasks.ts";

// ── Types ────────────────────────────────────────────────────

export interface PlannerRecommendation {
  type: "reorder" | "group" | "pace" | "blocker" | "split" | "deprioritize";
  title: string;
  description: string;
  taskIds: string[];
  confidence: number; // 0-1
}

export interface PlannerResult {
  recommendations: PlannerRecommendation[];
  sprintHealth: {
    onTrack: boolean;
    completionRate: number;
    estimatedDaysLeft: number;
    backlogSize: number;
  };
  summary: string;
}

// ── Backlog Analysis ─────────────────────────────────────────

/**
 * Analyze the current sprint's backlog and generate recommendations.
 */
export async function analyzeBacklog(
  supabase: SupabaseClient,
  sprintId?: string
): Promise<PlannerResult> {
  // Get all tasks for the sprint (or all active tasks)
  let query = supabase
    .from("tasks")
    .select("*")
    .neq("status", "cancelled")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (sprintId) {
    query = query.eq("sprint", sprintId);
  } else {
    query = query.neq("status", "done");
  }

  const { data: tasks } = await query;
  if (!tasks || tasks.length === 0) {
    return {
      recommendations: [],
      sprintHealth: { onTrack: true, completionRate: 100, estimatedDaysLeft: 0, backlogSize: 0 },
      summary: "Backlog vide. Rien a analyser.",
    };
  }

  const recommendations: PlannerRecommendation[] = [];

  // Analyze stuck tasks
  const stuckRecs = detectStuckPatterns(tasks);
  recommendations.push(...stuckRecs);

  // Analyze groupable tasks
  const groupRecs = detectGroupableTasks(tasks);
  recommendations.push(...groupRecs);

  // Analyze pacing
  const paceRecs = analyzePacing(tasks, sprintId);
  recommendations.push(...paceRecs);

  // Analyze priority inversions
  const prioRecs = detectPriorityInversions(tasks);
  recommendations.push(...prioRecs);

  // Analyze large tasks that could be split
  const splitRecs = detectSplittableTasks(tasks);
  recommendations.push(...splitRecs);

  // Sprint health
  const total = tasks.length;
  const done = tasks.filter((t: any) => t.status === "done").length;
  const inProgress = tasks.filter((t: any) => t.status === "in_progress").length;
  const backlog = tasks.filter((t: any) => t.status === "backlog").length;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;

  // Estimate days left based on velocity
  const firstTask = tasks.reduce((earliest: any, t: any) =>
    new Date(t.created_at) < new Date(earliest.created_at) ? t : earliest
  );
  const sprintAgeDays = (Date.now() - new Date(firstTask.created_at).getTime()) / (24 * 60 * 60 * 1000);
  const velocity = sprintAgeDays > 0 ? done / sprintAgeDays : 0;
  const remaining = total - done;
  const estimatedDaysLeft = velocity > 0 ? Math.ceil(remaining / velocity) : remaining * 2;

  const onTrack = completionRate >= (sprintAgeDays / 7) * 80;

  // Build summary
  const summary = buildPlannerSummary(recommendations, {
    total, done, inProgress, backlog, completionRate, estimatedDaysLeft, onTrack,
  });

  return {
    recommendations: recommendations.sort((a, b) => b.confidence - a.confidence),
    sprintHealth: { onTrack, completionRate, estimatedDaysLeft, backlogSize: backlog },
    summary,
  };
}

// ── Pattern Detectors ────────────────────────────────────────

function detectStuckPatterns(tasks: any[]): PlannerRecommendation[] {
  const recs: PlannerRecommendation[] = [];
  const now = Date.now();

  for (const task of tasks) {
    if (task.status === "in_progress") {
      const updatedAt = task.updated_at ? new Date(task.updated_at).getTime() : NaN;
      if (isNaN(updatedAt)) continue;
      const age = (now - updatedAt) / (60 * 60 * 1000);
      if (age > 24) {
        recs.push({
          type: "blocker",
          title: `Tache potentiellement bloquee`,
          description: `"${task.title}" est en cours depuis ${Math.round(age)}h sans mise a jour. A verifier.`,
          taskIds: [task.id],
          confidence: age > 48 ? 0.9 : 0.6,
        });
      }
    }
  }

  return recs;
}

function detectGroupableTasks(tasks: any[]): PlannerRecommendation[] {
  const recs: PlannerRecommendation[] = [];
  const backlogTasks = tasks.filter((t: any) => t.status === "backlog");

  // Group by common words in title
  const wordGroups: Record<string, string[]> = {};
  for (const task of backlogTasks) {
    const words = task.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4);
    for (const word of words) {
      if (!wordGroups[word]) wordGroups[word] = [];
      wordGroups[word].push(task.id);
    }
  }

  for (const [word, ids] of Object.entries(wordGroups)) {
    if (ids.length >= 2) {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length >= 2) {
        const titles = uniqueIds.map((id) =>
          backlogTasks.find((t: any) => t.id === id)?.title || id.substring(0, 8)
        );
        recs.push({
          type: "group",
          title: `Taches liees: "${word}"`,
          description: `${uniqueIds.length} taches partagent le theme "${word}". Grouper pour execution sequentielle :\n${titles.map((t) => `  - ${t}`).join("\n")}`,
          taskIds: uniqueIds,
          confidence: uniqueIds.length >= 3 ? 0.8 : 0.5,
        });
      }
    }
  }

  // Deduplicate overlapping groups
  return deduplicateGroups(recs);
}

function analyzePacing(tasks: any[], sprintId?: string): PlannerRecommendation[] {
  const recs: PlannerRecommendation[] = [];
  const total = tasks.length;
  const done = tasks.filter((t: any) => t.status === "done").length;
  const remaining = total - done;

  if (remaining > 8) {
    recs.push({
      type: "pace",
      title: "Backlog charge",
      description: `${remaining} taches restantes. Envisager de reporter les P3 au prochain sprint.`,
      taskIds: tasks.filter((t: any) => t.status === "backlog" && t.priority >= 3).map((t: any) => t.id),
      confidence: remaining > 12 ? 0.8 : 0.5,
    });
  }

  // Check for too many in_progress at once
  const inProgress = tasks.filter((t: any) => t.status === "in_progress");
  if (inProgress.length > 2) {
    recs.push({
      type: "pace",
      title: "Trop de taches en parallele",
      description: `${inProgress.length} taches en cours simultanement. Recommande: finir les taches en cours avant d'en commencer de nouvelles.`,
      taskIds: inProgress.map((t: any) => t.id),
      confidence: 0.7,
    });
  }

  return recs;
}

function detectPriorityInversions(tasks: any[]): PlannerRecommendation[] {
  const recs: PlannerRecommendation[] = [];

  // Find P2/P3 tasks started before P1 tasks
  const p1Backlog = tasks.filter((t: any) => t.priority === 1 && t.status === "backlog");
  const lowPrioInProgress = tasks.filter((t: any) => t.priority >= 2 && t.status === "in_progress");

  if (p1Backlog.length > 0 && lowPrioInProgress.length > 0) {
    recs.push({
      type: "reorder",
      title: "Inversion de priorite",
      description: `${p1Backlog.length} tache(s) P1 en attente alors que ${lowPrioInProgress.length} tache(s) P2+ sont en cours. Recommande: prioriser les P1.`,
      taskIds: [...p1Backlog.map((t: any) => t.id), ...lowPrioInProgress.map((t: any) => t.id)],
      confidence: 0.85,
    });
  }

  return recs;
}

function detectSplittableTasks(tasks: any[]): PlannerRecommendation[] {
  const recs: PlannerRecommendation[] = [];

  for (const task of tasks) {
    if (task.status === "backlog" && task.title.length > 60) {
      recs.push({
        type: "split",
        title: "Tache potentiellement trop large",
        description: `"${task.title}" semble complexe. Envisager /plan pour la decomposer.`,
        taskIds: [task.id],
        confidence: 0.4,
      });
    }
  }

  return recs;
}

function deduplicateGroups(recs: PlannerRecommendation[]): PlannerRecommendation[] {
  const seen = new Set<string>();
  return recs.filter((rec) => {
    const key = rec.taskIds.sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Summary Builder ──────────────────────────────────────────

function buildPlannerSummary(
  recs: PlannerRecommendation[],
  health: { total: number; done: number; inProgress: number; backlog: number; completionRate: number; estimatedDaysLeft: number; onTrack: boolean }
): string {
  const lines: string[] = [];
  const status = health.onTrack ? "nominal" : "attention requise";

  lines.push(`ANALYSE BACKLOG — ${status}`);
  lines.push(`Progression: ${health.done}/${health.total} (${health.completionRate}%)`);
  lines.push(`En cours: ${health.inProgress} | Backlog: ${health.backlog}`);
  lines.push(`Estimation: ~${health.estimatedDaysLeft} jours restants`);

  if (recs.length > 0) {
    lines.push("");
    lines.push(`${recs.length} recommandation${recs.length > 1 ? "s" : ""}:`);
    for (const rec of recs.slice(0, 5)) {
      lines.push(`  ${rec.title} (confiance: ${Math.round(rec.confidence * 100)}%)`);
    }
  }

  return lines.join("\n");
}

// ── Format for Telegram ──────────────────────────────────────

export function formatPlannerResult(result: PlannerResult): string {
  const lines: string[] = [];

  lines.push(result.summary);
  lines.push("");

  if (result.recommendations.length === 0) {
    lines.push("Aucune recommandation. Le backlog est bien organise.");
    return lines.join("\n");
  }

  lines.push("RECOMMANDATIONS:");
  lines.push("");

  for (const rec of result.recommendations.slice(0, 8)) {
    const confidence = Math.round(rec.confidence * 100);
    lines.push(`[${rec.type.toUpperCase()}] ${rec.title} (${confidence}%)`);
    lines.push(`  ${rec.description}`);
    lines.push("");
  }

  if (result.recommendations.length > 8) {
    lines.push(`... +${result.recommendations.length - 8} autres recommandations`);
  }

  return lines.join("\n").trim();
}
