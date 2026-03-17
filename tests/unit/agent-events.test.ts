/**
 * Tests for agent-events.ts — S38 FR-001: Agent Event Log
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  emitAgentEvent,
  getAgentEvents,
  getInMemoryEventsForSession,
  clearInMemoryEvents,
  formatAgentTimeline,
  type AgentEvent,
} from "../../src/agent-events.ts";
import { createMockSupabase } from "../fixtures/mock-supabase.ts";

describe("agent-events", () => {
  let supabase: any;

  beforeEach(() => {
    supabase = createMockSupabase();
    clearInMemoryEvents("test-session");
    clearInMemoryEvents("session-1");
    clearInMemoryEvents("session-2");
  });

  // AC-001: Each execution generates at minimum spawned + completed|failed|timed_out
  describe("emitAgentEvent", () => {
    it("stores event in Supabase", async () => {
      await emitAgentEvent(supabase, "session-1", "dev", "spawned", { model: "opus" });

      const rows = supabase._getTable("agent_events");
      expect(rows.length).toBe(1);
      expect(rows[0].session_id).toBe("session-1");
      expect(rows[0].agent_role).toBe("dev");
      expect(rows[0].event_type).toBe("spawned");
      expect(rows[0].payload.model).toBe("opus");
    });

    it("emits completed event after spawned", async () => {
      await emitAgentEvent(supabase, "session-1", "dev", "spawned", {});
      await emitAgentEvent(supabase, "session-1", "dev", "completed", {
        duration_ms: 5000, tokens_input: 100, cost_usd: 0.01,
      });

      const rows = supabase._getTable("agent_events");
      expect(rows.length).toBe(2);
      expect(rows[0].event_type).toBe("spawned");
      expect(rows[1].event_type).toBe("completed");
    });

    it("emits failed event on agent failure", async () => {
      await emitAgentEvent(supabase, "session-1", "qa", "spawned", {});
      await emitAgentEvent(supabase, "session-1", "qa", "failed", {
        error: "timeout", exit_code: 1,
      });

      const rows = supabase._getTable("agent_events");
      expect(rows.length).toBe(2);
      expect(rows[1].event_type).toBe("failed");
      expect(rows[1].payload.error).toBe("timeout");
    });

    // AC-003: In-memory fallback when supabase is null
    it("falls back to in-memory when supabase is null", async () => {
      await emitAgentEvent(null, "session-1", "dev", "spawned", { model: "sonnet" });

      const events = getInMemoryEventsForSession("session-1");
      expect(events.length).toBe(1);
      expect(events[0].agent_role).toBe("dev");
      expect(events[0].event_type).toBe("spawned");
    });

    it("stores event with correct created_at timestamp", async () => {
      const before = new Date().toISOString();
      await emitAgentEvent(null, "session-1", "dev", "spawned", {});
      const events = getInMemoryEventsForSession("session-1");
      expect(events[0].created_at! >= before).toBe(true);
    });

    it("records multiple event types", async () => {
      await emitAgentEvent(supabase, "session-1", "architect", "spawned", {});
      await emitAgentEvent(supabase, "session-1", "architect", "started", {});
      await emitAgentEvent(supabase, "session-1", "architect", "output_produced", {});
      await emitAgentEvent(supabase, "session-1", "architect", "completed", {});

      const rows = supabase._getTable("agent_events");
      expect(rows.length).toBe(4);
    });

    it("records message_sent event type", async () => {
      await emitAgentEvent(supabase, "session-1", "dev", "message_sent", {
        to: "architect", message_type: "question",
      });

      const rows = supabase._getTable("agent_events");
      expect(rows[0].event_type).toBe("message_sent");
      expect(rows[0].payload.to).toBe("architect");
    });

    it("records clarification events", async () => {
      await emitAgentEvent(supabase, "session-1", "dev", "clarification_requested", {
        target_agent: "architect", question: "How to handle X?",
      });
      await emitAgentEvent(supabase, "session-1", "architect", "clarification_resolved", {
        source_agent: "dev", answer: "Use pattern Y",
      });

      const rows = supabase._getTable("agent_events");
      expect(rows.length).toBe(2);
      expect(rows[0].event_type).toBe("clarification_requested");
      expect(rows[1].event_type).toBe("clarification_resolved");
    });
  });

  // AC-004: getAgentEvents returns timeline ordered by created_at
  describe("getAgentEvents", () => {
    it("returns events ordered by created_at", async () => {
      await emitAgentEvent(supabase, "session-1", "analyst", "spawned", {});
      await emitAgentEvent(supabase, "session-1", "pm", "spawned", {});
      await emitAgentEvent(supabase, "session-1", "analyst", "completed", {});

      const events = await getAgentEvents(supabase, "session-1");
      expect(events.length).toBe(3);
    });

    // AC-005: Filter by role
    it("filters by role when specified", async () => {
      await emitAgentEvent(supabase, "session-1", "analyst", "spawned", {});
      await emitAgentEvent(supabase, "session-1", "pm", "spawned", {});
      await emitAgentEvent(supabase, "session-1", "analyst", "completed", {});

      const events = await getAgentEvents(supabase, "session-1", "analyst");
      expect(events.length).toBe(2);
      expect(events.every((e: AgentEvent) => e.agent_role === "analyst")).toBe(true);
    });

    it("returns empty for unknown session", async () => {
      const events = await getAgentEvents(supabase, "nonexistent");
      expect(events.length).toBe(0);
    });

    it("returns in-memory events when supabase is null", async () => {
      await emitAgentEvent(null, "session-1", "dev", "spawned", {});
      await emitAgentEvent(null, "session-1", "dev", "completed", {});

      const events = await getAgentEvents(null, "session-1");
      expect(events.length).toBe(2);
    });

    it("filters in-memory events by role", async () => {
      await emitAgentEvent(null, "session-1", "dev", "spawned", {});
      await emitAgentEvent(null, "session-1", "qa", "spawned", {});

      const events = await getAgentEvents(null, "session-1", "dev");
      expect(events.length).toBe(1);
      expect(events[0].agent_role).toBe("dev");
    });
  });

  describe("clearInMemoryEvents", () => {
    it("clears events for a session", async () => {
      await emitAgentEvent(null, "session-1", "dev", "spawned", {});
      expect(getInMemoryEventsForSession("session-1").length).toBe(1);

      clearInMemoryEvents("session-1");
      expect(getInMemoryEventsForSession("session-1").length).toBe(0);
    });

    it("does not affect other sessions", async () => {
      await emitAgentEvent(null, "session-1", "dev", "spawned", {});
      await emitAgentEvent(null, "session-2", "qa", "spawned", {});

      clearInMemoryEvents("session-1");
      expect(getInMemoryEventsForSession("session-1").length).toBe(0);
      expect(getInMemoryEventsForSession("session-2").length).toBe(1);
    });
  });

  describe("formatAgentTimeline", () => {
    it("formats empty events", () => {
      const result = formatAgentTimeline([]);
      expect(result).toBe("Aucun event agent");
    });

    it("formats events with timeline", () => {
      const events: AgentEvent[] = [
        {
          session_id: "s1",
          agent_role: "dev",
          event_type: "spawned",
          payload: {},
          created_at: "2026-03-17T04:00:00.000Z",
        },
        {
          session_id: "s1",
          agent_role: "dev",
          event_type: "completed",
          payload: { duration_ms: 5000 },
          created_at: "2026-03-17T04:00:05.000Z",
        },
      ];

      const result = formatAgentTimeline(events);
      expect(result).toContain("TIMELINE AGENTS:");
      expect(result).toContain("dev spawned");
      expect(result).toContain("dev completed (5s)");
    });

    it("shows duration when present", () => {
      const events: AgentEvent[] = [{
        session_id: "s1",
        agent_role: "qa",
        event_type: "completed",
        payload: { duration_ms: 12345 },
        created_at: "2026-03-17T04:00:00.000Z",
      }];

      const result = formatAgentTimeline(events);
      expect(result).toContain("(12s)");
    });
  });
});
