/**
 * @module deliberation
 * @description Deliberation protocol for multi-agent pipelines: after a strategic
 * agent completes, a paired reviewer examines the output and can request a revision.
 * Max 1 round-trip per pair. Behind "deliberation" feature flag.
 */

import type { Task } from "./tasks.ts";
import type { AgentMessage } from "./agent-schemas.ts";
import { parseAgentOutput } from "./agent-schemas.ts";
import { getAgent } from "./bmad-agents.ts";
import { spawnClaude } from "./agent.ts";
import type { AgentRole, AgentStepResult } from "./orchestrator.ts";
import { runAgentStep } from "./orchestrator.ts";

// ── Deliberation Pairs ───────────────────────────────────────

/**
 * Deliberation pairs: after a strategic agent completes, the next agent
 * reviews their output and can request a revision. Max 1 round-trip.
 */
const DELIBERATION_PAIRS: Record<string, string> = {
  architect: "pm",    // PM validates architect's design feasibility
  dev: "qa",          // QA pre-reviews dev's implementation plan
};

// ── Functions ────────────────────────────────────────────────

/**
 * Run a deliberation round between two agents.
 * The reviewer examines the proposer's output and flags issues.
 * If issues found, the proposer revises (1 iteration max).
 * Returns the (possibly revised) output.
 *
 * S43-04: Behind "deliberation" feature flag.
 */
export async function runDeliberation(
  proposerRole: AgentRole,
  reviewerRole: AgentRole,
  proposerOutput: string,
  task: Task,
  messages: AgentMessage[],
  shardedContext?: string,
  agentContext?: string,
  options?: { modelOverride?: string | undefined; cascade?: boolean | undefined; onProgress?: ((msg: string) => Promise<void>) | undefined },
): Promise<{ output: string; revised: boolean; reviewerFeedback: string }> {
  const proposerAgent = getAgent(proposerRole);
  const reviewerAgent = getAgent(reviewerRole);
  const proposerLabel = proposerAgent ? `${proposerAgent.icon} ${proposerAgent.name}` : proposerRole;
  const reviewerLabel = reviewerAgent ? `${reviewerAgent.icon} ${reviewerAgent.name}` : reviewerRole;

  // Step 1: Reviewer examines proposer's output
  const reviewPrompt = [
    `Tu es ${reviewerLabel} et tu revois le travail de ${proposerLabel}.`,
    "",
    "PROPOSITION A REVOIR:",
    proposerOutput.substring(0, 5000),
    "",
    "INSTRUCTIONS:",
    "- Identifie les problemes concrets (faisabilite, coherence, manques)",
    "- Si tout est acceptable, reponds: APPROVE",
    "- Si des corrections sont necessaires, reponds: REVISE suivi de tes feedbacks",
    "- Sois concis et specifique",
    "- Maximum 3 points de feedback",
  ].join("\n");

  if (options?.onProgress) {
    await options.onProgress(`Deliberation: ${reviewerLabel} revoit ${proposerLabel}...`);
  }

  const reviewResult = await spawnClaude({
    prompt: reviewPrompt,
    effort: "low",
    model: reviewerAgent?.model || "sonnet",
    // Budget limits removed
  });

  const reviewOutput = reviewResult.stdout.trim();

  // Check if approved
  if (reviewOutput.toUpperCase().includes("APPROVE") && !reviewOutput.toUpperCase().includes("REVISE")) {
    if (options?.onProgress) {
      await options.onProgress(`Deliberation: ${reviewerLabel} approuve ${proposerLabel}`);
    }
    return { output: proposerOutput, revised: false, reviewerFeedback: reviewOutput };
  }

  // Step 2: Proposer revises based on feedback
  if (options?.onProgress) {
    await options.onProgress(`Deliberation: ${proposerLabel} revise suite au feedback de ${reviewerLabel}...`);
  }

  const revisionMessages: AgentMessage[] = [
    ...messages,
    {
      agentId: reviewerRole,
      agentName: reviewerAgent?.name || reviewerRole,
      success: true,
      structured: null,
      rawOutput: `FEEDBACK DE DELIBERATION (${reviewerLabel}):\n${reviewOutput}`,
      durationMs: 0,
    },
  ];

  const revisedResult = await runAgentStep(
    proposerRole,
    task,
    revisionMessages,
    shardedContext,
    agentContext,
    options?.modelOverride,
    options?.cascade,
  );

  if (revisedResult.success) {
    if (options?.onProgress) {
      await options.onProgress(`Deliberation: ${proposerLabel} a revise sa proposition`);
    }
    return { output: revisedResult.output, revised: true, reviewerFeedback: reviewOutput };
  }

  // Revision failed — keep original
  return { output: proposerOutput, revised: false, reviewerFeedback: reviewOutput };
}

/**
 * Check if deliberation should happen after this agent.
 */
export function shouldDeliberate(agentId: AgentRole): boolean {
  return agentId in DELIBERATION_PAIRS;
}

/**
 * Get the reviewer role for a given proposer.
 */
export function getDeliberationReviewer(agentId: AgentRole): AgentRole | null {
  return (DELIBERATION_PAIRS[agentId] as AgentRole) || null;
}
