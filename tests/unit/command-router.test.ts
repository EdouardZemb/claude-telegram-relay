/**
 * Unit Tests — command-router: routing helpers extracted from zz-messages.ts
 *
 * Tests: actionVerb, buildClarificationQuestion, buildSyntheticUpdate,
 * confirmationKey, checkPendingClarification, handleConfirmationCallback
 */

import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import {
  actionVerb,
  buildClarificationQuestion,
  buildSyntheticUpdate,
  checkPendingClarification,
  handleConfirmationCallback,
} from "../../src/commands/command-router.ts";

// Minimal Context mock — only the fields used by the router helpers
function makeCtx(chatId = 1001, threadId?: number): Context {
  return {
    chat: { id: chatId },
    from: { id: 456, first_name: "Test" },
    message: threadId ? { message_thread_id: threadId, text: "test" } : { text: "test" },
    callbackQuery: undefined,
    reply: async () => ({ message_id: 1 }),
  } as unknown as Context;
}

// Callback query context mock
function makeCallbackCtx(chatId = 2001, threadId?: number): Context {
  return {
    chat: undefined,
    from: { id: 456 },
    message: undefined,
    callbackQuery: {
      data: "intent_cancel",
      from: { id: 456 },
      message: {
        chat: { id: chatId },
        message_thread_id: threadId,
      },
    },
    reply: async () => ({ message_id: 1 }),
    answerCallbackQuery: async () => {},
    editMessageText: async () => {},
  } as unknown as Context;
}

// ── actionVerb ──────────────────────────────────────────────

describe("actionVerb", () => {
  it("returns 'executer' for exec command", () => {
    expect(actionVerb("exec")).toBe("executer");
  });

  it("returns 'demarrer' for start command", () => {
    expect(actionVerb("start")).toBe("demarrer");
  });

  it("returns 'terminer' for done command", () => {
    expect(actionVerb("done")).toBe("terminer");
  });

  it("returns 'traiter' for unknown command", () => {
    expect(actionVerb("unknown")).toBe("traiter");
    expect(actionVerb("")).toBe("traiter");
  });
});

// ── buildClarificationQuestion ──────────────────────────────

describe("buildClarificationQuestion", () => {
  const mockAction = {
    command: "done",
    params: [],
    risk: "normal" as const,
    description: "",
    requiresSupabase: false,
  };

  it("asks for task ID when param is taskId", () => {
    const question = buildClarificationQuestion(mockAction, "taskId");
    expect(question).toContain("tache");
    expect(question).toContain("ID");
  });

  it("asks for title when param is title", () => {
    const question = buildClarificationQuestion(mockAction, "title");
    expect(question).toBe("Quel titre pour la tache ?");
  });

  it("asks for request when param is request", () => {
    const question = buildClarificationQuestion(mockAction, "request");
    expect(question).toContain("planifier");
  });

  it("asks for task count when param is taskCount", () => {
    const question = buildClarificationQuestion(mockAction, "taskCount");
    expect(question).toContain("Combien");
  });

  it("asks for time when param is time", () => {
    const question = buildClarificationQuestion(mockAction, "time");
    expect(question).toContain("heure");
  });

  it("asks for text when param is text", () => {
    const question = buildClarificationQuestion(mockAction, "text");
    expect(question).toContain("texte");
  });

  it("falls back to generic question for unknown param", () => {
    const question = buildClarificationQuestion(mockAction, "unknownParam");
    expect(question).toContain("unknownParam");
  });
});

// ── buildSyntheticUpdate ────────────────────────────────────

describe("buildSyntheticUpdate", () => {
  it("returns an object with update_id and message", () => {
    const ctx = makeCtx(1001);
    const update = buildSyntheticUpdate(ctx, "/start abc123");
    expect(update).toHaveProperty("update_id");
    expect(update).toHaveProperty("message");
  });

  it("message has correct text", () => {
    const ctx = makeCtx(1001);
    const update = buildSyntheticUpdate(ctx, "/done abc");
    expect((update as { message: { text: string } }).message.text).toBe("/done abc");
  });

  it("message has bot_command entity with correct length", () => {
    const ctx = makeCtx(1001);
    const update = buildSyntheticUpdate(ctx, "/start xyz");
    const entities = (
      update as { message: { entities: Array<{ type: string; offset: number; length: number }> } }
    ).message.entities;
    expect(entities[0].type).toBe("bot_command");
    expect(entities[0].offset).toBe(0);
    expect(entities[0].length).toBe(6); // "/start"
  });

  it("message length is full command for command without args", () => {
    const ctx = makeCtx(1001);
    const update = buildSyntheticUpdate(ctx, "/help");
    const entities = (update as { message: { entities: Array<{ type: string; length: number }> } })
      .message.entities;
    expect(entities[0].length).toBe(5); // "/help"
  });

  it("generates unique update_ids on successive calls", () => {
    const ctx = makeCtx(1001);
    const u1 = buildSyntheticUpdate(ctx, "/start");
    const u2 = buildSyntheticUpdate(ctx, "/start");
    expect((u1 as { update_id: number }).update_id).not.toBe(
      (u2 as { update_id: number }).update_id,
    );
  });

  it("includes message_thread_id when context has one", () => {
    const ctx = makeCtx(1001, 42);
    const update = buildSyntheticUpdate(ctx, "/done");
    expect((update as { message: { message_thread_id?: number } }).message.message_thread_id).toBe(
      42,
    );
  });

  it("omits message_thread_id when context has none", () => {
    const ctx = makeCtx(1001); // no threadId
    const update = buildSyntheticUpdate(ctx, "/done");
    expect(
      (update as { message: Record<string, unknown> }).message.message_thread_id,
    ).toBeUndefined();
  });
});

// ── checkPendingClarification ───────────────────────────────

describe("checkPendingClarification", () => {
  it("returns null when no pending clarification for this context", () => {
    const ctx = makeCtx(9001, 1);
    expect(checkPendingClarification(ctx, "some text")).toBeNull();
  });

  it("returns null for different chatId", () => {
    const ctx = makeCtx(9002, 0);
    expect(checkPendingClarification(ctx, "some text")).toBeNull();
  });
});

// ── handleConfirmationCallback ──────────────────────────────

describe("handleConfirmationCallback", () => {
  it("returns null for intent_cancel with no pending confirmation", () => {
    const ctx = makeCallbackCtx(8001);
    expect(handleConfirmationCallback(ctx, "intent_cancel")).toBeNull();
  });

  it("returns null for unrelated data", () => {
    const ctx = makeCallbackCtx(8002);
    expect(handleConfirmationCallback(ctx, "sdd_explore")).toBeNull();
  });

  it("returns null for intent_confirm: with no pending", () => {
    const ctx = makeCallbackCtx(8003);
    expect(handleConfirmationCallback(ctx, "intent_confirm:start")).toBeNull();
  });
});
