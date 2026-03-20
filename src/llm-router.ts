/**
 * @module llm-router
 * @description LLM-based router for dynamic pipeline selection. Replaces keyword matching
 * with a Haiku call that analyzes the task and returns pipeline + model overrides + budget.
 * S34 FR-004. S44 T7: difficulty scorer for adaptive pipeline selection.
 */

import type { Task } from "./tasks.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { spawnClaude } from "./agent.ts";
import type { AgentRole } from "./orchestrator.ts";
import {
  getGraph,
  estimateComplexity,
  findAffectedModules,
  type CodeGraph,
} from "./code-graph.ts";
import { findSimilarPastTasks, type SimilarTask } from "./memory.ts";
import { computeExplorationScore } from "./exploration-scoring.ts";
import { isFeatureEnabled } from "./feature-flags.ts";

const ROUTER_TIMEOUT = 5_000; // 5s (AC-018)

// ── Types ────────────────────────────────────────────────────

export interface RouterDecision {
  pipeline: "DEFAULT" | "QUICK" | "REVIEW" | "SOLO" | "LIGHT" | "RESEARCH";
  models: Partial<Record<AgentRole, string>>;
  budget: number;
  reasoning: string;
}

// ── Router Prompt ────────────────────────────────────────────

const ROUTER_PROMPT_TEMPLATE = `You are a pipeline router for a software development system.
Analyze the task below and decide the best execution strategy.

AVAILABLE PIPELINES:
- DEFAULT: analyst -> pm -> architect -> dev -> qa (full analysis, for complex features)
- LIGHT: planner -> dev -> qa (planner combines analyst+pm, for medium-complexity tasks)
- QUICK: dev -> qa (for bug fixes, docs, simple tasks, patches)
- SOLO: dev (single agent, for trivial changes like typos, labels, config tweaks)
- RESEARCH: explorer -> planner -> dev -> qa (for tasks requiring web research, API evaluation, technology comparison)
- REVIEW: qa -> architect (for audits, refactoring, code reviews)

AVAILABLE MODELS (cheapest to most expensive):
- claude-haiku-4-5: Fast, cheap, good for simple tasks ($0.80/$4 per 1M tokens)
- claude-sonnet-4-6: Balanced, good for most tasks ($3/$15 per 1M tokens)
- claude-opus-4-6: Most capable, for complex architecture/code ($15/$75 per 1M tokens)

TASK:
Title: {title}
Description: {description}
Priority: P{priority}
{complexity_hint}
Return ONLY a JSON object:
{
  "pipeline": "DEFAULT" | "LIGHT" | "QUICK" | "SOLO" | "REVIEW" | "RESEARCH",
  "models": {
    "analyst": "model-id",
    "pm": "model-id",
    "architect": "model-id",
    "dev": "model-id",
    "qa": "model-id"
  },
  "budget": total_budget_usd_number,
  "reasoning": "1-2 sentence explanation"
}

Only include models for agents in the selected pipeline.
No other text. Only valid JSON.`;

// ── Router ───────────────────────────────────────────────────

/**
 * Route a task using LLM analysis.
 * AC-016: Haiku analyzes task and returns pipeline + model overrides + budget.
 * AC-018: Falls back on failure or timeout (5s).
 * AC-020: Logs reasoning and cost.
 */
export async function routeTask(task: Task): Promise<RouterDecision | null> {
  // S39: Add complexity hint from code graph
  let complexityHint = "";
  try {
    const graph = getGraph();
    const taskText = `${task.title} ${task.description || ""}`;
    const affected = findAffectedModules(graph, taskText);
    if (affected.length > 0) {
      const scores = affected.map((m) => estimateComplexity(graph, m));
      const maxScore = Math.max(...scores);
      complexityHint = `Code complexity: ${maxScore.toFixed(1)}/10 (${affected.length} module(s) affected: ${affected.map((a) => a.replace("src/", "")).join(", ")})`;
    }
  } catch {
    // Best-effort
  }

  // Exploration score hint for RESEARCH recommendation
  let explorationHint = "";
  if (isFeatureEnabled("exploration_phase")) {
    try {
      const explorationResult = await computeExplorationScore(task);
      if (explorationResult.score >= 0.5) {
        explorationHint = `Exploration score: ${explorationResult.score} (>= 0.5 suggests RESEARCH pipeline). Keywords: ${explorationResult.components.keywordSignal > 0 ? "yes" : "no"}, graph complexity: ${explorationResult.components.graphComplexity >= 0 ? explorationResult.components.graphComplexity.toFixed(2) : "N/A"}`;
      }
    } catch {
      // Best-effort
    }
  }

  const fullHint = [complexityHint, explorationHint].filter(Boolean).join("\n");

  const prompt = ROUTER_PROMPT_TEMPLATE
    .replace("{title}", task.title)
    .replace("{description}", task.description || "No description")
    .replace("{priority}", String(task.priority || 3))
    .replace("{complexity_hint}", fullHint ? `Complexity: ${fullHint}` : "");

  try {
    const resultPromise = spawnClaude({
      prompt,
      model: "claude-haiku-4-5",
      effort: "low",
      // Budget limits removed
    });

    // AC-018: 5s timeout
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ROUTER_TIMEOUT);
    });

    const result = await Promise.race([resultPromise, timeoutPromise]);

    if (!result) {
      console.warn("llm-router: timeout (5s), falling back to keyword matching");
      return null;
    }

    if (result.exitCode !== 0) {
      console.warn("llm-router: spawn failed, falling back to keyword matching");
      return null;
    }

    // AC-017: Parse structured JSON response
    const decision = parseRouterResponse(result.stdout);
    if (decision) {
      // AC-020: Log reasoning
      console.log(`llm-router: ${decision.pipeline} pipeline, budget=$${decision.budget}, reason=${decision.reasoning}`);
    }
    return decision;
  } catch (error) {
    console.warn("llm-router: error, falling back to keyword matching:", error);
    return null;
  }
}

