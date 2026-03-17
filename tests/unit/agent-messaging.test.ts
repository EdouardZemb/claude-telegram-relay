/**
 * Tests for agent-messaging.ts — S38 FR-002..FR-006
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  sendAgentMessage,
  getAgentMessages,
  getPendingQuestions,
  resolveQuestion,
  canRequestClarification,
  markClarificationUsed,
  clearClarificationTracker,
  checkPendingClarifications,
  detectConflicts,
  getMediatingAgent,
  buildInterAgentContext,
  getMessageFlowSummary,
  formatMessageFlow,
  jaccardSimilarity,
  type AgentInterMessage,
} from "../../src/agent-messaging.ts";
import type { WorkingMemory } from "../../src/blackboard.ts";
import { createMockSupabase } from "../fixtures/mock-supabase.ts";

describe("agent-messaging", () => {
  let supabase: any;
  const sessionId = "bb-test-001";

  function initBlackboard(sb: any, sid: string, version: number = 1, messages: any = null) {
    // Ensure table exists in store before pushing
    if (!sb._store.blackboard) sb._store.blackboard = [];
    sb._store.blackboard.push({
      id: crypto.randomUUID(),
      session_id: sid,
      version,
      sections: {
        spec: null, plan: null, tasks: null, implementation: null,
        verification: null, working_memory: null, messages,
      },
      history: [],
      status: "active",
    });
  }

  beforeEach(() => {
    supabase = createMockSupabase();
    clearClarificationTracker(sessionId);
    initBlackboard(supabase, sessionId);
  });

  // ── FR-002: Canal de messages inter-agents ─────────────────

  describe("sendAgentMessage", () => {
    // AC-007: sendAgentMessage writes with optimistic locking
    it("sends a message to the blackboard messages section", async () => {
      const msg: AgentInterMessage = {
        id: "msg-1",
        from: "architect",
        to: "dev",
        type: "directive",
        content: "Use Observer pattern",
        timestamp: new Date().toISOString(),
      };

      const result = await sendAgentMessage(supabase, sessionId, msg, 1);
      expect(result.success).toBe(true);

      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      expect(bb.sections.messages.messages.length).toBe(1);
      expect(bb.sections.messages.messages[0].content).toBe("Use Observer pattern");
    });

    it("returns error when supabase is null", async () => {
      const msg: AgentInterMessage = {
        id: "msg-1", from: "dev", to: "qa", type: "observation",
        content: "test", timestamp: new Date().toISOString(),
      };

      const result = await sendAgentMessage(null, sessionId, msg, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe("No supabase");
    });

    // AC-011: Messages sorted by timestamp
    it("preserves message order by timestamp", async () => {
      const msg1: AgentInterMessage = {
        id: "msg-1", from: "analyst", to: "*", type: "observation",
        content: "First", timestamp: "2026-03-17T01:00:00Z",
      };
      const msg2: AgentInterMessage = {
        id: "msg-2", from: "pm", to: "*", type: "observation",
        content: "Second", timestamp: "2026-03-17T02:00:00Z",
      };

      await sendAgentMessage(supabase, sessionId, msg1, 1);
      await sendAgentMessage(supabase, sessionId, msg2, 2);

      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      expect(bb.sections.messages.messages[0].content).toBe("First");
      expect(bb.sections.messages.messages[1].content).toBe("Second");
    });

    // AC-010: All roles can write messages
    it("allows all roles to send messages", async () => {
      const roles = ["analyst", "pm", "architect", "dev", "qa", "sm"];
      let version = 1;

      for (const role of roles) {
        const msg: AgentInterMessage = {
          id: `msg-${role}`, from: role, to: "*", type: "observation",
          content: `From ${role}`, timestamp: new Date().toISOString(),
        };
        const result = await sendAgentMessage(supabase, sessionId, msg, version);
        expect(result.success).toBe(true);
        version = result.newVersion;
      }

      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      expect(bb.sections.messages.messages.length).toBe(6);
    });
  });

  // AC-008: getAgentMessages filters by recipient
  describe("getAgentMessages", () => {
    beforeEach(async () => {
      // Pre-populate messages
      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      bb.sections.messages = {
        messages: [
          { id: "m1", from: "architect", to: "dev", type: "directive", content: "Use X", timestamp: "2026-03-17T01:00:00Z" },
          { id: "m2", from: "pm", to: "*", type: "observation", content: "Priority change", timestamp: "2026-03-17T02:00:00Z" },
          { id: "m3", from: "qa", to: "dev", type: "warning", content: "Missing tests", timestamp: "2026-03-17T03:00:00Z" },
          { id: "m4", from: "dev", to: "architect", type: "question", content: "What about Y?", timestamp: "2026-03-17T04:00:00Z" },
        ],
      };
    });

    it("returns messages addressed to a specific role", async () => {
      const messages = await getAgentMessages(supabase, sessionId, "dev");
      expect(messages.length).toBe(3); // m1 (to dev) + m2 (broadcast) + m3 (to dev)
    });

    it("includes broadcast messages", async () => {
      const messages = await getAgentMessages(supabase, sessionId, "architect");
      expect(messages.length).toBe(2); // m2 (broadcast) + m4 (to architect)
    });

    it("returns empty for supabase null", async () => {
      const messages = await getAgentMessages(null, sessionId, "dev");
      expect(messages.length).toBe(0);
    });

    it("returns messages sorted by timestamp", async () => {
      const messages = await getAgentMessages(supabase, sessionId, "dev");
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i].timestamp >= messages[i - 1].timestamp).toBe(true);
      }
    });
  });

  // ── FR-003: Clarification Protocol ─────────────────────────

  describe("getPendingQuestions", () => {
    it("returns unresolved questions for a role", async () => {
      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      bb.sections.messages = {
        messages: [
          { id: "q1", from: "dev", to: "architect", type: "question", content: "How?", timestamp: "2026-03-17T01:00:00Z", resolved: false },
          { id: "q2", from: "qa", to: "architect", type: "question", content: "Why?", timestamp: "2026-03-17T02:00:00Z", resolved: true },
          { id: "d1", from: "pm", to: "architect", type: "directive", content: "Do X", timestamp: "2026-03-17T03:00:00Z" },
        ],
      };

      const pending = await getPendingQuestions(supabase, sessionId, "architect");
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe("q1");
    });

    it("returns empty when no unresolved questions", async () => {
      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      bb.sections.messages = {
        messages: [
          { id: "q1", from: "dev", to: "architect", type: "question", content: "How?", timestamp: "2026-03-17T01:00:00Z", resolved: true },
        ],
      };

      const pending = await getPendingQuestions(supabase, sessionId, "architect");
      expect(pending.length).toBe(0);
    });
  });

  describe("resolveQuestion", () => {
    // AC-015: Response written and question marked resolved
    it("marks question as resolved and adds response", async () => {
      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      bb.sections.messages = {
        messages: [
          { id: "q1", from: "dev", to: "architect", type: "question", content: "How to handle errors?", timestamp: "2026-03-17T01:00:00Z", resolved: false },
        ],
      };

      const response: AgentInterMessage = {
        id: "r1", from: "architect", to: "dev", type: "directive",
        content: "Use try-catch with custom error types",
        timestamp: "2026-03-17T02:00:00Z",
      };

      const result = await resolveQuestion(supabase, sessionId, "q1", response, 1);
      expect(result.success).toBe(true);

      const updated = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      const msgs = updated.sections.messages.messages;
      expect(msgs[0].resolved).toBe(true);
      expect(msgs[1].correlationId).toBe("q1");
      expect(msgs[1].content).toBe("Use try-catch with custom error types");
    });

    it("returns error when no messages section exists", async () => {
      const response: AgentInterMessage = {
        id: "r1", from: "architect", to: "dev", type: "directive",
        content: "answer", timestamp: new Date().toISOString(),
      };
      const result = await resolveQuestion(supabase, sessionId, "q-nonexistent", response, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe("No messages");
    });
  });

  // AC-016: Max 1 round-trip per agent pair
  describe("clarification guards", () => {
    it("allows first clarification between two agents", () => {
      expect(canRequestClarification(sessionId, "dev", "architect")).toBe(true);
    });

    it("blocks second clarification between same pair", () => {
      markClarificationUsed(sessionId, "dev", "architect");
      expect(canRequestClarification(sessionId, "dev", "architect")).toBe(false);
    });

    it("allows clarification between different pairs", () => {
      markClarificationUsed(sessionId, "dev", "architect");
      expect(canRequestClarification(sessionId, "qa", "architect")).toBe(true);
    });

    it("clears tracker on cleanup", () => {
      markClarificationUsed(sessionId, "dev", "architect");
      clearClarificationTracker(sessionId);
      expect(canRequestClarification(sessionId, "dev", "architect")).toBe(true);
    });
  });

  describe("checkPendingClarifications", () => {
    // AC-013: Supervisor detects unresolved questions
    it("finds unresolved questions across all agents", async () => {
      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      bb.sections.messages = {
        messages: [
          { id: "q1", from: "dev", to: "architect", type: "question", content: "Q1", timestamp: "2026-03-17T01:00:00Z", resolved: false },
          { id: "q2", from: "qa", to: "pm", type: "question", content: "Q2", timestamp: "2026-03-17T02:00:00Z", resolved: true },
          { id: "q3", from: "dev", to: "pm", type: "question", content: "Q3", timestamp: "2026-03-17T03:00:00Z", resolved: false },
        ],
      };

      const pending = await checkPendingClarifications(supabase, sessionId);
      expect(pending.length).toBe(2);
    });

    it("returns empty when supabase is null", async () => {
      const pending = await checkPendingClarifications(null, sessionId);
      expect(pending.length).toBe(0);
    });
  });

  // ── FR-004: Conflict Detection ─────────────────────────────

  describe("detectConflicts", () => {
    // AC-019: Conflicts detected by lexical overlap
    it("detects conflicts when decisions overlap with different reasoning", () => {
      const wm: WorkingMemory = {
        decisions: [
          { agent: "architect", decision: "use REST API for data access layer", reasoning: "REST is simpler and well-understood" },
          { agent: "dev", decision: "use REST API for data access layer", reasoning: "GraphQL would be more efficient for this use case" },
        ],
        discoveries: [],
        blockers: [],
        context_updates: [],
      };

      const conflicts = detectConflicts(wm);
      expect(conflicts.length).toBe(1);
      expect(conflicts[0].agent1).toBe("architect");
      expect(conflicts[0].agent2).toBe("dev");
    });

    it("does not flag when same agent has multiple decisions", () => {
      const wm: WorkingMemory = {
        decisions: [
          { agent: "architect", decision: "use REST API", reasoning: "simple" },
          { agent: "architect", decision: "use REST API v2", reasoning: "updated" },
        ],
        discoveries: [],
        blockers: [],
        context_updates: [],
      };

      const conflicts = detectConflicts(wm);
      expect(conflicts.length).toBe(0);
    });

    it("returns empty for null working memory", () => {
      const conflicts = detectConflicts(null);
      expect(conflicts.length).toBe(0);
    });

    it("returns empty for single decision", () => {
      const wm: WorkingMemory = {
        decisions: [
          { agent: "dev", decision: "test", reasoning: "reason" },
        ],
        discoveries: [],
        blockers: [],
        context_updates: [],
      };

      const conflicts = detectConflicts(wm);
      expect(conflicts.length).toBe(0);
    });

    it("ignores decisions with low lexical overlap", () => {
      const wm: WorkingMemory = {
        decisions: [
          { agent: "architect", decision: "use microservice architecture", reasoning: "scalability" },
          { agent: "dev", decision: "implement caching layer", reasoning: "performance" },
        ],
        discoveries: [],
        blockers: [],
        context_updates: [],
      };

      const conflicts = detectConflicts(wm);
      expect(conflicts.length).toBe(0);
    });
  });

  describe("jaccardSimilarity", () => {
    it("returns 1 for identical strings", () => {
      expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
    });

    it("returns 0 for completely different strings", () => {
      expect(jaccardSimilarity("hello world", "foo bar baz")).toBe(0);
    });

    it("returns value between 0 and 1 for partial overlap", () => {
      const sim = jaccardSimilarity("hello world foo", "hello world bar");
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });

    it("handles empty strings", () => {
      expect(jaccardSimilarity("", "")).toBe(1);
      expect(jaccardSimilarity("hello", "")).toBe(0);
      expect(jaccardSimilarity("", "hello")).toBe(0);
    });
  });

  // AC-020: Mediation by higher-ranked agent
  describe("getMediatingAgent", () => {
    it("returns architect when conflict is architect vs dev", () => {
      expect(getMediatingAgent("architect", "dev")).toBe("architect");
    });

    it("returns pm when conflict is pm vs analyst", () => {
      expect(getMediatingAgent("pm", "analyst")).toBe("pm");
    });

    it("returns architect when conflict is architect vs pm", () => {
      expect(getMediatingAgent("architect", "pm")).toBe("architect");
    });

    it("returns first agent when both have same rank", () => {
      expect(getMediatingAgent("dev", "qa")).toBe("dev");
    });
  });

  // ── FR-005: Context Enrichment ─────────────────────────────

  describe("buildInterAgentContext", () => {
    // AC-023: buildStructuredChainContext includes inter-agent messages
    it("builds context string from messages", () => {
      const messages: AgentInterMessage[] = [
        { id: "m1", from: "architect", to: "dev", type: "directive", content: "Use Observer pattern", timestamp: "2026-03-17T01:00:00Z" },
        { id: "m2", from: "qa", to: "dev", type: "warning", content: "Missing error handling", timestamp: "2026-03-17T02:00:00Z" },
      ];

      const ctx = buildInterAgentContext(messages, "dev");
      expect(ctx).toContain("MESSAGES INTER-AGENTS:");
      expect(ctx).toContain("Use Observer pattern");
      expect(ctx).toContain("Missing error handling");
    });

    // AC-024: Messages filtered by recipient
    it("filters messages for the target role", () => {
      const messages: AgentInterMessage[] = [
        { id: "m1", from: "architect", to: "dev", type: "directive", content: "For dev", timestamp: "2026-03-17T01:00:00Z" },
        { id: "m2", from: "pm", to: "qa", type: "directive", content: "For qa", timestamp: "2026-03-17T02:00:00Z" },
        { id: "m3", from: "dev", to: "*", type: "observation", content: "Broadcast", timestamp: "2026-03-17T03:00:00Z" },
      ];

      const ctx = buildInterAgentContext(messages, "dev");
      expect(ctx).toContain("For dev");
      expect(ctx).toContain("Broadcast");
      expect(ctx).not.toContain("For qa");
    });

    it("returns empty for no relevant messages", () => {
      const messages: AgentInterMessage[] = [
        { id: "m1", from: "architect", to: "qa", type: "directive", content: "For qa only", timestamp: "2026-03-17T01:00:00Z" },
      ];

      const ctx = buildInterAgentContext(messages, "dev");
      expect(ctx).toBe("");
    });

    // Priorities: escalation > warning > question > directive > observation
    it("prioritizes warnings and escalations first", () => {
      const messages: AgentInterMessage[] = [
        { id: "m1", from: "pm", to: "dev", type: "observation", content: "Observation text", timestamp: "2026-03-17T01:00:00Z" },
        { id: "m2", from: "qa", to: "dev", type: "warning", content: "Warning text", timestamp: "2026-03-17T02:00:00Z" },
        { id: "m3", from: "architect", to: "dev", type: "escalation", content: "Escalation text", timestamp: "2026-03-17T03:00:00Z" },
      ];

      const ctx = buildInterAgentContext(messages, "dev");
      const lines = ctx.split("\n");
      const escalationIdx = lines.findIndex((l) => l.includes("Escalation text"));
      const warningIdx = lines.findIndex((l) => l.includes("Warning text"));
      const obsIdx = lines.findIndex((l) => l.includes("Observation text"));
      expect(escalationIdx).toBeLessThan(warningIdx);
      expect(warningIdx).toBeLessThan(obsIdx);
    });

    // AC-026: Budget token 2000 max
    it("respects token budget limit", () => {
      const messages: AgentInterMessage[] = [];
      for (let i = 0; i < 50; i++) {
        messages.push({
          id: `m${i}`, from: "pm", to: "dev", type: "observation",
          content: "A".repeat(500), // 500 chars each
          timestamp: `2026-03-17T${String(i).padStart(2, "0")}:00:00Z`,
        });
      }

      const ctx = buildInterAgentContext(messages, "dev");
      // ~2000 tokens * 4 chars = 8000 chars max
      expect(ctx.length).toBeLessThan(10000);
    });

    // AC-025: Questions resolved with response
    it("marks resolved questions", () => {
      const messages: AgentInterMessage[] = [
        { id: "q1", from: "dev", to: "architect", type: "question", content: "How?", timestamp: "2026-03-17T01:00:00Z", resolved: true },
      ];

      const ctx = buildInterAgentContext(messages, "architect");
      expect(ctx).toContain("[RESOLU]");
    });
  });

  // ── FR-006: Monitoring ─────────────────────────────────────

  describe("getMessageFlowSummary", () => {
    it("summarizes message flow", () => {
      const messages: AgentInterMessage[] = [
        { id: "m1", from: "architect", to: "dev", type: "directive", content: "X", timestamp: "2026-03-17T01:00:00Z" },
        { id: "m2", from: "dev", to: "architect", type: "question", content: "Y?", timestamp: "2026-03-17T02:00:00Z", resolved: false },
        { id: "m3", from: "qa", to: "*", type: "warning", content: "Z", timestamp: "2026-03-17T03:00:00Z" },
        { id: "m4", from: "dev", to: "pm", type: "question", content: "W?", timestamp: "2026-03-17T04:00:00Z", resolved: true },
      ];

      const summary = getMessageFlowSummary(messages);
      expect(summary.totalMessages).toBe(4);
      expect(summary.byType.directive).toBe(1);
      expect(summary.byType.question).toBe(2);
      expect(summary.byType.warning).toBe(1);
      expect(summary.clarificationsRequested).toBe(2);
      expect(summary.clarificationsResolved).toBe(1);
    });

    it("handles empty messages", () => {
      const summary = getMessageFlowSummary([]);
      expect(summary.totalMessages).toBe(0);
      expect(summary.clarificationsRequested).toBe(0);
    });
  });

  // AC-029: /monitor displays section pipeline
  describe("formatMessageFlow", () => {
    it("formats summary for display", () => {
      const summary = {
        totalMessages: 5,
        byType: { directive: 2, question: 2, warning: 1 },
        clarificationsRequested: 2,
        clarificationsResolved: 1,
        conflictsDetected: 0,
      };

      const result = formatMessageFlow(summary);
      expect(result).toContain("MESSAGES INTER-AGENTS: 5 total");
      expect(result).toContain("directive: 2");
      expect(result).toContain("Clarifications: 1/2 resolues");
    });

    it("shows minimal info for zero messages", () => {
      const summary = {
        totalMessages: 0,
        byType: {},
        clarificationsRequested: 0,
        clarificationsResolved: 0,
        conflictsDetected: 0,
      };

      const result = formatMessageFlow(summary);
      expect(result).toBe("MESSAGES INTER-AGENTS: 0 total");
    });

    // AC-030: Pipeline metrics with conflict count
    it("shows conflict count when present", () => {
      const summary = {
        totalMessages: 3,
        byType: { escalation: 1 },
        clarificationsRequested: 0,
        clarificationsResolved: 0,
        conflictsDetected: 1,
      };

      const result = formatMessageFlow(summary);
      expect(result).toContain("Conflits detectes: 1");
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────

  // EC-004: Truncate messages > 20
  describe("message truncation", () => {
    it("truncates to 15 most recent when over 20 messages", async () => {
      // Pre-populate with 20 messages
      const bb = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      bb.sections.messages = {
        messages: Array.from({ length: 20 }, (_, i) => ({
          id: `m${i}`, from: "dev", to: "*", type: "observation",
          content: `Msg ${i}`, timestamp: `2026-03-17T${String(i).padStart(2, "0")}:00:00Z`,
        })),
      };

      const msg: AgentInterMessage = {
        id: "m-new", from: "qa", to: "*", type: "observation",
        content: "New message", timestamp: "2026-03-17T21:00:00Z",
      };

      await sendAgentMessage(supabase, sessionId, msg, 1);

      const updated = supabase._store.blackboard.find((r: any) => r.session_id === sessionId);
      // 15 (kept) + 1 (new) = 16
      expect(updated.sections.messages.messages.length).toBe(16);
    });
  });

  // EC-006: Without blackboard, no inter-agent messages
  describe("no blackboard", () => {
    it("returns empty messages when no messages section exists", async () => {
      const emptyBb = createMockSupabase();
      if (!emptyBb._store.blackboard) emptyBb._store.blackboard = [];
      emptyBb._store.blackboard.push({
        id: "bb-2", session_id: "empty-session", version: 1,
        sections: { spec: null, plan: null, tasks: null, implementation: null, verification: null, working_memory: null, messages: null },
        history: [], status: "active",
      });

      const messages = await getAgentMessages(emptyBb, "empty-session", "dev");
      expect(messages.length).toBe(0);
    });
  });
});
