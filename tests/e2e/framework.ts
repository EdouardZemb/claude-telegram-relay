/**
 * E2E Test Framework — uses Grammy's handleUpdate to inject synthetic updates
 * and intercept bot responses without needing the Telegram API.
 */

import { createBot } from "../../src/relay.ts";
import type { Bot } from "grammy";
import type { Update, User, Message } from "grammy/types";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class E2EFramework {
  private bot!: Bot;
  private responses: string[] = [];
  private editedMessages: string[] = [];
  private callbackAnswers: string[] = [];
  readonly runId: string;
  private supabase: SupabaseClient | null = null;
  private userId: number;

  constructor(options?: { runId?: string }) {
    this.runId = options?.runId || `local-${Date.now()}`;
    this.userId = parseInt(process.env.TELEGRAM_USER_ID || "123456789");
  }

  async setup(): Promise<void> {
    // Create bot with a dummy token (API calls are intercepted)
    this.bot = await createBot("0:fake-token-for-e2e-tests");

    // Intercept ALL outgoing API calls
    this.bot.api.config.use(async (_prev, method, payload, _signal) => {
      // Capture text responses from sendMessage
      if (method === "sendMessage") {
        const text = (payload as Record<string, unknown>)?.text;
        if (typeof text === "string") {
          this.responses.push(text);
        }
        return {
          ok: true as const,
          result: this.fakeMessage(text as string || ""),
        };
      }

      // getMe is called by bot.init() before handleUpdate
      if (method === "getMe") {
        return {
          ok: true as const,
          result: {
            id: 0,
            is_bot: true,
            first_name: "E2ETestBot",
            username: "e2e_test_bot",
            can_join_groups: false,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
          } satisfies User,
        };
      }

      // sendVoice — capture nothing, just return fake
      if (method === "sendVoice") {
        return {
          ok: true as const,
          result: {
            ...this.fakeMessage(""),
            voice: { file_id: "fake", file_unique_id: "fake", duration: 0 },
          },
        };
      }

      // getFile — return fake file info for photo/document downloads
      if (method === "getFile") {
        return {
          ok: true as const,
          result: {
            file_id: (payload as Record<string, unknown>)?.file_id || "fake_file",
            file_unique_id: "e2e_unique",
            file_size: 10000,
            file_path: "photos/e2e_test_file.jpg",
          },
        };
      }

      // editMessageText — capture edited text (callback query responses)
      if (method === "editMessageText") {
        const text = (payload as Record<string, unknown>)?.text;
        if (typeof text === "string") {
          this.responses.push(text);
          this.editedMessages.push(text);
        }
        return {
          ok: true as const,
          result: this.fakeMessage(text as string || ""),
        };
      }

      // answerCallbackQuery — capture answer text
      if (method === "answerCallbackQuery") {
        const text = (payload as Record<string, unknown>)?.text;
        if (typeof text === "string") {
          this.callbackAnswers.push(text);
        }
        return { ok: true as const, result: true as any };
      }

      // Default: return true for all other methods (sendChatAction, etc.)
      return { ok: true as const, result: true as any };
    });

    // Initialize bot (calls getMe via interceptor)
    await this.bot.init();

    // Setup Supabase client for assertions and cleanup
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      this.supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
      );
    }
  }

  /**
   * Send a command or message to the bot and return all response texts joined.
   */
  async sendCommand(text: string): Promise<string> {
    this.responses = [];
    const update = this.buildUpdate(text);
    await this.bot.handleUpdate(update);
    // Small delay for async handlers that await before replying
    await new Promise((r) => setTimeout(r, 100));
    return this.responses.join("\n");
  }

  /**
   * Prefix text with the E2E run tag for data isolation.
   */
  tag(text: string): string {
    return `[E2E-${this.runId}] ${text}`;
  }

  assertContains(response: string, expected: string): void {
    if (!response.toLowerCase().includes(expected.toLowerCase())) {
      throw new Error(
        `Expected response to contain "${expected}"\nGot: ${response.substring(0, 500)}`
      );
    }
  }

  assertNotContains(response: string, unexpected: string): void {
    if (response.toLowerCase().includes(unexpected.toLowerCase())) {
      throw new Error(
        `Expected response NOT to contain "${unexpected}"\nGot: ${response.substring(0, 500)}`
      );
    }
  }

  /**
   * Query Supabase for assertions on side effects.
   */
  async querySupabase(
    table: string,
    filter: Record<string, string>
  ): Promise<any[]> {
    if (!this.supabase) return [];
    let query = this.supabase.from(table).select("*");
    for (const [key, value] of Object.entries(filter)) {
      query = query.eq(key, value);
    }
    const { data, error } = await query;
    if (error) {
      console.warn(`E2E Supabase query error (${table}): ${error.message}`);
      return [];
    }
    return data || [];
  }

  /**
   * Delete all test data tagged with [E2E-<runId>] from Supabase.
   */
  async cleanup(): Promise<void> {
    if (!this.supabase) return;
    const tagPattern = `%[E2E-${this.runId}]%`;

    const cleanups: Array<{ table: string; column: string }> = [
      { table: "tasks", column: "title" },
      { table: "memory", column: "content" },
      { table: "messages", column: "content" },
      { table: "logs", column: "message" },
    ];

    for (const { table, column } of cleanups) {
      try {
        const { error } = await this.supabase
          .from(table)
          .delete()
          .like(column, tagPattern);
        if (error) {
          console.warn(`E2E cleanup warning (${table}): ${error.message}`);
        }
      } catch (e) {
        console.warn(`E2E cleanup error (${table}): ${e}`);
      }
    }
  }

  async teardown(): Promise<void> {
    await this.cleanup();
  }

  /**
   * Send a photo message to the bot and return all response texts joined.
   */
  async sendPhoto(options?: { caption?: string; fileSize?: number }): Promise<string> {
    this.responses = [];
    this.editedMessages = [];
    this.callbackAnswers = [];
    const update = this.buildPhotoUpdate(options?.caption, options?.fileSize);
    await this.bot.handleUpdate(update);
    await new Promise((r) => setTimeout(r, 200));
    return this.responses.join("\n");
  }

  /**
   * Send a document/file message to the bot and return all response texts joined.
   */
  async sendDocument(options: {
    fileName: string;
    mimeType: string;
    fileSize?: number;
    caption?: string;
  }): Promise<string> {
    this.responses = [];
    this.editedMessages = [];
    this.callbackAnswers = [];
    const update = this.buildDocumentUpdate(options);
    await this.bot.handleUpdate(update);
    await new Promise((r) => setTimeout(r, 200));
    return this.responses.join("\n");
  }

  /**
   * Send a callback query to the bot and return all response texts joined.
   */
  async sendCallbackQuery(data: string, messageText?: string): Promise<string> {
    this.responses = [];
    this.editedMessages = [];
    this.callbackAnswers = [];
    const update = this.buildCallbackQueryUpdate(data, messageText);
    await this.bot.handleUpdate(update);
    await new Promise((r) => setTimeout(r, 200));
    return this.responses.join("\n");
  }

  getLastCallbackAnswers(): string[] {
    return [...this.callbackAnswers];
  }

  getLastEditedMessages(): string[] {
    return [...this.editedMessages];
  }

  // --- Private helpers ---

  private buildUpdate(text: string): Update {
    const messageId = Math.floor(Math.random() * 100000) + 1;

    const user: User = {
      id: this.userId,
      is_bot: false,
      first_name: "E2E-Test",
    };

    const chat = {
      id: this.userId,
      type: "private" as const,
      first_name: "E2E-Test",
    };

    const message: Record<string, unknown> = {
      message_id: messageId,
      from: user,
      chat,
      date: Math.floor(Date.now() / 1000),
      text,
    };

    // Add bot_command entity for slash commands
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const cmdLength = spaceIdx === -1 ? text.length : spaceIdx;
      message.entities = [
        { type: "bot_command", offset: 0, length: cmdLength },
      ];
    }

    return {
      update_id: Math.floor(Math.random() * 100000) + 1,
      message,
    } as Update;
  }

  private fakeMessage(text: string): Message.TextMessage {
    return {
      message_id: Math.floor(Math.random() * 100000) + 1,
      from: { id: 0, is_bot: true, first_name: "E2ETestBot" },
      chat: {
        id: this.userId,
        type: "private" as const,
        first_name: "E2E-Test",
      },
      date: Math.floor(Date.now() / 1000),
      text,
    } as Message.TextMessage;
  }

  private buildPhotoUpdate(caption?: string, fileSize?: number): Update {
    const messageId = Math.floor(Math.random() * 100000) + 1;
    const user: User = { id: this.userId, is_bot: false, first_name: "E2E-Test" };
    const chat = { id: this.userId, type: "private" as const, first_name: "E2E-Test" };

    const message: Record<string, unknown> = {
      message_id: messageId,
      from: user,
      chat,
      date: Math.floor(Date.now() / 1000),
      photo: [
        { file_id: "e2e_small", file_unique_id: "s1", width: 90, height: 90, file_size: 5000 },
        { file_id: "e2e_large", file_unique_id: "l1", width: 800, height: 600, file_size: fileSize || 100000 },
      ],
    };

    if (caption !== undefined) message.caption = caption;

    return {
      update_id: Math.floor(Math.random() * 100000) + 1,
      message,
    } as Update;
  }

  private buildDocumentUpdate(options: {
    fileName: string;
    mimeType: string;
    fileSize?: number;
    caption?: string;
  }): Update {
    const messageId = Math.floor(Math.random() * 100000) + 1;
    const user: User = { id: this.userId, is_bot: false, first_name: "E2E-Test" };
    const chat = { id: this.userId, type: "private" as const, first_name: "E2E-Test" };

    const message: Record<string, unknown> = {
      message_id: messageId,
      from: user,
      chat,
      date: Math.floor(Date.now() / 1000),
      document: {
        file_id: "e2e_doc_file",
        file_unique_id: "d1",
        file_name: options.fileName,
        mime_type: options.mimeType,
        file_size: options.fileSize || 50000,
      },
    };

    if (options.caption !== undefined) message.caption = options.caption;

    return {
      update_id: Math.floor(Math.random() * 100000) + 1,
      message,
    } as Update;
  }

  private buildCallbackQueryUpdate(data: string, messageText?: string): Update {
    const user: User = { id: this.userId, is_bot: false, first_name: "E2E-Test" };
    const chat = { id: this.userId, type: "private" as const, first_name: "E2E-Test" };

    return {
      update_id: Math.floor(Math.random() * 100000) + 1,
      callback_query: {
        id: `e2e_cb_${Date.now()}`,
        from: user,
        chat_instance: `e2e_instance_${Date.now()}`,
        message: {
          message_id: Math.floor(Math.random() * 100000) + 1,
          from: { id: 0, is_bot: true, first_name: "E2ETestBot" },
          chat,
          date: Math.floor(Date.now() / 1000),
          text: messageText || "Document en attente de classification",
        },
        data,
      },
    } as Update;
  }
}