/**
 * Parse the router's JSON response.
 * EC-002: Returns null on invalid JSON (triggers fallback).
 */
export function parseRouterResponse(output: string): RouterDecision | null {
  // Try direct parse
  try {
    const parsed = JSON.parse(output);
    return normalizeDecision(parsed);
  } catch {
    // Try extracting JSON from output
  }

  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeDecision(parsed);
    } catch {
      // Fall through
    }
  }

  return null;
}

function normalizeDecision(obj: any): RouterDecision | null {
  const validPipelines = ["DEFAULT", "QUICK", "REVIEW", "SOLO", "LIGHT", "RESEARCH"];
  const pipeline = validPipelines.includes(obj.pipeline) ? obj.pipeline : null;
  if (!pipeline) return null;

  // EC-005: Validate model names, fallback unknown models to Sonnet
  const validModels = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
  const models: Partial<Record<AgentRole, string>> = {};
  if (obj.models && typeof obj.models === "object") {
    const validRoles: AgentRole[] = ["analyst", "pm", "architect", "dev", "qa", "sm", "planner", "explorer"];
    for (const role of validRoles) {
      if (obj.models[role]) {
        models[role] = validModels.includes(obj.models[role])
          ? obj.models[role]
          : "claude-sonnet-4-6"; // EC-005: fallback
      }
    }
  }

  const budget = typeof obj.budget === "number" ? Math.max(0, obj.budget) : 5.0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";

  return { pipeline, models, budget, reasoning };
}

/**
 * Map a RouterDecision pipeline type to an AgentRole array.
 */
export function routerPipelineToRoles(decision: RouterDecision): AgentRole[] {
  switch (decision.pipeline) {
    case "SOLO":
      return ["dev"];
    case "LIGHT":
      return ["planner", "dev", "qa"];
    case "RESEARCH":
      return ["explorer", "planner", "dev", "qa"];
    case "QUICK":
      return ["dev", "qa"];
    case "REVIEW":
      return ["qa", "architect"];
    case "DEFAULT":
    default:
      return ["analyst", "pm", "architect", "dev", "qa"];
  }
}

// ── Difficulty Scorer (S44 T7 — AC-006) ──────────────────────

/** Keywords suggesting low difficulty */
const SIMPLE_KEYWORDS = [
  "typo", "rename", "update text", "fix text", "label", "message",
  "comment", "readme", "changelog", "log ", "string", "wording",
  "version", "bump", "icon", "color", "spacing", "margin", "css",
];

/** Keywords suggesting high difficulty */
const COMPLEX_KEYWORDS = [
  "architect", "refactor", "migration", "multi", "pipeline",
  "parallel", "concurrent", "security", "auth", "database",
  "schema", "performance", "optimi", "algorithm", "framework",
  "engine", "protocol", "orchestrat", "workflow", "integration",
];

/** Result of difficulty scoring */
export interface DifficultyScore {
  /** Overall difficulty 0-1 */
  score: number;
  /** Individual component scores (-1 = unavailable) */
  components: {
    graphComplexity: number;
    descriptionAnalysis: number;
    historicalEffort: number;
  };
  /** Modules detected in task text */
  affectedModules: string[];
  /** Number of similar past tasks found */
  similarTaskCount: number;
  /** Recommended pipeline based on score */
  pipeline: "SOLO" | "LIGHT" | "DEFAULT";
}

/**
 * Analyze task description to estimate difficulty.
 * Pure function, no external dependencies.
 */
