/**
 * @module exploration-scoring
 * @description Exploration phase scoring: determines whether a task needs
 * an exploration/research step before decomposition. Combines code-graph
 * complexity, research keyword detection, and absence of similar past tasks.
 * PRD: Phase Exploration dans le Workflow de Dev.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { type CodeGraph, estimateComplexity, findAffectedModules, getGraph } from "./code-graph.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import { findSimilarPastTasks } from "./memory.ts";
import type { Task } from "./tasks.ts";

// ── Constants ───────────────────────────────────────────────

const EXPLORATION_THRESHOLD = 0.5;
const RESEARCH_FORCE_THRESHOLD = 0.7;

/** Pipelines that skip exploration automatically */
const SKIP_PIPELINES = ["SOLO", "QUICK"];

/** Keywords suggesting the task needs research/exploration */
const EXPLORATION_KEYWORDS = [
  // English
  "research",
  "investigate",
  "explore",
  "compare",
  "evaluate",
  "benchmark",
  "study",
  "analyze",
  "alternative",
  "approach",
  "architecture",
  "design pattern",
  "best practice",
  "trade-off",
  "tradeoff",
  "proof of concept",
  "poc",
  "spike",
  "prototype",
  "feasibility",
  "migration strategy",
  "technology choice",
  // French
  "recherche",
  "investiguer",
  "explorer",
  "comparer",
  "evaluer",
  "etude",
  "analyser",
  "alternative",
  "approche",
  "patron",
  "bonne pratique",
  "compromis",
  "preuve de concept",
  "faisabilite",
  "strategie de migration",
  "choix technologique",
  "etat de l'art",
  "state of the art",
];

// ── Types ────────────────────────────────────────────────────

export interface ExplorationScore {
  /** Overall exploration need score 0-1 */
  score: number;
  /** Individual component scores (-1 = unavailable) */
  components: {
    graphComplexity: number;
    keywordSignal: number;
    noSimilarTasks: number;
  };
  /** Whether exploration should be triggered */
  shouldExplore: boolean;
  /** Whether score is high enough to force RESEARCH pipeline */
  forceResearch: boolean;
  /** Modules detected in task text */
  affectedModules: string[];
  /** Number of similar past tasks found */
  similarTaskCount: number;
}

export interface ExploreOptions {
  /** Explicit --explore flag (overrides scoring) */
  explore?: boolean;
  /** Pipeline type (SOLO/QUICK skip exploration) */
  pipeline?: string;
}

// ── Scoring Functions ────────────────────────────────────────

/**
 * Compute keyword signal score from task text.
 * Returns 0-1 based on how many exploration keywords match.
 */
export function computeKeywordScore(taskText: string): number {
  const text = taskText.toLowerCase();
  const matches = EXPLORATION_KEYWORDS.filter((kw) => text.includes(kw));

  if (matches.length === 0) return 0;
  if (matches.length === 1) return 0.4;
  if (matches.length === 2) return 0.65;
  if (matches.length === 3) return 0.8;
  return Math.min(0.8 + matches.length * 0.05, 1.0);
}

/**
 * Compute graph complexity score for exploration.
 * Reuses code-graph analysis. Returns -1 if graph unavailable.
 */
export function computeGraphComplexityScore(
  graph: CodeGraph,
  taskText: string,
): { score: number; modules: string[] } {
  const affected = findAffectedModules(graph, taskText);

  if (affected.length === 0) {
    return { score: 0.3, modules: [] };
  }

  const complexities = affected.map((m) => estimateComplexity(graph, m));
  const maxComplexity = Math.max(...complexities);

  // Normalize: complexity 0-10 to 0-1, boosted by module count
  const baseScore = maxComplexity / 10;
  const moduleBoost = Math.min(affected.length / 5, 0.3);
  const score = Math.min(baseScore + moduleBoost, 1.0);

  return {
    score: Math.round(score * 100) / 100,
    modules: affected,
  };
}

/**
 * Compute "no similar tasks" score.
 * High score = no similar past tasks found = more need for exploration.
 * Returns -1 if database unavailable.
 */
export function computeNoSimilarTasksScore(similarTaskCount: number): number {
  if (similarTaskCount === 0) return 1.0;
  if (similarTaskCount === 1) return 0.7;
  if (similarTaskCount === 2) return 0.4;
  if (similarTaskCount === 3) return 0.2;
  return 0.1;
}

