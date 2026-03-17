import { describe, it, expect, beforeEach } from "bun:test";
import { detectIntentWithLLM } from "../../src/intent-detection.ts";
import {
  getSession,
  addMessage,
  addIntent,
  addConstraint,
  formatSessionForIntent,
  buildConversationContext,
  extractConstraints,
  _resetSessions,
} from "../../src/conversation-session.ts";

describe("session-integration", () => {
  beforeEach(() => {
    _resetSessions();
  });

  describe("intent detection with session context", () => {
    it("passes session context to LLM prompt", async () => {
      let capturedPrompt = "";
      const session = getSession(1);
      addIntent(session, "view_backlog", "backlog", 0.9, true);
      addConstraint(session, "speed", "fast", "msg");

      const sessionCtx = formatSessionForIntent(session);

      const result = await detectIntentWithLLM("lance le pipeline", {
        callLLM: async (prompt) => {
          capturedPrompt = prompt;
          return '{"command": "exec", "args": "", "confidence": 0.85}';
        },
        sessionContext: sessionCtx,
      });

      // Verify session context was included in prompt
      expect(capturedPrompt).toContain("CONTEXTE SESSION:");
      expect(capturedPrompt).toContain("/backlog");
      expect(capturedPrompt).toContain("speed=fast");
    });

    it("works without session context (backward compatible)", async () => {
      const result = await detectIntentWithLLM("montre le backlog", {
        callLLM: async () => '{"command": "backlog", "args": "", "confidence": 0.9}',
      });

      expect(result.detected).not.toBeNull();
      // Regex picks it up at >= 0.9, so LLM never called
      expect(result.detected!.command).toBe("backlog");
    });
  });

  describe("conversation context for agents", () => {
    it("builds complete context for agent", () => {
      const session = getSession(100);
      addMessage(session, "je veux ajouter un cache redis");
      addMessage(session, "ca doit etre rapide");
      addConstraint(session, "speed", "fast", "ca doit etre rapide");
      addIntent(session, "plan_task", "plan", 0.9, true);

      const ctx = buildConversationContext(session);

      expect(ctx).toContain("ajouter un cache redis");
      expect(ctx).toContain("Vitesse: fast");
      expect(ctx).toContain("/plan");
    });

    it("empty context for fresh session", () => {
      const session = getSession(200);
      const ctx = buildConversationContext(session);
      expect(ctx).toBe("");
    });
  });

  describe("constraint extraction in conversation flow", () => {
    it("accumulates constraints over multiple messages", () => {
      const session = getSession(1);

      const c1 = extractConstraints("fais ca vite");
      for (const c of c1) addConstraint(session, c.type, c.value, c.source);

      const c2 = extractConstraints("et bien fait");
      for (const c of c2) addConstraint(session, c.type, c.value, c.source);

      expect(session.constraints.length).toBeGreaterThanOrEqual(2);
      const types = session.constraints.map((c) => c.type);
      expect(types).toContain("speed");
      expect(types).toContain("quality");
    });

    it("latest constraint of same type wins", () => {
      const session = getSession(1);
      addConstraint(session, "speed", "fast", "msg1");
      addConstraint(session, "speed", "not urgent actually", "msg2");
      expect(session.constraints.filter((c) => c.type === "speed")).toHaveLength(1);
      expect(session.constraints.find((c) => c.type === "speed")!.value).toBe("not urgent actually");
    });
  });

  describe("phase transitions", () => {
    it("follows discovery -> planning -> execution -> closure", () => {
      const session = getSession(1);
      expect(session.phase).toBe("discovery");

      addIntent(session, "plan_task", "plan", 0.9, true);
      expect(session.phase).toBe("planning");

      addIntent(session, "execute_task", "exec", 0.9, true);
      expect(session.phase).toBe("execution");

      addIntent(session, "done_task", "done", 0.9, true);
      expect(session.phase).toBe("closure");
    });

    it("can jump directly to execution", () => {
      const session = getSession(1);
      addIntent(session, "execute_task", "exec", 0.9, true);
      expect(session.phase).toBe("execution");
    });

    it("viewing backlog stays in discovery", () => {
      const session = getSession(1);
      addIntent(session, "view_backlog", "backlog", 0.9, true);
      expect(session.phase).toBe("discovery");
    });
  });
});