export function analyzeDescription(
  taskText: string,
  subtaskCount: number = 0,
): number {
  const text = taskText.toLowerCase();
  const textLength = text.length;

  // Base score from text length
  let score: number;
  if (textLength < 30) score = 0.15;
  else if (textLength < 60) score = 0.25;
  else if (textLength < 120) score = 0.45;
  else if (textLength < 250) score = 0.65;
  else score = 0.8;

  // Keyword adjustments
  const simpleMatches = SIMPLE_KEYWORDS.filter((kw) => text.includes(kw)).length;
  const complexMatches = COMPLEX_KEYWORDS.filter((kw) => text.includes(kw)).length;

  score += complexMatches * 0.08;
  score -= simpleMatches * 0.08;

  // Subtask influence
  if (subtaskCount > 3) score += 0.15;
  else if (subtaskCount > 0) score += 0.05;

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

/**
 * Compute graph-based complexity score from a CodeGraph.
 * Pure function for testability.
 */
export function computeGraphScoreFromGraph(
  graph: CodeGraph,
  taskText: string,
): { score: number; modules: string[] } {
  const affected = findAffectedModules(graph, taskText);

  if (affected.length === 0) {
    return { score: 0.3, modules: [] };
  }

  const complexities = affected.map((m) => estimateComplexity(graph, m));
  const maxComplexity = Math.max(...complexities);

  // Normalize: max complexity (0-10) to 0-1, boosted by module count
  const baseScore = maxComplexity / 10;
  const moduleBoost = Math.min(affected.length / 5, 0.3);
  const score = Math.min(baseScore + moduleBoost, 1.0);

  return {
    score: Math.round(score * 100) / 100,
    modules: affected,
  };
}

/**
 * Compute historical effort score from similar past tasks.
 * Returns -1 if no usable data.
 */
export function computeHistoricalScore(similarTasks: SimilarTask[]): number {
  if (!similarTasks || similarTasks.length === 0) return -1;

  const withActual = similarTasks.filter(
    (t) => t.actualHours != null && t.actualHours > 0,
  );
  if (withActual.length === 0) return -1;

  const avgHours =
    withActual.reduce((sum, t) => sum + (t.actualHours || 0), 0) /
    withActual.length;

  // Map hours to 0-1: 0.5h→0.03, 2h→0.11, 4h→0.22, 8h→0.44, 16h→0.89
  let score = Math.min(avgHours / 18, 1.0);

  // Boost if tasks were systematically underestimated
  const withBoth = withActual.filter(
    (t) => t.estimatedHours != null && t.estimatedHours > 0,
  );
  if (withBoth.length > 0) {
    const avgRatio =
      withBoth.reduce(
        (sum, t) => sum + (t.actualHours || 0) / (t.estimatedHours || 1),
        0,
      ) / withBoth.length;
    if (avgRatio > 1.5) score = Math.min(score + 0.1, 1.0);
  }

  return Math.round(score * 100) / 100;
}

/**
 * Map a difficulty score to a pipeline type.
 * AC-007: < 0.3 → SOLO
 * AC-008: 0.3-0.6 → LIGHT
 * AC-009: > 0.6 → DEFAULT
 */
export function scoreToPipeline(
  score: number,
): "SOLO" | "LIGHT" | "DEFAULT" {
  if (score < 0.3) return "SOLO";
  if (score <= 0.6) return "LIGHT";
  return "DEFAULT";
}

/**
 * Compute difficulty score for a task.
 * AC-006: Combines code graph complexity, description analysis, and historical effort.
 * EC-003: Falls back gracefully when graph or history unavailable.
 *
 * Dynamic weighting: only components with actual data contribute.
 * When all 3 available: graph 40%, description 30%, history 30%.
 * Missing components are excluded and weights re-normalized.
 */
export async function computeDifficultyScore(
  task: Task,
  supabase?: SupabaseClient | null,
): Promise<DifficultyScore> {
  const taskText = `${task.title} ${task.description || ""}`;

  // Component 1: Graph complexity
  let graphScore = -1;
  let affectedModules: string[] = [];

  try {
    const graph = getGraph();
    const result = computeGraphScoreFromGraph(graph, taskText);
    graphScore = result.score;
    affectedModules = result.modules;
  } catch {
    // EC-003: graph unavailable
  }

  // Component 2: Description analysis (always available)
  const descScore = analyzeDescription(taskText, task.subtasks?.length || 0);

  // Component 3: Historical effort
  let histScore = -1;
  let similarCount = 0;

  try {
    const similar = await findSimilarPastTasks(supabase || null, task.title, 5);
    similarCount = similar.length;
    histScore = computeHistoricalScore(similar);
  } catch {
    // EC-003: history unavailable
  }

  // Dynamic weighting: only enabled components contribute
  const GRAPH_WEIGHT = 0.4;
  const DESC_WEIGHT = 0.3;
  const HIST_WEIGHT = 0.3;

  let totalWeight = DESC_WEIGHT;
  let weightedSum = descScore * DESC_WEIGHT;

  if (graphScore >= 0) {
    totalWeight += GRAPH_WEIGHT;
    weightedSum += graphScore * GRAPH_WEIGHT;
  }

  if (histScore >= 0) {
    totalWeight += HIST_WEIGHT;
    weightedSum += histScore * HIST_WEIGHT;
  }

  const rawScore = weightedSum / totalWeight;
  const score = Math.round(Math.max(0, Math.min(1, rawScore)) * 100) / 100;

  return {
    score,
    components: {
      graphComplexity: graphScore,
      descriptionAnalysis: descScore,
      historicalEffort: histScore,
    },
    affectedModules,
    similarTaskCount: similarCount,
    pipeline: scoreToPipeline(score),
  };
}