// ── Main Scoring ─────────────────────────────────────────────

/**
 * Compute the exploration score for a task.
 * Combines 3 signals with weighted average:
 * - Code-graph complexity (40%)
 * - Research keywords (30%)
 * - Absence of similar past tasks (30%)
 *
 * Threshold: >= 0.5 triggers exploration.
 * Score >= 0.7 forces RESEARCH pipeline.
 */
export async function computeExplorationScore(
  task: Task,
  supabase?: SupabaseClient | null,
): Promise<ExplorationScore> {
  const taskText = `${task.title} ${task.description || ""}`;

  // Component 1: Graph complexity (40%)
  let graphScore = -1;
  let affectedModules: string[] = [];
  try {
    const graph = getGraph();
    const result = computeGraphComplexityScore(graph, taskText);
    graphScore = result.score;
    affectedModules = result.modules;
  } catch {
    // Graph unavailable
  }

  // Component 2: Keyword signal (30%) — always available
  const keywordScore = computeKeywordScore(taskText);

  // Component 3: Absence of similar past tasks (30%)
  let noSimilarScore = -1;
  let similarCount = 0;
  try {
    const similar = await findSimilarPastTasks(supabase || null, task.title, 5);
    similarCount = similar.length;
    noSimilarScore = computeNoSimilarTasksScore(similarCount);
  } catch {
    // Database unavailable
  }

  // Dynamic weighting: only available components contribute
  const GRAPH_WEIGHT = 0.4;
  const KEYWORD_WEIGHT = 0.3;
  const SIMILAR_WEIGHT = 0.3;

  let totalWeight = KEYWORD_WEIGHT;
  let weightedSum = keywordScore * KEYWORD_WEIGHT;

  if (graphScore >= 0) {
    totalWeight += GRAPH_WEIGHT;
    weightedSum += graphScore * GRAPH_WEIGHT;
  }

  if (noSimilarScore >= 0) {
    totalWeight += SIMILAR_WEIGHT;
    weightedSum += noSimilarScore * SIMILAR_WEIGHT;
  }

  const rawScore = weightedSum / totalWeight;
  const score = Math.round(Math.max(0, Math.min(1, rawScore)) * 100) / 100;

  return {
    score,
    components: {
      graphComplexity: graphScore,
      keywordSignal: keywordScore,
      noSimilarTasks: noSimilarScore,
    },
    shouldExplore: score >= EXPLORATION_THRESHOLD,
    forceResearch: score >= RESEARCH_FORCE_THRESHOLD,
    affectedModules,
    similarTaskCount: similarCount,
  };
}

// ── Decision Function ────────────────────────────────────────

/**
 * Determine whether a task should go through the exploration phase.
 *
 * Decision logic:
 * 1. Feature flag `exploration_phase` must be enabled
 * 2. Explicit --explore overrides scoring (--no-explore skips)
 * 3. SOLO and QUICK pipelines always skip
 * 4. Otherwise, compute score and check threshold (>= 0.5)
 */
export async function shouldExplore(
  task: Task,
  options: ExploreOptions = {},
  supabase?: SupabaseClient | null,
): Promise<{ explore: boolean; score: ExplorationScore | null; reason: string }> {
  // Check feature flag
  if (!isFeatureEnabled("exploration_phase")) {
    return { explore: false, score: null, reason: "Feature flag exploration_phase desactivee" };
  }

  // Explicit override
  if (options.explore === true) {
    return { explore: true, score: null, reason: "Option --explore explicite" };
  }
  if (options.explore === false) {
    return { explore: false, score: null, reason: "Option --no-explore explicite" };
  }

  // Auto-skip for simple pipelines
  if (options.pipeline && SKIP_PIPELINES.includes(options.pipeline)) {
    return {
      explore: false,
      score: null,
      reason: `Pipeline ${options.pipeline} : exploration non necessaire`,
    };
  }

  // Compute score
  const score = await computeExplorationScore(task, supabase);

  if (score.shouldExplore) {
    const reason = score.forceResearch
      ? `Score ${score.score} >= 0.7 : exploration fortement recommandee (RESEARCH)`
      : `Score ${score.score} >= 0.5 : exploration recommandee`;
    return { explore: true, score, reason };
  }

  return {
    explore: false,
    score,
    reason: `Score ${score.score} < 0.5 : exploration non necessaire`,
  };
}
