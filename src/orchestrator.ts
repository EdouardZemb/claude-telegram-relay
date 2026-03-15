/**
 * Multi-Agent Orchestrator — S16-01 / S22
 *
 * Chains BMad agents in configurable sequences.
 * S22: Structured message passing (JSON schemas), retry loop,
 *      dynamic pipeline selection.
 *
 * Usage:
 *   const result = await orchestrate(supabase, task, {
 *     pipeline: ["analyst", "pm", "architect", "dev", "qa"],
 *     onProgress: async (msg) => ctx.reply(msg),
 *   });
 */

import { spawn } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "./tasks.ts";
import { buildStoryFile, enrichTaskWithStory } from "./story-files.ts";
import {
  buildFullAgentPrompt,
  buildIsolationInstructions,
  type AgentPromptContext,
} from "./bmad-prompts.ts";
import { getAgent, type BmadAgent } from "./bmad-agents.ts";
import { WorkflowTracker } from "./workflow.ts";
import { buildTaskContext } from "./document-sharding.ts";
import {
  type AgentMessage,
  type StructuredAgentOutput,
  parseAgentOutput,
  buildStructuredOutputInstructions,
  buildStructuredChainContext,
} from "./agent-schemas.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

// ── Types ────────────────────────────────────────────────────

export type AgentRole = "analyst" | "pm" | "architect" | "dev" | "qa" | "sm";

export interface AgentStepResult {
  agentId: AgentRole;
  agentName: string;
  success: boolean;
  output: string;
  structured: StructuredAgentOutput | null;
  error?: string;
  durationMs: number;
  retryCount?: number;
}

export interface OrchestratedResult {
  success: boolean;
  steps: AgentStepResult[];
  totalDurationMs: number;
  summary: string;
}

/** Maps agent roles to the workflow command they execute */
const AGENT_COMMAND_MAP: Record<AgentRole, string> = {
  analyst: "patterns",
  pm: "plan",
  architect: "architecture",
  dev: "exec",
  qa: "alerts",
  sm: "sprint",
};

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

// ── Core Orchestrator ────────────────────────────────────────

/**
 * Run a single agent step: build prompt, call Claude, return result.
 * S22: Uses structured output instructions and parses JSON from output.
 */
async function runAgentStep(
  agentId: AgentRole,
  task: Task,
  previousMessages: AgentMessage[],
  shardedContext?: string
): Promise<AgentStepResult> {
  const startTime = Date.now();
  const agent = getAgent(agentId);
  const agentName = agent?.name || agentId;

  const command = AGENT_COMMAND_MAP[agentId] || agentId;

  const context: AgentPromptContext = {
    command,
    taskTitle: task.title,
    taskDescription: task.description || undefined,
    priority: task.priority,
    acceptanceCriteria: task.acceptance_criteria || undefined,
    devNotes: task.dev_notes || undefined,
    architectureRef: task.architecture_ref || undefined,
    projectName: task.project,
    sprintId: task.sprint || undefined,
    subtasks: task.subtasks?.map((st: any) => ({
      title: st.title,
      done: st.done,
    })) || undefined,
    shardedContext: shardedContext || undefined,
  };

  // Build prompt
  let prompt = buildFullAgentPrompt(agentId, context);
  const isolation = buildIsolationInstructions(agentId);
  prompt = `${prompt}\n\n${isolation}`;

  // Add structured output instructions (S22-03)
  prompt += buildStructuredOutputInstructions(agentId);

  // Add structured chain context from previous agents (S22-01/02)
  if (previousMessages.length > 0) {
    prompt += `\n\n---\n\n${buildStructuredChainContext(previousMessages)}`;
  }

  // Specific instructions per role in orchestration
  prompt += getOrchestrationInstructions(agentId);

  try {
    const proc = spawn(
      [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"],
      { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR, env: { ...process.env } }
    );

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const rawOutput = output.trim();
    const success = exitCode === 0;

    // Parse structured output (S22-02)
    const structured = success ? parseAgentOutput(rawOutput, agentId) : null;

    return {
      agentId,
      agentName,
      success,
      output: rawOutput,
      structured,
      error: exitCode !== 0 ? stderr.trim() : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      agentId,
      agentName,
      success: false,
      output: "",
      structured: null,
      error: String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Get orchestration-specific instructions for each agent in a pipeline.
 */
function getOrchestrationInstructions(agentId: AgentRole): string {
  switch (agentId) {
    case "analyst":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (Analyst):",
        "- Analyse la faisabilite et les risques de la tache",
        "- Identifie les dependances et les points d'attention",
        "- Fournis un brief concis (max 500 mots) pour les agents suivants",
        "- Format: ANALYSE, RISQUES, RECOMMANDATIONS",
      ].join("\n");

    case "pm":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (PM):",
        "- Decompose la tache en sous-taches atomiques si necessaire",
        "- Definis les criteres d'acceptation precis",
        "- Priorise les sous-taches par dependance logique",
        "- Format: SOUS-TACHES (liste), CRITERES D'ACCEPTATION, PRIORITES",
      ].join("\n");

    case "architect":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (Architect):",
        "- Valide la faisabilite technique",
        "- Propose l'architecture / le design si necessaire",
        "- Identifie les fichiers a modifier et les patterns a suivre",
        "- Format: DESIGN, FICHIERS IMPACTES, PATTERNS, RISQUES TECHNIQUES",
      ].join("\n");

    case "dev":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (Dev):",
        "- Implemente selon les specs des agents precedents",
        "- Respecte l'architecture proposee",
        "- Ecris les tests pour chaque modification",
        "- Fais un resume des fichiers modifies a la fin",
      ].join("\n");

    case "qa":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (QA):",
        "- Review le travail du Dev agent",
        "- Verifie l'alignement avec les specs PM et l'architecture",
        "- Identifie les tests manquants",
        "- Score de qualite 0-100 et findings",
        "- Format JSON: {score, findings: [{severity, description, suggestion}], summary}",
      ].join("\n");

    case "sm":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (SM):",
        "- Synthetise le resultat global de l'orchestration",
        "- Identifie les points de suivi",
        "- Propose les prochaines etapes",
      ].join("\n");

    default:
      return "";
  }
}

