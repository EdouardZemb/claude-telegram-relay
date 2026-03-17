/**
 * @module agent-events
 * @description Agent event log (event sourcing): tracks agent lifecycle in pipelines.
 * Persists to `agent_events` table with in-memory fallback.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRole } from "./orchestrator.ts";

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
  | "clarification_resolved";

export interface AgentEvent {
  id?: string;
  session_id: string;
  agent_role: string;
  event_type: AgentEventType;
  payload: Record<string, any>;
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
  payload: Record<string, any> = {}
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
  role?: string
): Promise<AgentEvent[]> {
  const memEvents = inMemoryEvents.get(sessionId) || [];

  if (!supabase) {
    const filtered = role
      ? memEvents.filter((e) => e.agent_role === role)
      : memEvents;
    return filtered.sort((a, b) =>
      (a.created_at || "").localeCompare(b.created_at || "")
    );
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
    const filtered = role
      ? memEvents.filter((e) => e.agent_role === role)
      : memEvents;
    return filtered.sort((a, b) =>
      (a.created_at || "").localeCompare(b.created_at || "")
    );
  }

  // Merge Supabase + in-memory (dedup by checking if in-memory events are also in DB)
  const dbEvents = (data || []) as AgentEvent[];
  const memOnly = role
    ? memEvents.filter((e) => e.agent_role === role)
    : memEvents;

  // In-memory events that aren't in DB (no id = not persisted)
  const combined = [...dbEvents, ...memOnly.filter((e) => !e.id)];
  return combined.sort((a, b) =>
    (a.created_at || "").localeCompare(b.created_at || "")
  );
}

/**
 * Get in-memory events for a session (for inclusion in supervisor report).
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
      ? new Date(event.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "??:??:??";
    const payloadStr = event.payload.duration_ms
      ? ` (${Math.round(event.payload.duration_ms / 1000)}s)`
      : "";
    lines.push(`  ${time} ${event.agent_role} ${event.event_type}${payloadStr}`);
  }
  return lines.join("\n");
}
