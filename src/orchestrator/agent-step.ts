/**
 * @module orchestrator.agent-step
 * @description Single agent step execution: prompt building, Claude invocation, result parsing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { spawnClaude } from "../agent.ts";
import {
  type AgentMessage,
  buildStructuredChainContext,
  buildStructuredOutputInstructions,
  getJsonSchemaForRole,
  parseAgentOutput,
} from "../agent-schemas.ts";
import { getAgent } from "../bmad-agents.ts";
import {
  type AgentPromptContext,
  buildFullAgentPrompt,
  buildIsolationInstructions,
} from "../bmad-prompts.ts";
import { parseTokenUsage } from "../cost-tracking.ts";
import { createLogger } from "../logger.ts";
import type { Task } from "../tasks.ts";
import { AGENT_COMMAND_MAP, type AgentRole, type AgentStepResult } from "./types.ts";

const log = createLogger("orchestrator.agent-step");

export const _PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

/**
 * Run a single agent step: build prompt, call Claude, return result.
 * S22: Uses structured output instructions and parses JSON from output.
 */
export async function runAgentStep(
  agentId: AgentRole,
  task: Task,
  previousMessages: AgentMessage[],
  shardedContext?: string,
  agentContext?: string,
  /** S34: Per-role model override from LLM router */
  modelOverride?: string,
  /** S34: Enable model cascade */
  cascade?: boolean,
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
    subtasks:
      task.subtasks?.map((st: { title: string; done?: boolean }) => ({
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
    // S28: Use centralized spawnClaude with agent-specific CLI flags
    // S32: Inject Supabase context via --append-system-prompt
    // S33: MCP tool instructions per role
    // S34: Model override from router (AC-019), cascade support
    const jsonSchema = getJsonSchemaForRole(agentId);
    const effectiveModel = modelOverride || agent?.model;
    const result = await spawnClaude({
      prompt,
      systemPrompt: agentContext || undefined,
      outputFormat: jsonSchema ? "json" : "text",
      jsonSchema: jsonSchema || undefined,
      effort: agent?.effort,
      model: cascade ? undefined : effectiveModel, // cascade handles model selection
      fallbackModel: cascade ? undefined : agent?.fallbackModel,
      // Budget limits removed — agents run unconstrained
      mcpRole: agentId,
      cascade,
    });

    const rawOutput = result.stdout;
    const success = result.exitCode === 0;

    // Parse structured output (S22-02)
    const structured = success ? parseAgentOutput(rawOutput, agentId) : null;

    // Parse token usage (S23-05, S28: model-aware pricing, S34: cascade model tracking)
    const actualModel = result.modelUsed || effectiveModel || agent?.model;
    const usage = parseTokenUsage(rawOutput, prompt.length, actualModel);

    return {
      agentId,
      agentName,
      success,
      output: rawOutput,
      structured,
      error: result.exitCode !== 0 ? result.stderr : undefined,
      durationMs: Date.now() - startTime,
      tokensInput: usage.tokensInput,
      tokensOutput: usage.tokensOutput,
      costUsd: usage.costUsd,
    };
  } catch (error) {
    // R8: business error -> log.warn
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
export function getOrchestrationInstructions(agentId: AgentRole): string {
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
 * PM -> acceptance_criteria, Architect -> architecture_ref, QA -> dev_notes append
 */
export async function persistAgentArtifact(
  supabase: SupabaseClient,
  taskId: string,
  agentId: AgentRole,
  output: string,
): Promise<void> {
  const updates: Record<string, string> = {};

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

  const { error } = await supabase.from("tasks").update(updates).eq("id", taskId);
  if (error) log.error(`persistAgentArtifact(${agentId}) error: ${error.message}`);
}
