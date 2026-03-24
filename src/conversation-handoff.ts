/**
 * @module conversation-handoff
 * @description Assembles structured handoff context from conversational decisions
 * for passing to background SDD agents. No LLM call — uses local pattern matching
 * on recent messages to extract decisions, constraints, and file references.
 *
 * Phase 2 Architecture V2 — bridge between conversation (ephemeral) and agents (persistent).
 *
 * ARCHITECTURE-V2 constraint: no imports from orchestrator/, blackboard.ts, agent-schemas.ts,
 * pipeline-state.ts, conversation-session.ts, or any module marked "Supprime".
 */

import { createLogger } from "./logger.ts";

const log = createLogger("conversation-handoff");

// ── Types (standalone, not imported from conversation-session.ts per Decision Q1) ──

export interface HandoffSummary {
  objective: string;
  decisions: string[];
  constraints: string[];
  filesIdentified: string[];
  resolvedQuestions: string[];
  outOfScope: string[];
  explorationRef?: string;
  specRef?: string;
}

export interface AssembleOptions {
  explorationRef?: string;
  specRef?: string;
  pipelineName?: string;
}

// ── Pattern Matching (R8) ────────────────────────────────────

/**
 * Patterns to extract decisions from conversation messages.
 * Messages containing these patterns indicate a decision was made.
 */
const DECISION_PATTERNS: RegExp[] = [
  /\[DECIDE\]\s*(.+)/i,
  /\[DECISION\]\s*(.+)/i,
  /(?:on\s+(?:fait|choisit|decide|opte\s+pour|retient|garde|prend))\s+(.+?)(?:\.|$)/i,
  /(?:decision\s*:\s*)(.+?)(?:\.|$)/i,
  /(?:je\s+(?:decide|choisis|opte\s+pour|retiens))\s+(.+?)(?:\.|$)/i,
];

const CONSTRAINT_PATTERNS: RegExp[] = [
  /\[CONTRAINTE\]\s*(.+)/i,
  /(?:contrainte\s*:\s*)(.+?)(?:\.|$)/i,
  /(?:il\s+faut\s+(?:que|absolument)?)\s+(.+?)(?:\.|$)/i,
  /(?:ne\s+(?:pas|jamais)\s+.+?)(?:\.|$)/,
];

const FILE_PATTERNS: RegExp[] = [
  /(?:src\/[^\s,)]+\.ts)/g,
  /(?:tests\/[^\s,)]+\.ts)/g,
  /(?:docs\/[^\s,)]+\.md)/g,
  /(?:config\/[^\s,)]+)/g,
];

const QUESTION_PATTERNS: RegExp[] = [
  /\[RESOLU\]\s*(.+)/i,
  /(?:question\s+resolue\s*:\s*)(.+?)(?:\.|$)/i,
];

const OUT_OF_SCOPE_PATTERNS: RegExp[] = [
  /\[HORS.?SCOPE\]\s*(.+)/i,
  /(?:hors\s+scope\s*:\s*)(.+?)(?:\.|$)/i,
  /(?:on\s+(?:exclut|ne\s+fait\s+pas|reporte))\s+(.+?)(?:\.|$)/i,
];

/**
 * Extract matches from messages using pattern list.
 * Returns deduplicated extracted strings.
 */
function extractFromMessages(messages: string[], patterns: RegExp[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    for (const pattern of patterns) {
      // Handle global patterns (file paths) differently
      if (pattern.global) {
        const globalMatches = msg.matchAll(pattern);
        for (const m of globalMatches) {
          const value = m[0].trim();
          if (value && !seen.has(value.toLowerCase())) {
            seen.add(value.toLowerCase());
            results.push(value);
          }
        }
      } else {
        const m = msg.match(pattern);
        if (m) {
          const value = (m[1] || m[0]).trim();
          if (value && !seen.has(value.toLowerCase())) {
            seen.add(value.toLowerCase());
            results.push(value);
          }
        }
      }
    }
  }

  return results;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Assemble handoff context from recent messages WITHOUT LLM call (R7, R8).
 * Uses local pattern matching on messages to extract decisions, constraints,
 * file references, resolved questions, and out-of-scope items.
 *
 * If no patterns are found, arrays are empty — the agent will do its own analysis.
 *
 * @param recentMessages - Formatted recent conversation messages
 * @param options - Optional references and pipeline name
 */
export function assembleHandoffContext(
  recentMessages: string[],
  options: AssembleOptions = {},
): HandoffSummary {
  const objective = options.pipelineName ? options.pipelineName.replace(/-/g, " ") : "conversation";

  const decisions = extractFromMessages(recentMessages, DECISION_PATTERNS);
  const constraints = extractFromMessages(recentMessages, CONSTRAINT_PATTERNS);
  const filesIdentified = extractFromMessages(recentMessages, FILE_PATTERNS);
  const resolvedQuestions = extractFromMessages(recentMessages, QUESTION_PATTERNS);
  const outOfScope = extractFromMessages(recentMessages, OUT_OF_SCOPE_PATTERNS);

  log.info("Handoff context assembled", {
    objective,
    decisions: decisions.length,
    constraints: constraints.length,
    filesIdentified: filesIdentified.length,
  });

  return {
    objective,
    decisions,
    constraints,
    filesIdentified,
    resolvedQuestions,
    outOfScope,
    explorationRef: options.explorationRef,
    specRef: options.specRef,
  };
}

/**
 * Format a HandoffSummary as plain text for agent prompt injection (V12).
 */
export function formatHandoffForAgent(summary: HandoffSummary): string {
  const lines: string[] = ["RESUME DES DECISIONS CONVERSATIONNELLES", ""];

  lines.push(`Objectif: ${summary.objective}`);
  lines.push("");

  lines.push("Decisions:");
  if (summary.decisions.length > 0) {
    for (const d of summary.decisions) {
      lines.push(`- ${d}`);
    }
  } else {
    lines.push("- (aucune decision explicite detectee)");
  }
  lines.push("");

  lines.push("Contraintes:");
  if (summary.constraints.length > 0) {
    for (const c of summary.constraints) {
      lines.push(`- ${c}`);
    }
  } else {
    lines.push("- (aucune)");
  }
  lines.push("");

  lines.push(
    `Fichiers identifies: ${summary.filesIdentified.length > 0 ? summary.filesIdentified.join(", ") : "aucun"}`,
  );
  lines.push("");

  lines.push("Questions resolues:");
  if (summary.resolvedQuestions.length > 0) {
    for (const q of summary.resolvedQuestions) {
      lines.push(`- ${q}`);
    }
  } else {
    lines.push("- (aucune)");
  }
  lines.push("");

  lines.push(
    `Hors scope: ${summary.outOfScope.length > 0 ? summary.outOfScope.join(", ") : "aucun"}`,
  );
  lines.push("");

  lines.push(`Reference exploration: ${summary.explorationRef || "aucune"}`);
  lines.push(`Reference spec: ${summary.specRef || "aucune"}`);

  return lines.join("\n");
}
