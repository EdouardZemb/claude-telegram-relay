import { describe, it, expect, beforeEach } from "bun:test";
import {
  getSession,
  hasActiveSession,
  addMessage,
  addIntent,
  addConstraint,
  addDecision,
  setActiveTask,
  extractConstraints,
  formatSessionForIntent,
  buildConversationContext,
  cleanupExpiredSessions,
  getActiveSessionCount,
  _resetSessions,
  type ConversationSession,
} from "../../src/conversation-session.ts";

describe("conversation-session", () => {
  beforeEach(() => {
    _resetSessions();
  });

  // ── Session Lifecycle ─────────────────────────────────────

  describe("getSession", () => {
    it("creates a new session for unknown chat", () => {
      const session = getSession(12345);
      expect(session.chatId).toBe(12345);
      expect(session.phase).toBe("discovery");
      expect(session.intents).toEqual([]);
      expect(session.constraints).toEqual([]);
      expect(session.decisions).toEqual([]);
      expect(session.recentMessages).toEqual([]);
    });

    it("returns same session for same chat", () => {
      const s1 = getSession(12345);
      const s2 = getSession(12345);
      expect(s1.id).toBe(s2.id);
    });

    it("creates separate sessions for different chats", () => {
      const s1 = getSession(111);
      const s2 = getSession(222);
      expect(s1.id).not.toBe(s2.id);
    });

    it("creates separate sessions for different threads in same chat", () => {
      const s1 = getSession(111, 1);
      const s2 = getSession(111, 2);
      expect(s1.id).not.toBe(s2.id);
    });

    it("session without thread is separate from session with thread", () => {
      const s1 = getSession(111);
      const s2 = getSession(111, 5);
      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe("hasActiveSession", () => {
    it("returns false for unknown chat", () => {
      expect(hasActiveSession(99999)).toBe(false);
    });

    it("returns true after session created", () => {
      getSession(12345);
      expect(hasActiveSession(12345)).toBe(true);
    });
  });

  // ── Session Mutations ─────────────────────────────────────

  describe("addMessage", () => {
    it("adds messages to session", () => {
      const session = getSession(1);
      addMessage(session, "hello");
      addMessage(session, "world");
      expect(session.recentMessages).toEqual(["hello", "world"]);
    });

    it("keeps only last 5 messages", () => {
      const session = getSession(1);
      for (let i = 0; i < 7; i++) {
        addMessage(session, `msg${i}`);
      }
      expect(session.recentMessages).toHaveLength(5);
      expect(session.recentMessages[0]).toBe("msg2");
      expect(session.recentMessages[4]).toBe("msg6");
    });
  });

  describe("addIntent", () => {
    it("records intent with metadata", () => {
      const session = getSession(1);
      addIntent(session, "view_backlog", "backlog", 0.9, true);
      expect(session.intents).toHaveLength(1);
      expect(session.intents[0].command).toBe("backlog");
      expect(session.intents[0].executed).toBe(true);
    });

    it("limits intents to 20", () => {
      const session = getSession(1);
      for (let i = 0; i < 25; i++) {
        addIntent(session, `intent_${i}`, `cmd${i}`, 0.8, true);
      }
      expect(session.intents).toHaveLength(20);
    });

    it("transitions phase to planning on plan command", () => {
      const session = getSession(1);
      expect(session.phase).toBe("discovery");
      addIntent(session, "plan_task", "plan", 0.9, true);
      expect(session.phase).toBe("planning");
    });

    it("transitions phase to execution on exec command", () => {
      const session = getSession(1);
      addIntent(session, "execute_task", "exec", 0.9, true);
      expect(session.phase).toBe("execution");
    });

    it("transitions phase to closure on done command", () => {
      const session = getSession(1);
      addIntent(session, "done_task", "done", 0.9, true);
      expect(session.phase).toBe("closure");
    });

    it("does not transition phase for non-executed intents", () => {
      const session = getSession(1);
      addIntent(session, "execute_task", "exec", 0.9, false);
      expect(session.phase).toBe("discovery");
    });
  });

  describe("addConstraint", () => {
    it("adds a constraint", () => {
      const session = getSession(1);
      addConstraint(session, "speed", "fast", "je veux vite");
      expect(session.constraints).toHaveLength(1);
      expect(session.constraints[0].type).toBe("speed");
      expect(session.constraints[0].value).toBe("fast");
    });

    it("replaces existing constraint of same type", () => {
      const session = getSession(1);
      addConstraint(session, "speed", "fast", "msg1");
      addConstraint(session, "speed", "very fast", "msg2");
      expect(session.constraints).toHaveLength(1);
      expect(session.constraints[0].value).toBe("very fast");
    });

    it("keeps constraints of different types", () => {
      const session = getSession(1);
      addConstraint(session, "speed", "fast", "msg1");
      addConstraint(session, "quality", "high", "msg2");
      expect(session.constraints).toHaveLength(2);
    });
  });

  describe("addDecision", () => {
    it("records a decision", () => {
      const session = getSession(1);
      addDecision(session, "utiliser pipeline quick");
      expect(session.decisions).toHaveLength(1);
      expect(session.decisions[0].description).toBe("utiliser pipeline quick");
    });
  });

  describe("setActiveTask", () => {
    it("sets active task ID", () => {
      const session = getSession(1);
      setActiveTask(session, "abc123");
      expect(session.activeTaskId).toBe("abc123");
    });
  });

  // ── Constraint Extraction ─────────────────────────────────

  describe("extractConstraints", () => {
    it("detects speed constraint", () => {
      const constraints = extractConstraints("fais ca vite stp");
      expect(constraints.some((c) => c.type === "speed")).toBe(true);
    });

    it("detects quality constraint", () => {
      const constraints = extractConstraints("je veux un truc bien fait et robuste");
      expect(constraints.some((c) => c.type === "quality")).toBe(true);
    });

    it("detects budget constraint", () => {
      const constraints = extractConstraints("pas cher si possible");
      expect(constraints.some((c) => c.type === "budget")).toBe(true);
    });

    it("detects scope constraint", () => {
      const constraints = extractConstraints("juste le minimum");
      expect(constraints.some((c) => c.type === "scope")).toBe(true);
    });

    it("detects deadline constraint", () => {
      const constraints = extractConstraints("il me faut ca avant vendredi");
      expect(constraints.some((c) => c.type === "deadline")).toBe(true);
    });

    it("detects multiple constraints", () => {
      const constraints = extractConstraints("fais ca vite et pas cher");
      expect(constraints.length).toBeGreaterThanOrEqual(2);
      const types = constraints.map((c) => c.type);
      expect(types).toContain("speed");
      expect(types).toContain("budget");
    });

    it("returns empty for normal message", () => {
      const constraints = extractConstraints("comment va le sprint ?");
      expect(constraints).toEqual([]);
    });
  });

  // ── Context Formatting ────────────────────────────────────

  describe("formatSessionForIntent", () => {
    it("includes phase", () => {
      const session = getSession(1);
      const formatted = formatSessionForIntent(session);
      expect(formatted).toContain("Phase: discovery");
    });

    it("includes recent intents", () => {
      const session = getSession(1);
      addIntent(session, "view_backlog", "backlog", 0.9, true);
      const formatted = formatSessionForIntent(session);
      expect(formatted).toContain("/backlog");
    });

    it("includes constraints", () => {
      const session = getSession(1);
      addConstraint(session, "speed", "fast", "msg");
      const formatted = formatSessionForIntent(session);
      expect(formatted).toContain("speed=fast");
    });

    it("includes active task", () => {
      const session = getSession(1);
      setActiveTask(session, "abc12345");
      const formatted = formatSessionForIntent(session);
      expect(formatted).toContain("abc12345");
    });
  });

  describe("buildConversationContext", () => {
    it("returns empty for empty session", () => {
      const session = getSession(1);
      const ctx = buildConversationContext(session);
      expect(ctx).toBe("");
    });

    it("includes recent messages", () => {
      const session = getSession(1);
      addMessage(session, "je veux refactorer le module auth");
      const ctx = buildConversationContext(session);
      expect(ctx).toContain("refactorer le module auth");
      expect(ctx).toContain("Messages recents");
    });

    it("includes constraints", () => {
      const session = getSession(1);
      addConstraint(session, "quality", "high", "msg");
      const ctx = buildConversationContext(session);
      expect(ctx).toContain("Qualite: high");
    });

    it("includes decisions", () => {
      const session = getSession(1);
      addDecision(session, "on part sur pipeline quick");
      const ctx = buildConversationContext(session);
      expect(ctx).toContain("on part sur pipeline quick");
    });

    it("includes executed intents", () => {
      const session = getSession(1);
      addIntent(session, "view_backlog", "backlog", 0.9, true);
      addIntent(session, "get_help", "help", 0.8, false);
      const ctx = buildConversationContext(session);
      expect(ctx).toContain("/backlog");
      expect(ctx).not.toContain("/help");
    });
  });

  // ── Cleanup ───────────────────────────────────────────────

  describe("cleanupExpiredSessions", () => {
    it("does not clean active sessions", () => {
      getSession(1);
      getSession(2);
      const cleaned = cleanupExpiredSessions();
      expect(cleaned).toBe(0);
      expect(getActiveSessionCount()).toBe(2);
    });
  });

  describe("getActiveSessionCount", () => {
    it("counts sessions", () => {
      expect(getActiveSessionCount()).toBe(0);
      getSession(1);
      expect(getActiveSessionCount()).toBe(1);
      getSession(2);
      expect(getActiveSessionCount()).toBe(2);
    });
  });

  // ── Integration ───────────────────────────────────────────

  describe("full session flow", () => {
    it("tracks a complete conversation flow", () => {
      const session = getSession(100, 5);

      // User starts exploring
      addMessage(session, "je veux refactorer le module auth");
      expect(session.phase).toBe("discovery");

      // Constraints extracted
      const constraints = extractConstraints("fais ca bien fait et avant vendredi");
      for (const c of constraints) {
        addConstraint(session, c.type, c.value, c.source);
      }
      expect(session.constraints.length).toBeGreaterThanOrEqual(1);

      // User plans
      addIntent(session, "plan_task", "plan", 0.9, true);
      expect(session.phase).toBe("planning");

      // Decision recorded
      addDecision(session, "utiliser pipeline full pour plus de robustesse");

      // User launches execution
      addIntent(session, "execute_task", "exec", 0.9, true);
      expect(session.phase).toBe("execution");

      // Task linked
      setActiveTask(session, "abc123def456");

      // Build context for agents
      const agentCtx = buildConversationContext(session);
      expect(agentCtx).toContain("refactorer le module auth");
      expect(agentCtx).toContain("pipeline full");
      expect(agentCtx).toContain("/exec");

      // Build compact context for intent detection
      const intentCtx = formatSessionForIntent(session);
      expect(intentCtx).toContain("Phase: execution");
      expect(intentCtx).toContain("abc123de");
    });
  });
});
