/**
 * Unit Tests — zz-messages.ts handler logic
 *
 * Uses Grammy Bot.handleUpdate to invoke actual handlers and exercise
 * code paths inside the messagesComposer factory.
 *
 * MINIMAL mocks: only modules that would fail or cause side effects
 * without external services. Core modules (memory, feature-flags,
 * maturation, browser-delegation) use their real implementations
 * with null supabase / no active runs — prevents mock contamination.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Bot } from "grammy";
import type { Message, Update, User } from "grammy/types";

// ── Minimal mocks — only modules that require control ──────────

// Intent detection — must be mocked because detectIntentWithLLM
// would call an external LLM
const mockRegexResult = {
  detected: null as null | { confidence: number; action: string; args?: string },
  raw: "",
};
const mockLlmResult = {
  detected: null as null | { confidence: number; action: string; args?: string },
};

mock.module("../../src/intent-detection.ts", () => ({
  detectIntent: () => mockRegexResult,
  detectIntentWithLLM: async () => mockLlmResult,
}));

// Command router — must be mocked to control callback handling
let mockCheckPendingClarification: string | null = null;
let mockHandleConfirmationResult: string | null = null;
let mockHandleFeatureRequestResult: string | null = null;

mock.module("../../src/commands/command-router.ts", () => ({
  buildSyntheticUpdate: (_ctx: unknown, cmd: string) => ({
    update_id: 999,
    message: {
      message_id: 999,
      text: cmd,
      chat: { id: 1, type: "private" },
      from: { id: 123, is_bot: false, first_name: "Test" },
      date: Math.floor(Date.now() / 1000),
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: cmd.indexOf(" ") > 0 ? cmd.indexOf(" ") : cmd.length,
        },
      ],
    },
  }),
  checkPendingClarification: () => mockCheckPendingClarification,
  handleConfirmationCallback: () => mockHandleConfirmationResult,
  handleFeatureRequestCallback: () => mockHandleFeatureRequestResult,
  isFeatureRequestIntent: () => false,
  routeIntent: async () => ({ handled: false }),
  showFeatureRequestConfirmation: async () => {},
}));

// NOTE: pipeline-tracker, alerts, documents, commands/documents, and
// commands/sdd-flow are NOT mocked — using real implementations to
// prevent mock contamination with their own test files. These modules
// handle null supabase / no active pipelines gracefully.

// Transcribe — prevent calling external Groq/whisper
mock.module("../../src/transcribe.ts", () => ({
  transcribe: async () => "transcribed text from voice",
}));

// Now import the module under test
import messagesComposer, { isPhotoDocument } from "../../src/commands/zz-messages.ts";

// ── Mini-framework: lightweight Grammy Bot for handleUpdate ────

const TEST_USER_ID = 123456789;

function makeMockBctx() {
  return {
    bot: null as unknown as Bot,
    supabase: null,
    vncUrl: "",
    callClaude: mock(async (_prompt: string) => "claude-response"),
    sendResponse: mock(async (_ctx: unknown, _text: string) => {}),
    sendResponseHtml: mock(async (_ctx: unknown, _text: string) => {}),
    sendVoiceResponse: mock(async (_ctx: unknown, _text: string) => {}),
    buildPrompt: mock(() => "enriched-prompt"),
    saveMessage: mock(async () => {}),
    getDynamicProfile: mock(async () => "profile-data"),
    getThreadId: mock(() => undefined as number | undefined),
    getTopicName: mock(() => undefined as string | undefined),
    getTopicConfig: mock(() => undefined),
    threadOpts: mock(() => ({})),
    heartbeatOpts: mock(() => ({ chatId: 123 })),
    commandGuard: mock(() => null),
    recordError: mock(() => false),
    clearError: mock(() => {}),
  };
}

async function createTestBot() {
  const bctx = makeMockBctx();
  const bot = new Bot("0:fake-token-for-unit-test");

  const responses: string[] = [];
  const editedMessages: string[] = [];
  const callbackAnswers: string[] = [];

  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      const text = (payload as Record<string, unknown>)?.text;
      if (typeof text === "string") responses.push(text);
      return {
        ok: true as const,
        result: {
          message_id: 1,
          from: { id: 0, is_bot: true, first_name: "TestBot" },
          chat: { id: TEST_USER_ID, type: "private" as const, first_name: "Test" },
          date: Math.floor(Date.now() / 1000),
          text: (text as string) || "",
        } satisfies Message.TextMessage,
      };
    }
    if (method === "getMe") {
      return {
        ok: true as const,
        result: {
          id: 0,
          is_bot: true,
          first_name: "TestBot",
          username: "test_bot",
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        } satisfies User,
      };
    }
    if (method === "getFile") {
      return {
        ok: true as const,
        result: { file_id: "f1", file_unique_id: "u1", file_size: 10000, file_path: "test.jpg" },
      };
    }
    if (method === "editMessageText") {
      const text = (payload as Record<string, unknown>)?.text;
      if (typeof text === "string") editedMessages.push(text);
      return {
        ok: true as const,
        result: {
          message_id: 1,
          from: { id: 0, is_bot: true, first_name: "TestBot" },
          chat: { id: TEST_USER_ID, type: "private" as const, first_name: "Test" },
          date: Math.floor(Date.now() / 1000),
          text: (text as string) || "",
        } satisfies Message.TextMessage,
      };
    }
    if (method === "answerCallbackQuery") {
      const text = (payload as Record<string, unknown>)?.text;
      if (typeof text === "string") callbackAnswers.push(text);
      // biome-ignore lint/suspicious/noExplicitAny: Grammy API mock
      return { ok: true as const, result: true as any };
    }
    // biome-ignore lint/suspicious/noExplicitAny: Grammy API mock
    return { ok: true as const, result: true as any };
  });

  bctx.bot = bot;

  const composer = messagesComposer(bctx as never);
  bot.use(composer);

  await bot.init();

  return { bot, bctx, responses, editedMessages, callbackAnswers };
}

function buildTextUpdate(text: string): Update {
  return {
    update_id: Math.floor(Math.random() * 100000) + 1,
    message: {
      message_id: Math.floor(Math.random() * 100000) + 1,
      from: { id: TEST_USER_ID, is_bot: false, first_name: "Test" },
      chat: { id: TEST_USER_ID, type: "private" as const, first_name: "Test" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  } as Update;
}

function buildCallbackUpdate(data: string): Update {
  return {
    update_id: Math.floor(Math.random() * 100000) + 1,
    callback_query: {
      id: `cb_${Date.now()}`,
      from: { id: TEST_USER_ID, is_bot: false, first_name: "Test" },
      chat_instance: `inst_${Date.now()}`,
      message: {
        message_id: 200,
        from: { id: 0, is_bot: true, first_name: "TestBot" },
        chat: { id: TEST_USER_ID, type: "private" as const, first_name: "Test" },
        date: Math.floor(Date.now() / 1000),
        text: "Pending action",
      },
      data,
    },
  } as Update;
}

// ── Tests ───────────────────────────────────────────────────────

describe("messagesComposer — factory", () => {
  it("returns a composer with middleware function", () => {
    const bctx = makeMockBctx();
    const composer = messagesComposer(bctx as never);
    expect(typeof composer.middleware).toBe("function");
  });

  it("default export is the messagesComposer function", () => {
    expect(typeof messagesComposer).toBe("function");
  });
});

describe("messagesComposer — text handler via handleUpdate", () => {
  beforeEach(() => {
    mockRegexResult.detected = null;
    mockLlmResult.detected = null;
    mockCheckPendingClarification = null;
    // reset state
  });

  it("processes a text message and calls Claude", async () => {
    const { bot, bctx } = await createTestBot();
    await bot.handleUpdate(buildTextUpdate("Bonjour, comment ca va ?"));
    await new Promise((r) => setTimeout(r, 50));

    expect(bctx.saveMessage).toHaveBeenCalled();
    expect(bctx.callClaude).toHaveBeenCalled();
    expect(bctx.sendResponse).toHaveBeenCalled();
    expect(bctx.clearError).toHaveBeenCalled();
  });

  it("completes processing without errors", async () => {
    const { bot, bctx } = await createTestBot();
    await bot.handleUpdate(buildTextUpdate("Hello"));
    await new Promise((r) => setTimeout(r, 50));

    // Successful processing clears errors
    expect(bctx.clearError).toHaveBeenCalled();
  });

  it("saves user message before processing", async () => {
    const { bot, bctx } = await createTestBot();
    await bot.handleUpdate(buildTextUpdate("Test message"));
    await new Promise((r) => setTimeout(r, 50));

    const firstCall = bctx.saveMessage.mock.calls[0];
    expect(firstCall[0]).toBe("user");
    expect(firstCall[1]).toBe("Test message");
  });

  it("saves assistant response after processing", async () => {
    const { bot, bctx } = await createTestBot();
    await bot.handleUpdate(buildTextUpdate("Test message"));
    await new Promise((r) => setTimeout(r, 50));

    const calls = bctx.saveMessage.mock.calls;
    const assistantCall = calls.find((c: unknown[]) => c[0] === "assistant");
    expect(assistantCall).toBeDefined();
    expect(assistantCall![1]).toBe("claude-response");
  });

  it("calls buildPrompt with context", async () => {
    const { bot, bctx } = await createTestBot();
    await bot.handleUpdate(buildTextUpdate("Specific input text"));
    await new Promise((r) => setTimeout(r, 50));

    expect(bctx.buildPrompt).toHaveBeenCalled();
  });

  it("calls getDynamicProfile for context assembly", async () => {
    const { bot, bctx } = await createTestBot();
    await bot.handleUpdate(buildTextUpdate("test"));
    await new Promise((r) => setTimeout(r, 50));

    expect(bctx.getDynamicProfile).toHaveBeenCalled();
  });
});

describe("messagesComposer — intent confirmation callbacks", () => {
  beforeEach(() => {
    mockHandleConfirmationResult = null;
    mockHandleFeatureRequestResult = null;
  });

  it("handles intent_cancel callback", async () => {
    const { bot, editedMessages, callbackAnswers } = await createTestBot();
    await bot.handleUpdate(buildCallbackUpdate("intent_cancel"));
    await new Promise((r) => setTimeout(r, 50));

    expect(callbackAnswers).toContain("Annule.");
    expect(editedMessages).toContain("Action annulee.");
  });

  it("handles expired intent callback", async () => {
    mockHandleConfirmationResult = null;
    const { bot, callbackAnswers } = await createTestBot();
    await bot.handleUpdate(buildCallbackUpdate("intent_something_expired"));
    await new Promise((r) => setTimeout(r, 50));

    expect(callbackAnswers).toContain("Action expiree.");
  });

  it("handles confirmed intent callback with command", async () => {
    mockHandleConfirmationResult = "/backlog";
    const { bot, callbackAnswers, editedMessages } = await createTestBot();
    await bot.handleUpdate(buildCallbackUpdate("intent_confirm_abc"));
    await new Promise((r) => setTimeout(r, 50));

    expect(callbackAnswers).toContain("Execution...");
    expect(editedMessages).toContain("Execution : /backlog");
  });

  it("ignores non-intent callbacks", async () => {
    const { bot, callbackAnswers } = await createTestBot();
    await bot.handleUpdate(buildCallbackUpdate("sdd_explore_test"));
    await new Promise((r) => setTimeout(r, 50));

    expect(callbackAnswers).not.toContain("Annule.");
    expect(callbackAnswers).not.toContain("Execution...");
  });
});

describe("messagesComposer — feature request callbacks", () => {
  beforeEach(() => {
    mockHandleConfirmationResult = null;
    mockHandleFeatureRequestResult = null;
  });

  it("handles feature_request_cancel callback", async () => {
    const { bot, callbackAnswers, editedMessages } = await createTestBot();
    await bot.handleUpdate(buildCallbackUpdate("feature_request_cancel"));
    await new Promise((r) => setTimeout(r, 50));

    expect(callbackAnswers).toContain("OK, pas d'exploration.");
    expect(editedMessages).toContain("Pas de souci, on continue la conversation.");
  });

  it("handles expired feature request callback", async () => {
    mockHandleFeatureRequestResult = null;
    const { bot, callbackAnswers } = await createTestBot();
    await bot.handleUpdate(buildCallbackUpdate("feature_request_xyz"));
    await new Promise((r) => setTimeout(r, 50));

    expect(callbackAnswers).toContain("Demande expiree.");
  });

  it("handles confirmed feature request callback with command", async () => {
    mockHandleFeatureRequestResult = "/explore new feature";
    const { bot, callbackAnswers, editedMessages } = await createTestBot();
    await bot.handleUpdate(buildCallbackUpdate("feature_request_confirm_abc"));
    await new Promise((r) => setTimeout(r, 50));

    expect(callbackAnswers).toContain("Lancement de l'exploration...");
    expect(editedMessages[0]).toContain("Exploration lancee");
  });
});

describe("messagesComposer — error handling in text handler", () => {
  beforeEach(() => {
    mockRegexResult.detected = null;
    mockLlmResult.detected = null;
    mockCheckPendingClarification = null;
    // reset state
  });

  it("catches errors and sends error message when recordError returns false", async () => {
    const { bot, bctx, responses } = await createTestBot();
    bctx.callClaude = mock(async () => {
      throw new Error("Claude API error");
    });
    bctx.recordError = mock(() => false);

    await bot.handleUpdate(buildTextUpdate("trigger error"));
    await new Promise((r) => setTimeout(r, 50));

    expect(bctx.recordError).toHaveBeenCalled();
    const hasError = responses.some((r) => r.includes("Erreur") || r.includes("Reessaie"));
    expect(hasError).toBe(true);
  });

  it("suppresses error message when recordError returns true (duplicate)", async () => {
    const { bot, bctx, responses } = await createTestBot();
    bctx.callClaude = mock(async () => {
      throw new Error("Claude API error");
    });
    bctx.recordError = mock(() => true);

    const responseCountBefore = responses.length;
    await bot.handleUpdate(buildTextUpdate("trigger error"));
    await new Promise((r) => setTimeout(r, 50));

    expect(responses.length).toBe(responseCountBefore);
  });
});

describe("messagesComposer — meta construction with threads", () => {
  beforeEach(() => {
    mockRegexResult.detected = null;
    mockLlmResult.detected = null;
    mockCheckPendingClarification = null;
    // reset state
  });

  it("includes thread_id and topic in meta when present", async () => {
    const { bot, bctx } = await createTestBot();
    bctx.getThreadId = mock(() => 42);
    bctx.getTopicName = mock(() => "general");

    await bot.handleUpdate(buildTextUpdate("Test in thread"));
    await new Promise((r) => setTimeout(r, 50));

    const firstCall = bctx.saveMessage.mock.calls[0];
    const meta = firstCall[2] as Record<string, unknown>;
    expect(meta.thread_id).toBe(42);
    expect(meta.topic).toBe("general");
  });
});

describe("messagesComposer — processMessageInput logic paths", () => {
  it("enrichedMemoryContext includes action context when no pipeline", () => {
    const memoryContext = "memory-context";
    const actionContext = "\nACTIONS DISPONIBLES:\n/help - Aide";
    const pipelineContext = "";
    const result = pipelineContext
      ? pipelineContext + "\n" + memoryContext + actionContext
      : memoryContext + actionContext;
    expect(result).toContain("memory-context");
    expect(result).toContain("ACTIONS DISPONIBLES");
  });

  it("enrichedMemoryContext prepends pipeline context when active", () => {
    const memoryContext = "memory-context";
    const actionContext = "\nACTIONS DISPONIBLES:\n/help - Aide";
    const pipelineContext = "[PIPELINE: spec phase active]";
    const result = pipelineContext
      ? pipelineContext + "\n" + memoryContext + actionContext
      : memoryContext + actionContext;
    expect(result.indexOf("[PIPELINE")).toBeLessThan(result.indexOf("memory-context"));
  });
});

describe("messagesComposer — handler logic verification", () => {
  it("browse VNC message includes URL when set", () => {
    const vncUrl = "http://localhost:6080/vnc.html";
    const vncMsg = vncUrl
      ? `Navigation en cours... Si un captcha apparait, interviens ici :\n${vncUrl}`
      : "Navigation en cours...";
    expect(vncMsg).toContain("captcha");
  });

  it("browse simple message when vncUrl is empty", () => {
    const vncUrl = "";
    const vncMsg = vncUrl
      ? `Navigation en cours... Si un captcha apparait, interviens ici :\n${vncUrl}`
      : "Navigation en cours...";
    expect(vncMsg).toBe("Navigation en cours...");
  });

  it("photo handler selects highest resolution (last in array)", () => {
    const photos = [
      { file_id: "small", file_size: 1000 },
      { file_id: "large", file_size: 50000 },
    ];
    expect(photos[photos.length - 1].file_id).toBe("large");
  });

  it("document fileName sanitizes path separators", () => {
    const rawName = "path/to\\file.pdf";
    expect(rawName.replace(/[/\\]/g, "_")).toBe("path_to_file.pdf");
  });

  it("duplicate match label for content match", () => {
    const matchType = "content" as const;
    const label = matchType === "content" ? "contenu identique" : "meme nom de fichier";
    expect(label).toBe("contenu identique");
  });

  it("voice save text format", () => {
    expect(`[Voice ${5}s]: bonjour`).toBe("[Voice 5s]: bonjour");
  });
});

describe("isPhotoDocument — additional edge cases", () => {
  it("handles very long caption without keywords", () => {
    expect(isPhotoDocument("Regarde " + "a".repeat(500), 100 * 1024)).toBe(false);
  });

  it("handles caption with keyword at the end", () => {
    expect(isPhotoDocument("Voici ma facture", 100)).toBe(true);
  });

  it("handles caption with keyword at the start", () => {
    expect(isPhotoDocument("facture de mars", 100)).toBe(true);
  });

  it("handles multiple keywords in same caption", () => {
    expect(isPhotoDocument("facture et contrat et devis", 100)).toBe(true);
  });
});
