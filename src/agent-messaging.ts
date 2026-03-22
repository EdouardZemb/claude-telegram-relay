/**
 * @module agent-messaging
 * @description Inter-agent messaging via blackboard: structured messages,
 * clarification protocol, conflict detection, enriched context.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { emitAgentEvent } from "./agent-events.ts";
import type { WorkingMemory } from "./blackboard.ts";
import { readSection, type SectionName, writeSectionWithRetry } from "./blackboard.ts";

// ── Types ────────────────────────────────────────────────────

export interface AgentInterMessage {
  id: string;
  from: string;
  to: string; // AgentRole or "*" for broadcast
  type: "directive" | "question" | "observation" | "warning" | "escalation";
  content: string;
  correlationId?: string;
  timestamp: string;
  resolved?: boolean;
}

export interface MessagesSection {
  messages: AgentInterMessage[];
}

/** Max messages before truncation (EC-004) */
const MAX_MESSAGES = 20;

/** Max token budget for messages in agent context (FR-005) */
const MAX_MESSAGE_TOKENS = 2000;

/** Max 1 round-trip per agent pair (FR-003 guard) */
const clarificationTracker = new Map<string, Set<string>>();

// ── Core Messaging API ───────────────────────────────────────

/**
 * Send an inter-agent message via the blackboard messages section.
 */
export async function sendAgentMessage(
  supabase: SupabaseClient | null,
  sessionId: string,
  message: AgentInterMessage,
  expectedVersion: number,
): Promise<{ success: boolean; newVersion: number; error?: string }> {
  if (!supabase) {
    return { success: false, newVersion: expectedVersion, error: "No supabase" };
  }

  // Read current messages
  const current = (await readSection(
    supabase,
    sessionId,
    "messages" as SectionName,
  )) as MessagesSection | null;
  const section: MessagesSection = current || { messages: [] };

  // EC-004: Truncate oldest if over limit
  if (section.messages.length >= MAX_MESSAGES) {
    section.messages = section.messages.slice(-15); // Keep 15 most recent
  }

  section.messages.push(message);

  // Emit event
  await emitAgentEvent(supabase, sessionId, message.from, "message_sent", {
    to: message.to,
    message_type: message.type,
  });

  return writeSectionWithRetry(
    supabase,
    sessionId,
    "messages" as SectionName,
    section,
    message.from,
    expectedVersion,
  );
}

/**
 * Get messages for a specific agent role (addressed to role or broadcast).
 */
