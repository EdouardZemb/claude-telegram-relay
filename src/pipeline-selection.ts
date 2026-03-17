/**
 * @module pipeline-selection
 * @description Dynamic pipeline selection logic: keyword-based classification,
 * adaptive difficulty-based selection, and pipeline constants. Extracted from
 * orchestrator.ts to improve modularity.
 */

import type { Task } from "./tasks.ts";
import type { AgentRole } from "./orchestrator.ts";

// ── Pipeline Constants ───────────────────────────────────────

/** Default pipeline: full BMad flow */
export const DEFAULT_PIPELINE: AgentRole[] = [
  "analyst",
  "pm",
  "architect",
  "dev",
  "qa",
];

/** Quick pipeline: skip analysis, go straight to dev */
export const QUICK_PIPELINE: AgentRole[] = ["dev", "qa"];

/** Review-only pipeline */
export const REVIEW_PIPELINE: AgentRole[] = ["qa", "architect"];

/** Solo pipeline: dev only, for trivial tasks (S44 T8) */
export const SOLO_PIPELINE: AgentRole[] = ["dev"];

/** Light pipeline: planner + dev + qa, for medium tasks (S44 T8) */
export const LIGHT_PIPELINE: AgentRole[] = ["planner", "dev", "qa"];

/** Research pipeline: explorer researches, then planner + dev + qa (S44 T9) */
export const RESEARCH_PIPELINE: AgentRole[] = ["explorer", "planner", "dev", "qa"];

// ── Keyword Arrays ───────────────────────────────────────────

/** Keywords that indicate a bug fix task */
const BUG_KEYWORDS = [
  "fix", "bug", "crash", "erreur", "error", "broken", "casse",
  "regression", "hotfix", "patch", "reparer", "corriger",
];

/** Keywords that indicate a review/QA task */
const REVIEW_KEYWORDS = [
  "review", "audit", "revue", "test", "qa", "qualite", "refactor",
  "nettoyage", "cleanup", "lint", "dette", "debt",
];

/** Keywords that indicate a documentation task */
const DOC_KEYWORDS = [
  "doc", "documentation", "readme", "changelog", "guide", "tutoriel",
];

/** Keywords that indicate a research task (S44 T9) */
const RESEARCH_KEYWORDS = [
  "research", "recherche", "investigate", "investiguer", "compare",
  "comparer", "evaluate", "evaluer", "benchmark", "etude", "study",
  "state of the art", "etat de l'art", "alternative", "comparatif",
  "explore options", "explorer les options",
];

// ── Types ────────────────────────────────────────────────────

export type PipelineType = "DEFAULT" | "QUICK" | "REVIEW" | "DOC" | "SOLO" | "LIGHT" | "RESEARCH";

// ── Pipeline Selection Functions ─────────────────────────────

/**
 * Analyze a task and select the most appropriate pipeline.
 *
 * Rules:
 *   - Bug/fix/patch/hotfix → QUICK (dev + qa)
 *   - Review/audit/refactor → REVIEW (qa + architect)
 *   - Documentation → QUICK (dev + qa)
 *   - Simple priority P3 with short title → QUICK
 *   - Everything else → DEFAULT (analyst + pm + architect + dev + qa)
 *   - Explicit override via options.pipeline always wins
 */
export function selectPipeline(
  task: Task,
  explicitPipeline?: AgentRole[]
): AgentRole[] {
  if (explicitPipeline) return explicitPipeline;

  const text = `${task.title} ${task.description || ""}`.toLowerCase();

  // S44 T9: Research tasks get explorer-led pipeline
  if (RESEARCH_KEYWORDS.some((kw) => text.includes(kw))) {
    return RESEARCH_PIPELINE;
  }

  if (BUG_KEYWORDS.some((kw) => text.includes(kw))) {
    return QUICK_PIPELINE;
  }

  if (REVIEW_KEYWORDS.some((kw) => text.includes(kw))) {
    return REVIEW_PIPELINE;
  }

  if (DOC_KEYWORDS.some((kw) => text.includes(kw))) {
    return QUICK_PIPELINE;
  }

  // Simple tasks: short title, low priority, no subtasks
  if (
    task.priority >= 3 &&
    task.title.length < 40 &&
    (!task.subtasks || task.subtasks.length === 0)
  ) {
    return QUICK_PIPELINE;
  }

  return DEFAULT_PIPELINE;
}

/**
 * Select pipeline based on difficulty score (S44 T8).
 * Uses computeDifficultyScore for adaptive selection.
 * Returns SOLO/LIGHT/DEFAULT based on difficulty analysis.
 */
export async function selectAdaptivePipeline(
  task: Task,
  explicitPipeline?: AgentRole[],
  supabase?: any,
): Promise<AgentRole[]> {
  if (explicitPipeline) return explicitPipeline;

  // Keyword-based rules still take priority for research/review patterns
  const text = `${task.title} ${task.description || ""}`.toLowerCase();
  if (RESEARCH_KEYWORDS.some((kw) => text.includes(kw))) {
    return RESEARCH_PIPELINE;
  }
  if (REVIEW_KEYWORDS.some((kw) => text.includes(kw))) {
    return REVIEW_PIPELINE;
  }

  const { computeDifficultyScore } = await import("./llm-router.ts");
  const difficulty = await computeDifficultyScore(task, supabase);

  switch (difficulty.pipeline) {
    case "SOLO":
      return SOLO_PIPELINE;
    case "LIGHT":
      return LIGHT_PIPELINE;
    default:
      return DEFAULT_PIPELINE;
  }
}

/**
 * Classify a task into a pipeline type (for logging/display).
 */
export function classifyPipeline(task: Task): PipelineType {
  const text = `${task.title} ${task.description || ""}`.toLowerCase();

  if (RESEARCH_KEYWORDS.some((kw) => text.includes(kw))) return "RESEARCH";
  if (BUG_KEYWORDS.some((kw) => text.includes(kw))) return "QUICK";
  if (REVIEW_KEYWORDS.some((kw) => text.includes(kw))) return "REVIEW";
  if (DOC_KEYWORDS.some((kw) => text.includes(kw))) return "DOC";
  if (
    task.priority >= 3 &&
    task.title.length < 40 &&
    (!task.subtasks || task.subtasks.length === 0)
  ) {
    return "QUICK";
  }
  return "DEFAULT";
}

/**
 * Classify a task using difficulty scoring (S44 T8).
 * Returns SOLO/LIGHT/DEFAULT based on computed difficulty.
 */
export async function classifyAdaptivePipeline(
  task: Task,
  supabase?: any,
): Promise<PipelineType> {
  const text = `${task.title} ${task.description || ""}`.toLowerCase();

  // Keyword rules still apply for research/review
  if (RESEARCH_KEYWORDS.some((kw) => text.includes(kw))) return "RESEARCH";
  if (REVIEW_KEYWORDS.some((kw) => text.includes(kw))) return "REVIEW";

  const { computeDifficultyScore } = await import("./llm-router.ts");
  const difficulty = await computeDifficultyScore(task, supabase);
  return difficulty.pipeline;
}
