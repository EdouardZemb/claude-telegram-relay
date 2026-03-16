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
  readonly runId: string;
  private supabase: SupabaseClient | null = null;
  private userId: number;

  constructor(options?: { runId?: string }) {
    this.runId = options?.runId || `local-${Date.now()}`;
    this.userId = parseInt(process.env.TELEGRAM_USER_ID || "123456789");
  }

  async setup(): Promise<void> {
    // Create bot with a dummy token (API calls are intercepted)
    this.bot = createBot("0:fake-token-for-e2e-tests");

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
}