export async function getAgentMessages(
  supabase: SupabaseClient | null,
  sessionId: string,
  forRole: string,
): Promise<AgentInterMessage[]> {
  if (!supabase) return [];

  const section = (await readSection(
    supabase,
    sessionId,
    "messages" as SectionName,
  )) as MessagesSection | null;
  if (!section?.messages) return [];

  return section.messages
    .filter((m) => m.to === forRole || m.to === "*")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Get unresolved questions for a specific agent role.
 */
export async function getPendingQuestions(
  supabase: SupabaseClient | null,
  sessionId: string,
  forRole: string,
): Promise<AgentInterMessage[]> {
  const messages = await getAgentMessages(supabase, sessionId, forRole);
  return messages.filter((m) => m.type === "question" && !m.resolved);
}

/**
 * Resolve a question by marking it as resolved and adding a response.
 */
export async function resolveQuestion(
  supabase: SupabaseClient | null,
  sessionId: string,
  questionId: string,
  responseMessage: AgentInterMessage,
  expectedVersion: number,
): Promise<{ success: boolean; newVersion: number; error?: string }> {
  if (!supabase) {
    return { success: false, newVersion: expectedVersion, error: "No supabase" };
  }

  const section = (await readSection(
    supabase,
    sessionId,
    "messages" as SectionName,
  )) as MessagesSection | null;
  if (!section?.messages) {
    return { success: false, newVersion: expectedVersion, error: "No messages" };
  }

  // Mark question as resolved
  const question = section.messages.find((m) => m.id === questionId);
  if (question) {
    question.resolved = true;
  }

  // Add response with correlation
  responseMessage.correlationId = questionId;
  section.messages.push(responseMessage);

  return writeSectionWithRetry(
    supabase,
    sessionId,
    "messages" as SectionName,
    section,
    responseMessage.from,
    expectedVersion,
  );
}

// ── Clarification Protocol (FR-003) ─────────────────────────

/**
 * Check if a clarification round-trip is allowed between two agents.
 * Max 1 round-trip per pair per pipeline.
 */
export function canRequestClarification(
  sessionId: string,
  fromRole: string,
  toRole: string,
): boolean {
  const _key = `${sessionId}:${fromRole}->${toRole}`;
  const pairKey = `${fromRole}->${toRole}`;

  if (!clarificationTracker.has(sessionId)) {
    clarificationTracker.set(sessionId, new Set());
  }

  return !clarificationTracker.get(sessionId)!.has(pairKey);
}

/**
 * Mark a clarification as used between two agents.
 */
export function markClarificationUsed(sessionId: string, fromRole: string, toRole: string): void {
  if (!clarificationTracker.has(sessionId)) {
    clarificationTracker.set(sessionId, new Set());
  }
  clarificationTracker.get(sessionId)!.add(`${fromRole}->${toRole}`);
}

/**
 * Clear clarification tracker for a session (cleanup).
 */
export function clearClarificationTracker(sessionId: string): void {
  clarificationTracker.delete(sessionId);
}

/**
 * Check for pending questions after an agent completes.
 * Returns unresolved questions from the agent's output.
 */
export async function checkPendingClarifications(
  supabase: SupabaseClient | null,
  sessionId: string,
): Promise<AgentInterMessage[]> {
  if (!supabase) return [];

  const section = (await readSection(
    supabase,
    sessionId,
    "messages" as SectionName,
  )) as MessagesSection | null;
  if (!section?.messages) return [];

  return section.messages.filter((m) => m.type === "question" && !m.resolved);
}

// ── Conflict Detection (FR-004) ──────────────────────────────

export interface DetectedConflict {
  agent1: string;
  agent2: string;
  subject: string;
  agent1Position: string;
  agent2Position: string;
}

/**
 * Detect conflicts between agent decisions in working memory.
 * Uses lexical overlap (Jaccard > 0.5) + different assertions.
 */
export function detectConflicts(workingMemory: WorkingMemory | null): DetectedConflict[] {
  if (!workingMemory?.decisions || workingMemory.decisions.length < 2) return [];

  const conflicts: DetectedConflict[] = [];

  for (let i = 0; i < workingMemory.decisions.length; i++) {
    for (let j = i + 1; j < workingMemory.decisions.length; j++) {
      const d1 = workingMemory.decisions[i];
      const d2 = workingMemory.decisions[j];

      // Skip same agent
      if (d1.agent === d2.agent) continue;

      // Check lexical overlap on decision subject
      const overlap = jaccardSimilarity(d1.decision, d2.decision);
      if (overlap > 0.5) {
        // Same subject, check if reasoning differs significantly
        const reasoningOverlap = jaccardSimilarity(d1.reasoning, d2.reasoning);
        if (reasoningOverlap < 0.3) {
          conflicts.push({
            agent1: d1.agent,
            agent2: d2.agent,
            subject: d1.decision,
            agent1Position: d1.reasoning,
            agent2Position: d2.reasoning,
          });
        }
      }
    }
  }

  return conflicts;
}

/**
 * Jaccard similarity between two strings (word-level).
 */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Agent role hierarchy for mediation (FR-004) */
const ROLE_HIERARCHY: Record<string, number> = {
  architect: 3,
  pm: 2,
  analyst: 1,
  dev: 1,
  qa: 1,
  sm: 0,
};

/**
 * Get the higher-ranked agent for mediation.
 */
export function getMediatingAgent(role1: string, role2: string): string {
  const rank1 = ROLE_HIERARCHY[role1] ?? 0;
  const rank2 = ROLE_HIERARCHY[role2] ?? 0;
  return rank1 >= rank2 ? role1 : role2;
}

// ── Context Enrichment (FR-005) ──────────────────────────────

/**
 * Build inter-agent messages context for inclusion in agent prompts.
 * Respects token budget (max 2000 tokens ~= 8000 chars).
 */
export function buildInterAgentContext(messages: AgentInterMessage[], forRole: string): string {
  const relevant = messages.filter((m) => m.to === forRole || m.to === "*");

  if (relevant.length === 0) return "";

  const parts: string[] = ["MESSAGES INTER-AGENTS:"];

  // Prioritize warnings and escalations first
  const sorted = [...relevant].sort((a, b) => {
    const priority: Record<string, number> = {
      escalation: 0,
      warning: 1,
      question: 2,
      directive: 3,
      observation: 4,
    };
    return (priority[a.type] ?? 5) - (priority[b.type] ?? 5);
  });

  let charCount = 0;
  const maxChars = MAX_MESSAGE_TOKENS * 4; // ~4 chars per token

  for (const msg of sorted) {
    const resolvedTag = msg.resolved ? " [RESOLU]" : "";
    const line = `[${msg.type.toUpperCase()}] ${msg.from} -> ${msg.to}: ${msg.content}${resolvedTag}`;

    if (charCount + line.length > maxChars) break;

    parts.push(line);
    charCount += line.length;

    // Include correlation response if resolved
    if (msg.resolved && msg.correlationId) {
      const response = relevant.find((m) => m.correlationId === msg.id);
      if (response) {
        const respLine = `  Reponse de ${response.from}: ${response.content}`;
        if (charCount + respLine.length <= maxChars) {
          parts.push(respLine);
          charCount += respLine.length;
        }
      }
    }
  }

  return parts.join("\n");
}

// ── Monitoring (FR-006) ──────────────────────────────────────

export interface MessageFlowSummary {
  totalMessages: number;
  byType: Record<string, number>;
  clarificationsRequested: number;
  clarificationsResolved: number;
  conflictsDetected: number;
}

/**
 * Summarize message flow for monitoring.
 */
export function getMessageFlowSummary(messages: AgentInterMessage[]): MessageFlowSummary {
  const byType: Record<string, number> = {};
  let clarificationsRequested = 0;
  let clarificationsResolved = 0;

  for (const msg of messages) {
    byType[msg.type] = (byType[msg.type] || 0) + 1;
    if (msg.type === "question") {
      clarificationsRequested++;
      if (msg.resolved) clarificationsResolved++;
    }
  }

  return {
    totalMessages: messages.length,
    byType,
    clarificationsRequested,
    clarificationsResolved,
    conflictsDetected: byType.escalation || 0,
  };
}

/**
 * Format message flow for /monitor display.
 */
export function formatMessageFlow(summary: MessageFlowSummary): string {
  const lines: string[] = [`MESSAGES INTER-AGENTS: ${summary.totalMessages} total`];

  if (summary.totalMessages === 0) return lines[0];

  const types = Object.entries(summary.byType)
    .map(([t, n]) => `${t}: ${n}`)
    .join(", ");
  lines.push(`  Types: ${types}`);

  if (summary.clarificationsRequested > 0) {
    lines.push(
      `  Clarifications: ${summary.clarificationsResolved}/${summary.clarificationsRequested} resolues`,
    );
  }

  if (summary.conflictsDetected > 0) {
    lines.push(`  Conflits detectes: ${summary.conflictsDetected}`);
  }

  return lines.join("\n");
}

/**
 * Export jaccardSimilarity for testing.
 */
export { jaccardSimilarity };
