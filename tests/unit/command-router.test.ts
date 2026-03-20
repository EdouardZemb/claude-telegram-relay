import { describe, it, expect } from "bun:test";
import {
  routeIntent,
  checkPendingClarification,
  handleConfirmationCallback,
} from "../../src/command-router.ts";
import type { DetectedIntent } from "../../src/intent-detection.ts";
import { getAction } from "../../src/action-registry.ts";

// ── Mock Grammy Context ──────────────────────────────────────

function createMockCtx(overrides: Record<string, any> = {}) {
  const replies: string[] = [];
  const replyMarkups: any[] = [];

  return {
    ctx: {
      chat: { id: overrides.chatId ?? 123 },
      message: {
        text: overrides.text || "test",
        message_thread_id: overrides.threadId,
        message_id: 1,
      },
      callbackQuery: overrides.callbackQuery,
      reply: async (text: string, opts?: any) => {
        replies.push(text);
        if (opts?.reply_markup) replyMarkups.push(opts.reply_markup);
      },
      answerCallbackQuery: async () => {},
      editMessageText: async () => {},
    },
    replies,
    replyMarkups,
  };
}

// Fake supabase that returns empty results
const fakeSupa = {
  from: () => ({
    select: () => ({
      eq: () => ({
        order: () => ({
          limit: () => Promise.resolve({ data: [] }),
        }),
      }),
      neq: () => ({
        order: () => ({
          limit: () => Promise.resolve({ data: [] }),
        }),
      }),
      not: () => ({
        order: () => ({
          limit: () => Promise.resolve({ data: [] }),
        }),
      }),
    }),
  }),
} as any;

