/**
 * @module agent-events
 * @description Agent event log (event sourcing): tracks agent lifecycle in pipelines.
 * Persists to `agent_events` table with in-memory fallback.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "./logger.ts";

const log = createLogger("agent-events");
// ── Types ────────────────────────────────────────────────────

export type AgentEventType =
  | "spawned"
  | "started"
  | "output_produced"
  | "completed"
  | "failed"
  | "retried"
  | "skipped"
  | "timed_out"
  | "message_sent"
  | "message_received"
  | "clarification_requested"
  | "clarification_resolved"
  | "failure_captured";

export interface AgentEvent {
  id?: string;
  session_id: string;
  agent_role: string;
  event_type: AgentEventType;
  payload: Record<string, unknown>;
  created_at?: string;
}

// ── In-Memory Fallback ───────────────────────────────────────

const inMemoryEvents: Map<string, AgentEvent[]> = new Map();

function getInMemoryEvents(sessionId: string): AgentEvent[] {
  if (!inMemoryEvents.has(sessionId)) {
    inMemoryEvents.set(sessionId, []);
  }
  return inMemoryEvents.get(sessionId)!;
}

// ── Core API ─────────────────────────────────────────────────

/**
 * Emit an agent event. Fire-and-forget async — never blocks the pipeline.
 * Falls back to in-memory storage when Supabase is unavailable.
 */
export async function emitAgentEvent(
  supabase: SupabaseClient | null,
  sessionId: string,
  role: string,
  eventType: AgentEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const event: AgentEvent = {
    session_id: sessionId,
    agent_role: role,
    event_type: eventType,
    payload,
    created_at: new Date().toISOString(),
  };

  if (!supabase) {
    getInMemoryEvents(sessionId).push(event);
    return;
  }

  try {
    const { error } = await supabase.from("agent_events").insert({
      session_id: sessionId,
      agent_role: role,
      event_type: eventType,
      payload,
    });
    if (error) {
      // Fallback to in-memory on error
      getInMemoryEvents(sessionId).push(event);
    }
  } catch {
    getInMemoryEvents(sessionId).push(event);
  }
}

/**
 * Get all events for a pipeline session, ordered by created_at.
 * Merges Supabase and in-memory events.
 */
export async function getAgentEvents(
  supabase: SupabaseClient | null,
  sessionId: string,
  role?: string,
): Promise<AgentEvent[]> {
  const memEvents = inMemoryEvents.get(sessionId) || [];

  if (!supabase) {
    const filtered = role ? memEvents.filter((e) => e.agent_role === role) : memEvents;
    return filtered.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  }

  let query = supabase
    .from("agent_events")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (role) {
    query = query.eq("agent_role", role);
  }

  const { data, error } = await query;

  if (error) {
    // Return in-memory only
    const filtered = role ? memEvents.filter((e) => e.agent_role === role) : memEvents;
    return filtered.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  }

  // Merge Supabase + in-memory (dedup by checking if in-memory events are also in DB)
  const dbEvents = (data || []) as AgentEvent[];
  const memOnly = role ? memEvents.filter((e) => e.agent_role === role) : memEvents;

  // In-memory events that aren't in DB (no id = not persisted)
  const combined = [...dbEvents, ...memOnly.filter((e) => !e.id)];
  return combined.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
}

/**
 * Get in-memory events for a session (e.g., for agent timeline display).
 */
export function getInMemoryEventsForSession(sessionId: string): AgentEvent[] {
  return inMemoryEvents.get(sessionId) || [];
}

/**
 * Clear in-memory events for a session (cleanup after pipeline).
 */
export function clearInMemoryEvents(sessionId: string): void {
  inMemoryEvents.delete(sessionId);
}

/**
 * Format agent timeline for display.
 */
export function formatAgentTimeline(events: AgentEvent[]): string {
  if (events.length === 0) return "Aucun event agent";

  const lines: string[] = ["TIMELINE AGENTS:"];
  for (const event of events) {
    const time = event.created_at
      ? new Date(event.created_at).toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "??:??:??";
    const durationMs =
      typeof event.payload.duration_ms === "number" ? event.payload.duration_ms : null;
    const payloadStr = durationMs ? ` (${Math.round(durationMs / 1000)}s)` : "";
    lines.push(`  ${time} ${event.agent_role} ${event.event_type}${payloadStr}`);
  }
  return lines.join("\n");
}

// ── P3: Agent DLQ (Dead Letter Queue cognitive) ──────────────

export interface FailureContext {
  /** First 500 chars of the prompt */
  promptSnippet: string;
  /** First 2000 chars of partial output */
  partialOutput: string;
  /** Error message */
  error: string;
  /** Input tokens consumed */
  tokensInput: number;
  /** Output tokens consumed */
  tokensOutput: number;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Capture an agent failure after retry exhaustion.
 * Fire-and-forget: never blocks the pipeline, never propagates errors.
 * Falls back to in-memory when Supabase is unavailable.
 */
export async function captureAgentFailure(
  supabase: SupabaseClient | null,
  sessionId: string,
  role: string,
  ctx: FailureContext,
): Promise<void> {
  const payload = {
    prompt_snippet: (ctx.promptSnippet || "").substring(0, 500),
    partial_output: (ctx.partialOutput || "").substring(0, 2000),
    error: ctx.error || "",
    tokens_input: ctx.tokensInput || 0,
    tokens_output: ctx.tokensOutput || 0,
    duration_ms: ctx.durationMs || 0,
  };

  try {
    await emitAgentEvent(supabase, sessionId, role, "failure_captured", payload);
  } catch {
    // Fire-and-forget: never propagate errors
    // emitAgentEvent already has its own fallback, but guard against unexpected failures
    try {
      getInMemoryEvents(sessionId).push({
        session_id: sessionId,
        agent_role: role,
        event_type: "failure_captured",
        payload,
        created_at: new Date().toISOString(),
      });
    } catch {
      // Last resort: log to console
      log.error("captureAgentFailure: failed to store event", { sessionId, role });
    }
  }
}

// ── P5: Tracing Timeline alias ───────────────────────────────

/**
 * Get tracing timeline for a pipeline session.
 * Alias of getAgentEvents — no new implementation needed (R13).
 */
export const getTracingTimeline = getAgentEvents;