/**
 * Persist agent output as a structured artifact on the task.
 * PM → acceptance_criteria, Architect → architecture_ref, QA → dev_notes append
 */
async function persistAgentArtifact(
  supabase: SupabaseClient,
  taskId: string,
  agentId: AgentRole,
  output: string
): Promise<void> {
  const updates: Record<string, any> = {};

  switch (agentId) {
    case "pm":
      // PM produces acceptance criteria and subtask decomposition
      updates.acceptance_criteria = output.substring(0, 10000);
      break;
    case "architect":
      // Architect produces technical design and file impact analysis
      updates.architecture_ref = output.substring(0, 10000);
      break;
    case "qa":
      // QA produces review findings — append to dev_notes
      updates.dev_notes_qa = output.substring(0, 5000);
      break;
    default:
      // Other agents: log only (already in workflow_logs)
      return;
  }

  if (agentId === "qa") {
    // Append QA review to existing dev_notes
    const { data: current } = await supabase
      .from("tasks")
      .select("dev_notes")
      .eq("id", taskId)
      .single();
    const existingNotes = current?.dev_notes || "";
    updates.dev_notes = existingNotes + "\n\n--- QA REVIEW ---\n" + output.substring(0, 5000);
    delete updates.dev_notes_qa;
  }

  const { error } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", taskId);
  if (error) console.error(`persistAgentArtifact(${agentId}) error:`, error);
}

// ── Main Orchestrate Function ────────────────────────────────

export interface OrchestrateOptions {
  pipeline?: AgentRole[];
  onProgress?: (message: string) => Promise<void>;
  /** Stop the pipeline if an agent fails */
  stopOnFailure?: boolean;
  /** Skip agents that aren't relevant (e.g., analyst for simple tasks) */
  skipIfSimple?: boolean;
  /** Max retry attempts per agent (default: 0 = no retry) */
  maxRetries?: number;
  /** Use dynamic pipeline selection based on task analysis (S22-06) */
  autoPipeline?: boolean;
}

/**
 * Orchestrate a task through a pipeline of BMad agents.
 *
 * Each agent receives structured outputs of all previous agents as context.
 * S22: Retry loop, structured message passing, dynamic pipeline selection.
 */