function createRouterCtx(supabase: any = fakeSupa) {
  const dispatched: string[] = [];
  return {
    rctx: {
      supabase,
      getThreadId: (ctx: any) => ctx.message?.message_thread_id,
      threadOpts: (ctx: any) => {
        const threadId = ctx.message?.message_thread_id;
        return threadId ? { message_thread_id: threadId } : {};
      },
      dispatchCommand: async (_ctx: any, command: string) => {
        dispatched.push(command);
      },
    },
    dispatched,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("command-router", () => {
  describe("routeIntent — low risk (no supabase needed)", () => {
    it("routes low-risk action via dispatchCommand", async () => {
      const { ctx, replies } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "get_help",
        command: "help",
        confidence: 0.9,
        action: getAction("help"),
        source: "regex",
      };

      const { rctx, dispatched } = createRouterCtx();
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      expect(replies.some((r) => r.includes("/help"))).toBe(true);
      expect(dispatched).toContain("/help");
    });

    it("routes low-risk action (backlog) with supabase", async () => {
      const { ctx, replies } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "view_backlog",
        command: "backlog",
        confidence: 0.9,
        action: getAction("backlog"),
        source: "regex",
      };

      const { rctx, dispatched } = createRouterCtx();
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      expect(replies.some((r) => r.includes("/backlog"))).toBe(true);
      expect(dispatched).toContain("/backlog");
    });
  });

  describe("routeIntent — high risk", () => {
    it("sends confirmation for high-risk action with args", async () => {
      const { ctx, replies, replyMarkups } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "execute_task",
        command: "exec",
        confidence: 0.9,
        args: "abc123",
        action: getAction("exec"),
        source: "regex",
      };

      const { rctx } = createRouterCtx();
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      expect(result.pendingAction).toBe("exec");
      expect(replies.some((r) => r.includes("Confirmer"))).toBe(true);
      expect(replyMarkups.length).toBeGreaterThan(0);
    });

    it("sends confirmation for rollback", async () => {
      const { ctx, replies } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "rollback",
        command: "rollback",
        confidence: 0.9,
        action: getAction("rollback"),
        source: "regex",
      };

      const { rctx } = createRouterCtx();
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      expect(replies.some((r) => r.includes("/rollback"))).toBe(true);
    });
  });

  describe("routeIntent — missing required params", () => {
    it("asks clarification when taskId is missing and cannot be resolved", async () => {
      const { ctx, replies } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "execute_task",
        command: "exec",
        confidence: 0.9,
        // No args — taskId missing
        action: getAction("exec"),
        source: "regex",
      };

      const { rctx } = createRouterCtx();
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      expect(replies.some((r) => r.includes("tache"))).toBe(true);
    });

    it("asks clarification when title is missing for /task", async () => {
      const { ctx, replies } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "create_task",
        command: "task",
        confidence: 0.9,
        action: getAction("task"),
        source: "regex",
      };

      const { rctx } = createRouterCtx();
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      expect(replies.some((r) => r.includes("titre"))).toBe(true);
    });
  });

  describe("routeIntent — medium risk with args", () => {
    it("dispatches medium-risk action with args", async () => {
      const { ctx, replies } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "create_task",
        command: "task",
        confidence: 0.9,
        args: "Refactorer le module",
        action: getAction("task"),
        source: "regex",
      };

      const { rctx, dispatched } = createRouterCtx();
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      expect(replies.some((r) => r.includes("/task Refactorer le module"))).toBe(true);
      expect(dispatched).toContain("/task Refactorer le module");
    });
  });

  describe("routeIntent — Supabase requirement", () => {
    it("returns unhandled when Supabase required but not available", async () => {
      const { ctx } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "view_backlog",
        command: "backlog",
        confidence: 0.9,
        action: getAction("backlog"),
        source: "regex",
      };

      const { rctx } = createRouterCtx(null);
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(false);
    });
  });

  describe("checkPendingClarification", () => {
    it("returns null when no pending clarification", () => {
      const { ctx } = createMockCtx({ chatId: 900 });
      expect(checkPendingClarification(ctx as any, "abc123")).toBeNull();
    });

    it("returns command after clarification was set by routeIntent", async () => {
      const { ctx } = createMockCtx({ chatId: 901 });
      const intent: DetectedIntent = {
        intent: "execute_task",
        command: "exec",
        confidence: 0.9,
        action: getAction("exec"),
        source: "regex",
      };
      const { rctx } = createRouterCtx();
      await routeIntent(ctx as any, intent, rctx);

      const cmd = checkPendingClarification(ctx as any, "abc123");
      expect(cmd).toBe("/exec abc123");
    });

    it("clears clarification after consumption", async () => {
      const { ctx } = createMockCtx({ chatId: 902 });
      const intent: DetectedIntent = {
        intent: "create_task",
        command: "task",
        confidence: 0.9,
        action: getAction("task"),
        source: "regex",
      };
      const { rctx: rctx2 } = createRouterCtx();
      await routeIntent(ctx as any, intent, rctx2);

      const cmd = checkPendingClarification(ctx as any, "mon titre");
      expect(cmd).toBe("/task mon titre");

      const cmd2 = checkPendingClarification(ctx as any, "autre chose");
      expect(cmd2).toBeNull();
    });
  });

  describe("routeIntent — resume pipeline", () => {
    it("resolves task from last failed pipeline run", async () => {
      const mockSupa = {
        from: (table: string) => {
          if (table === "pipeline_runs") {
            return {
              select: () => ({
                in: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({
                      data: [{ task_id: "abcd1234-5678-9abc-def0-1234567890ab", session_id: "sess-123" }],
                    }),
                  }),
                }),
              }),
            };
          }
          return fakeSupa.from(table);
        },
      } as any;

      const { ctx, replies } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "resume_pipeline",
        command: "orchestrate",
        confidence: 0.9,
        args: "--resume",
        action: getAction("orchestrate"),
        source: "regex",
      };

      const { rctx } = createRouterCtx(mockSupa);
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      // Should be high-risk confirmation with resolved task ID
      expect(result.pendingAction).toBe("orchestrate");
      expect(replies.some((r) => r.includes("abcd1234") && r.includes("--resume"))).toBe(true);
    });

    it("returns error when no failed pipeline found", async () => {
      const mockSupa = {
        from: (table: string) => {
          if (table === "pipeline_runs") {
            return {
              select: () => ({
                in: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [] }),
                  }),
                }),
              }),
            };
          }
          return fakeSupa.from(table);
        },
      } as any;

      const { ctx, replies } = createMockCtx();
      const intent: DetectedIntent = {
        intent: "resume_pipeline",
        command: "orchestrate",
        confidence: 0.9,
        args: "--resume",
        action: getAction("orchestrate"),
        source: "regex",
      };

      const { rctx } = createRouterCtx(mockSupa);
      const result = await routeIntent(ctx as any, intent, rctx);
      expect(result.handled).toBe(true);
      expect(replies.some((r) => r.includes("Aucun pipeline"))).toBe(true);
    });
  });

  describe("handleConfirmationCallback", () => {
    it("returns null for intent_cancel", () => {
      const { ctx } = createMockCtx({
        chatId: 910,
        callbackQuery: { message: { chat: { id: 910 } } },
      });
      const result = handleConfirmationCallback(ctx as any, "intent_cancel");
      expect(result).toBeNull();
    });

    it("returns null for expired/missing confirmation", () => {
      const { ctx } = createMockCtx({
        chatId: 911,
        callbackQuery: { message: { chat: { id: 911 } } },
      });
      const result = handleConfirmationCallback(ctx as any, "intent_confirm:exec");
      expect(result).toBeNull();
    });

    it("returns command after confirmation was set by routeIntent", async () => {
      // First, trigger a confirmation for high-risk action
      const { ctx } = createMockCtx({ chatId: 912 });
      const intent: DetectedIntent = {
        intent: "execute_task",
        command: "exec",
        confidence: 0.9,
        args: "abc123",
        action: getAction("exec"),
        source: "regex",
      };
      const { rctx: rctx3 } = createRouterCtx();
      await routeIntent(ctx as any, intent, rctx3);

      // Now simulate callback from same chat
      const cbCtx = createMockCtx({
        chatId: 912,
        callbackQuery: { message: { chat: { id: 912 } } },
      });
      const result = handleConfirmationCallback(cbCtx.ctx as any, "intent_confirm:exec");
      expect(result).toBe("/exec abc123");
    });
  });
});
