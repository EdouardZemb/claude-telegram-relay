/**
 * @module llm-router
 * @description LLM-based router for dynamic pipeline selection. Replaces keyword matching
 * with a Haiku call that analyzes the task and returns pipeline + model overrides + budget.
 * S34 FR-004.
 */

import type { Task } from "./tasks.ts";
import { spawnClaude } from "./agent.ts";
import type { AgentRole } from "./orchestrator.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import { getGraph, estimateComplexity, findAffectedModules } from "./code-graph.ts";

const ROUTER_TIMEOUT = 5_000; // 5s (AC-018)

// ── Types ────────────────────────────────────────────────────

export interface RouterDecision {
  pipeline: "DEFAULT" | "QUICK" | "REVIEW";
  models: Partial<Record<AgentRole, string>>;
  budget: number;
  reasoning: string;
}

// ── Router Prompt ────────────────────────────────────────────

const ROUTER_PROMPT_TEMPLATE = `You are a pipeline router for a software development system.
Analyze the task below and decide the best execution strategy.

AVAILABLE PIPELINES:
- DEFAULT: analyst -> pm -> architect -> dev -> qa (full analysis, for complex features)
- QUICK: dev -> qa (for bug fixes, docs, simple tasks, patches)
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
  "pipeline": "DEFAULT" | "QUICK" | "REVIEW",
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
  if (isFeatureEnabled("code_graph")) {
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
  }

  const prompt = ROUTER_PROMPT_TEMPLATE
    .replace("{title}", task.title)
    .replace("{description}", task.description || "No description")
    .replace("{priority}", String(task.priority || 3))
    .replace("{complexity_hint}", complexityHint ? `Complexity: ${complexityHint}` : "");

  try {
    const resultPromise = spawnClaude({
      prompt,
      model: "claude-haiku-4-5",
      effort: "low",
      maxBudgetUsd: 0.02,
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
  const validPipelines = ["DEFAULT", "QUICK", "REVIEW"];
  const pipeline = validPipelines.includes(obj.pipeline) ? obj.pipeline : null;
  if (!pipeline) return null;

  // EC-005: Validate model names, fallback unknown models to Sonnet
  const validModels = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
  const models: Partial<Record<AgentRole, string>> = {};
  if (obj.models && typeof obj.models === "object") {
    const validRoles: AgentRole[] = ["analyst", "pm", "architect", "dev", "qa", "sm"];
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
    case "QUICK":
      return ["dev", "qa"];
    case "REVIEW":
      return ["qa", "architect"];
    case "DEFAULT":
    default:
      return ["analyst", "pm", "architect", "dev", "qa"];
  }
}