export async function orchestrate(
  supabase: SupabaseClient | null,
  task: Task,
  options: OrchestrateOptions = {}
): Promise<OrchestratedResult> {
  // Dynamic pipeline selection (S22-06)
  const pipeline = options.autoPipeline
    ? selectPipeline(task, options.pipeline)
    : (options.pipeline || DEFAULT_PIPELINE);
  const maxRetries = options.maxRetries ?? 0;
  const startTime = Date.now();
  const steps: AgentStepResult[] = [];
  const messages: AgentMessage[] = [];

  // Load sharded context for the task (PRD, architecture docs)
  let shardedContext: string | undefined;
  if (supabase && task.project_id) {
    try {
      shardedContext = await buildTaskContext(
        supabase,
        task.title,
        task.project_id,
        4000 // token budget
      );
    } catch {
      // Sharding not available, proceed without
    }
  }

  // Enrich task with story file before orchestration
  if (supabase) {
    const story = buildStoryFile(task);
    await enrichTaskWithStory(supabase, task.id, story);
    // Reload task with persisted story data
    const { data: refreshed } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task.id)
      .single();
    if (refreshed) {
      Object.assign(task, refreshed);
    }
  }

  // Log selected pipeline (S22-07)
  const pipelineLabel = options.autoPipeline ? "auto" : "manual";

  if (options.onProgress) {
    const agentNames = pipeline.map((id) => {
      const a = getAgent(id);
      return a ? `${a.icon} ${a.name}` : id;
    });
    await options.onProgress(
      `Orchestration demarree (${pipelineLabel}) : ${agentNames.join(" -> ")}`
    );
  }

  // Track workflow if supabase available
  let tracker: WorkflowTracker | undefined;
  if (supabase) {
    tracker = new WorkflowTracker(supabase, {
      taskId: task.id,
      sprintId: task.sprint || undefined,
    });
  }

  for (const agentId of pipeline) {
    const agent = getAgent(agentId);
    const agentLabel = agent
      ? `${agent.icon} ${agent.name} (${agent.title})`
      : agentId;

    if (options.onProgress) {
      await options.onProgress(`${agentLabel} en cours...`);
    }

    // Log workflow transition
    if (tracker) {
      const stepName = `orchestration_${agentId}`;
      await tracker.transition(stepName, {
        agent_notes: `Agent ${agentId} demarre dans le pipeline`,
      });
    }

    // S22-04: Retry loop with exponential backoff
    let result: AgentStepResult | null = null;
    let retryCount = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      result = await runAgentStep(agentId, task, messages, shardedContext);

      if (result.success) break;

      if (attempt < maxRetries) {
        retryCount = attempt + 1;
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
        if (options.onProgress) {
          await options.onProgress(
            `${agentLabel} echoue, retry ${retryCount}/${maxRetries} dans ${backoffMs / 1000}s...`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    // result is never null here because maxRetries >= 0 guarantees at least one iteration
    result!.retryCount = retryCount;
    steps.push(result!);

    // Build AgentMessage for downstream agents
    const message: AgentMessage = {
      agentId,
      agentName: result!.agentName,
      success: result!.success,
      structured: result!.structured,
      rawOutput: result!.output,
      durationMs: result!.durationMs,
      error: result!.error,
    };
    messages.push(message);

    // Persist agent artifacts to the task in Supabase
    if (result!.success && supabase) {
      await persistAgentArtifact(supabase, task.id, agentId, result!.output);
    }

    if (options.onProgress) {
      const status = result!.success ? "OK" : "ECHEC";
      const duration = Math.round(result!.durationMs / 1000);
      const retryInfo = retryCount > 0 ? ` (${retryCount} retries)` : "";
      await options.onProgress(
        `${agentLabel} : ${status} (${duration}s)${retryInfo}`
      );
    }

    // Log checkpoint (S22-05: include retry metrics)
    if (tracker) {
      await tracker.logCheckpoint(
        result!.success ? "pass" : "fail",
        `Agent ${agentId}: ${result!.success ? "succes" : "echec"} en ${result!.durationMs}ms` +
          (retryCount > 0 ? ` (${retryCount} retries)` : "")
      );
    }

    // Stop on failure if configured
    if (!result!.success && options.stopOnFailure) {
      if (options.onProgress) {
        await options.onProgress(
          `Pipeline arrete: ${agentLabel} a echoue.`
        );
      }
      break;
    }
  }

  const totalDurationMs = Date.now() - startTime;

  // Build summary
  const summary = buildOrchestrationSummary(steps, totalDurationMs);

  // Log orchestration result to Supabase (S22-05/07: include retry metrics + pipeline selection)
  if (supabase) {
    await logOrchestrationResult(supabase, task.id, steps, totalDurationMs, pipelineLabel);
  }

  return {
    success: steps.every((s) => s.success),
    steps,
    totalDurationMs,
    summary,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function buildOrchestrationSummary(
  steps: AgentStepResult[],
  totalDurationMs: number
): string {
  const lines: string[] = [];
  lines.push("ORCHESTRATION TERMINEE");
  lines.push(`Duree totale: ${Math.round(totalDurationMs / 1000)}s`);
  lines.push(`Agents: ${steps.length}`);
  lines.push(`Succes: ${steps.filter((s) => s.success).length}/${steps.length}`);

  const totalRetries = steps.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  if (totalRetries > 0) {
    lines.push(`Retries: ${totalRetries}`);
  }

  const structuredCount = steps.filter((s) => s.structured).length;
  if (structuredCount > 0) {
    lines.push(`Sorties structurees: ${structuredCount}/${steps.length}`);
  }
  lines.push("");

  for (const step of steps) {
    const status = step.success ? "OK" : "ECHEC";
    const duration = Math.round(step.durationMs / 1000);
    const retryInfo = step.retryCount ? ` [${step.retryCount} retries]` : "";
    lines.push(`${step.agentName} (${step.agentId}): ${status} — ${duration}s${retryInfo}`);

    // Add a brief excerpt of the output (first 200 chars)
    if (step.output) {
      const excerpt = step.output.substring(0, 200).replace(/\n/g, " ");
      lines.push(`  ${excerpt}${step.output.length > 200 ? "..." : ""}`);
    }
    if (step.error) {
      lines.push(`  ERREUR: ${step.error.substring(0, 150)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

async function logOrchestrationResult(
  supabase: SupabaseClient,
  taskId: string,
  steps: AgentStepResult[],
  totalDurationMs: number,
  pipelineSelection?: string
): Promise<void> {
  const totalRetries = steps.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  const { error } = await supabase.from("workflow_logs").insert({
    task_id: taskId,
    step: "orchestration",
    from_step: "orchestration_start",
    to_step: "orchestration_end",
    metadata: {
      pipeline: steps.map((s) => s.agentId),
      pipelineSelection: pipelineSelection || "manual",
      results: steps.map((s) => ({
        agent: s.agentId,
        success: s.success,
        durationMs: s.durationMs,
        outputLength: s.output.length,
        hasStructuredOutput: s.structured !== null,
        retryCount: s.retryCount || 0,
      })),
      totalDurationMs,
      totalRetries,
      allPassed: steps.every((s) => s.success),
    },
  });
  if (error) console.error("logOrchestrationResult error:", error);
}

// ── Dynamic Pipeline Selection (S22-06) ──────────────────────

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

export type PipelineType = "DEFAULT" | "QUICK" | "REVIEW" | "DOC";

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
 * Classify a task into a pipeline type (for logging/display).
 */
export function classifyPipeline(task: Task): PipelineType {
  const text = `${task.title} ${task.description || ""}`.toLowerCase();

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

// ── Format for Telegram ──────────────────────────────────────

export function formatOrchestrationResult(result: OrchestratedResult): string {
  const lines: string[] = [];

  const statusIcon = result.success ? "OK" : "ATTENTION";
  lines.push(`ORCHESTRATION ${statusIcon}`);
  lines.push(`Duree: ${Math.round(result.totalDurationMs / 1000)}s`);

  const totalRetries = result.steps.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  if (totalRetries > 0) {
    lines.push(`Retries: ${totalRetries}`);
  }
  lines.push("");

  for (const step of result.steps) {
    const agent = getAgent(step.agentId);
    const icon = agent?.icon || "";
    const status = step.success ? "ok" : "echec";
    const duration = Math.round(step.durationMs / 1000);
    const structuredTag = step.structured ? " [JSON]" : "";
    const retryTag = step.retryCount ? ` (${step.retryCount} retries)` : "";
    lines.push(`${icon} ${step.agentName} : ${status} (${duration}s)${structuredTag}${retryTag}`);
  }

  // Add last agent's output as the main result
  const lastSuccessful = [...result.steps].reverse().find((s) => s.success);
  if (lastSuccessful && lastSuccessful.output) {
    lines.push("");
    lines.push("--- Resultat ---");
    // Trim to reasonable Telegram length
    const maxLen = 3000;
    const output = lastSuccessful.output;
    lines.push(output.length > maxLen ? output.substring(0, maxLen) + "..." : output);
  }

  return lines.join("\n");
}
