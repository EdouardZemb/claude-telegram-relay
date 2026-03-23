/**
 * @module orchestrator.format
 * @description Formatting orchestration results for Telegram display and logging.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatDriftReport } from "../adversarial-verifier.ts";
import { formatStructuredOutput } from "../agent-schemas.ts";
import { formatTraceabilityReport } from "../blackboard.ts";
import { getAgent } from "../bmad-agents.ts";
import { createLogger } from "../logger.ts";
import type { AgentStepResult, OrchestratedResult } from "./types.ts";

const log = createLogger("orchestrator.format");

/**
 * Build a summary string from orchestration steps.
 */
export function buildOrchestrationSummary(
  steps: AgentStepResult[],
  totalDurationMs: number,
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

  const totalCost = steps.reduce((sum, s) => sum + (s.costUsd || 0), 0);
  const totalTokens = steps.reduce(
    (sum, s) => sum + (s.tokensInput || 0) + (s.tokensOutput || 0),
    0,
  );
  if (totalTokens > 0) {
    lines.push(`Tokens: ~${totalTokens} (~$${totalCost.toFixed(4)})`);
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

/**
 * Log orchestration result to Supabase workflow_logs.
 */
export async function logOrchestrationResult(
  supabase: SupabaseClient,
  taskId: string,
  steps: AgentStepResult[],
  totalDurationMs: number,
  pipelineSelection?: string,
): Promise<void> {
  const totalRetries = steps.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  const { error } = await supabase.from("workflow_logs").insert({
    task_id: taskId,
    step_from: "orchestration_start",
    step_to: "orchestration_end",
    metadata: {
      type: "orchestration",
      pipeline: steps.map((s) => s.agentId),
      pipelineSelection: pipelineSelection || "manual",
      results: steps.map((s) => ({
        agent: s.agentId,
        success: s.success,
        durationMs: s.durationMs,
        outputLength: s.output.length,
        hasStructuredOutput: s.structured !== null,
        retryCount: s.retryCount || 0,
        tokensInput: s.tokensInput || 0,
        tokensOutput: s.tokensOutput || 0,
        costUsd: s.costUsd || 0,
      })),
      totalDurationMs,
      totalRetries,
      totalCost: steps.reduce((sum, s) => sum + (s.costUsd || 0), 0),
      allPassed: steps.every((s) => s.success),
    },
  });
  if (error) log.error(`logOrchestrationResult error: ${error.message}`);
}

/**
 * Format orchestration result for Telegram display (plain text).
 */
export function formatOrchestrationResult(result: OrchestratedResult): string {
  const lines: string[] = [];

  const statusIcon = result.success ? "OK" : "ATTENTION";
  lines.push(`ORCHESTRATION ${statusIcon}`);
  lines.push(`Duree: ${Math.round(result.totalDurationMs / 1000)}s`);

  const totalRetries = result.steps.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  if (totalRetries > 0) {
    lines.push(`Retries: ${totalRetries}`);
  }

  const totalCost = result.steps.reduce((sum, s) => sum + (s.costUsd || 0), 0);
  if (totalCost > 0) {
    lines.push(`Cout: ~$${totalCost.toFixed(4)}`);
  }
  lines.push("");

  for (const step of result.steps) {
    const agent = getAgent(step.agentId);
    const icon = agent?.icon || "";
    const status = step.success ? "ok" : "echec";
    const duration = Math.round(step.durationMs / 1000);
    const structuredTag = step.structured ? " [JSON]" : "";
    const retryTag = step.retryCount ? ` (${step.retryCount} retries)` : "";
    const costTag = step.costUsd ? ` ~$${step.costUsd.toFixed(4)}` : "";
    lines.push(
      `${icon} ${step.agentName} : ${status} (${duration}s)${structuredTag}${retryTag}${costTag}`,
    );
  }

  // S24: Blackboard results
  if (result.blackboard) {
    const bb = result.blackboard;
    lines.push("");
    lines.push("--- Blackboard ---");

    if (bb.gateEvaluations.length > 0) {
      lines.push("Gates:");
      for (const gate of bb.gateEvaluations) {
        const status = gate.pass ? "PASS" : "FAIL";
        lines.push(`  ${gate.gate_name}: ${status} (${gate.score}/100)`);
        if (gate.issues.length > 0) {
          for (const issue of gate.issues.slice(0, 3)) {
            lines.push(`    [${issue.severity}] ${issue.description}`);
          }
        }
      }
    }

    if (bb.driftReport) {
      lines.push("");
      lines.push(formatDriftReport(bb.driftReport));
    }

    if (bb.traceabilityReport) {
      lines.push("");
      lines.push(formatTraceabilityReport(bb.traceabilityReport));
    }
  }

  // Add last agent's output as the main result (formatted as plain text)
  const lastSuccessful = [...result.steps].reverse().find((s) => s.success);
  if (lastSuccessful) {
    lines.push("");
    lines.push("--- Resultat ---");
    const maxLen = 3000;
    // Use structured output formatted as plain text when available
    const output = lastSuccessful.structured
      ? formatStructuredOutput(lastSuccessful.structured)
      : lastSuccessful.output;
    if (output) {
      lines.push(output.length > maxLen ? output.substring(0, maxLen) + "..." : output);
    }
  }

  return lines.join("\n");
}
