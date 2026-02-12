/**
 * Multi-Agent Orchestrator — S16-01
 *
 * Chains BMad agents in configurable sequences.
 * Supports sequential pipelines, parallel reviews, and feedback loops.
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
import {
  buildFullAgentPrompt,
  buildIsolationInstructions,
  type AgentPromptContext,
} from "./bmad-prompts.ts";
import { getAgent, type BmadAgent } from "./bmad-agents.ts";
import { WorkflowTracker } from "./workflow.ts";
import { buildTaskContext } from "./document-sharding.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

// ── Types ────────────────────────────────────────────────────

export type AgentRole = "analyst" | "pm" | "architect" | "dev" | "qa" | "sm";

export interface AgentStepResult {
  agentId: AgentRole;
  agentName: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
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
 */
async function runAgentStep(
  agentId: AgentRole,
  task: Task,
  previousOutputs: AgentStepResult[],
  shardedContext?: string
): Promise<AgentStepResult> {
  const startTime = Date.now();
  const agent = getAgent(agentId);
  const agentName = agent?.name || agentId;

  // Build context from previous agent outputs
  const chainContext = previousOutputs.length > 0
    ? previousOutputs.map((r) =>
        `--- ${r.agentName} (${r.agentId}) ---\n${r.output}`
      ).join("\n\n")
    : undefined;

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

  // Add chain context from previous agents
  if (chainContext) {
    prompt += `\n\n---\n\nCONTEXTE DES AGENTS PRECEDENTS:\n${chainContext}`;
    prompt += "\n\nUtilise ces outputs comme base. Ne repete pas ce qui a deja ete fait.";
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

    return {
      agentId,
      agentName,
      success: exitCode === 0,
      output: output.trim(),
      error: exitCode !== 0 ? stderr.trim() : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      agentId,
      agentName,
      success: false,
      output: "",
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

// ── Main Orchestrate Function ────────────────────────────────

export interface OrchestrateOptions {
  pipeline?: AgentRole[];
  onProgress?: (message: string) => Promise<void>;
  /** Stop the pipeline if an agent fails */
  stopOnFailure?: boolean;
  /** Skip agents that aren't relevant (e.g., analyst for simple tasks) */
  skipIfSimple?: boolean;
}

/**
 * Orchestrate a task through a pipeline of BMad agents.
 *
 * Each agent receives the outputs of all previous agents as context.
 * The pipeline stops early if a critical agent fails and stopOnFailure is true.
 */
export async function orchestrate(
  supabase: SupabaseClient | null,
  task: Task,
  options: OrchestrateOptions = {}
): Promise<OrchestratedResult> {
  const pipeline = options.pipeline || DEFAULT_PIPELINE;
  const startTime = Date.now();
  const steps: AgentStepResult[] = [];

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

  if (options.onProgress) {
    const agentNames = pipeline.map((id) => {
      const a = getAgent(id);
      return a ? `${a.icon} ${a.name}` : id;
    });
    await options.onProgress(
      `Orchestration demarree : ${agentNames.join(" -> ")}`
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

    const result = await runAgentStep(agentId, task, steps, shardedContext);
    steps.push(result);

    if (options.onProgress) {
      const status = result.success ? "OK" : "ECHEC";
      const duration = Math.round(result.durationMs / 1000);
      await options.onProgress(
        `${agentLabel} : ${status} (${duration}s)`
      );
    }

    // Log checkpoint
    if (tracker) {
      await tracker.logCheckpoint(
        result.success ? "pass" : "fail",
        `Agent ${agentId}: ${result.success ? "succes" : "echec"} en ${result.durationMs}ms`
      );
    }

    // Stop on failure if configured
    if (!result.success && options.stopOnFailure) {
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

  // Log orchestration result to Supabase
  if (supabase) {
    await logOrchestrationResult(supabase, task.id, steps, totalDurationMs);
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
  lines.push("");

  for (const step of steps) {
    const status = step.success ? "OK" : "ECHEC";
    const duration = Math.round(step.durationMs / 1000);
    lines.push(`${step.agentName} (${step.agentId}): ${status} — ${duration}s`);

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
  totalDurationMs: number
): Promise<void> {
  const { error } = await supabase.from("workflow_logs").insert({
    task_id: taskId,
    step: "orchestration",
    from_step: "orchestration_start",
    to_step: "orchestration_end",
    metadata: {
      pipeline: steps.map((s) => s.agentId),
      results: steps.map((s) => ({
        agent: s.agentId,
        success: s.success,
        durationMs: s.durationMs,
        outputLength: s.output.length,
      })),
      totalDurationMs,
      allPassed: steps.every((s) => s.success),
    },
  });
  if (error) console.error("logOrchestrationResult error:", error);
}

// ── Format for Telegram ──────────────────────────────────────

export function formatOrchestrationResult(result: OrchestratedResult): string {
  const lines: string[] = [];

  const statusIcon = result.success ? "OK" : "ATTENTION";
  lines.push(`ORCHESTRATION ${statusIcon}`);
  lines.push(`Duree: ${Math.round(result.totalDurationMs / 1000)}s`);
  lines.push("");

  for (const step of result.steps) {
    const agent = getAgent(step.agentId);
    const icon = agent?.icon || "";
    const status = step.success ? "ok" : "echec";
    const duration = Math.round(step.durationMs / 1000);
    lines.push(`${icon} ${step.agentName} : ${status} (${duration}s)`);
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
