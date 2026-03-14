/**
 * Unit Tests — src/notifications.ts
 *
 * Tests for proactive Telegram notifications to forum topics.
 * Note: GROUP_ID, DEV_THREAD_ID, SPRINT_THREAD_ID are read at module load time
 * from process.env, so we assert on message content rather than parsed env values.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import {
  initNotifications,
  notifyPRCreated,
  notifyTaskStarted,
  notifyTaskDone,
} from "../../src/notifications";

function createMockBot(shouldFail = false) {
  return {
    api: {
      sendMessage: shouldFail
        ? mock(() => Promise.reject(new Error("Telegram API error")))
        : mock(() => Promise.resolve({ message_id: 1 })),
    },
  } as any;
}

describe("initNotifications", () => {
  it("stores the bot instance for later use", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyTaskDone("Test task", "abcdef1234567890");
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });
});

describe("notifyPRCreated", () => {
  it("sends PR notification with correct content", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyPRCreated("Add feature X", "https://github.com/pr/1", "feature/x");

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const args = bot.api.sendMessage.mock.calls[0];
    expect(typeof args[0]).toBe("number"); // GROUP_ID parsed as int
    expect(args[1]).toContain("PR creee");
    expect(args[1]).toContain("Add feature X");
    expect(args[1]).toContain("feature/x");
    expect(args[1]).toContain("https://github.com/pr/1");
    expect(args[2]).toHaveProperty("message_thread_id");
  });

  it("includes timestamp in HH:MM format", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyPRCreated("Task", "https://url", "branch");

    const message = bot.api.sendMessage.mock.calls[0][1];
    expect(message).toMatch(/\[\d{2}:\d{2}\]/);
  });

  it("formats message with line breaks", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyPRCreated("My Task", "https://pr", "feat/branch");

    const message = bot.api.sendMessage.mock.calls[0][1];
    const lines = message.split("\n");
    expect(lines.length).toBe(4);
    expect(lines[1]).toBe("My Task");
    expect(lines[2]).toBe("Branche: feat/branch");
    expect(lines[3]).toBe("https://pr");
  });
});

describe("notifyTaskStarted", () => {
  it("sends task started notification with correct content", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyTaskStarted("Implement login", "abcdef1234567890");

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const args = bot.api.sendMessage.mock.calls[0];
    expect(typeof args[0]).toBe("number");
    expect(args[1]).toContain("Tache demarree");
    expect(args[1]).toContain("Implement login");
    expect(args[1]).toContain("abcdef12"); // first 8 chars of ID
    expect(args[2]).toHaveProperty("message_thread_id");
  });
});

describe("notifyTaskDone", () => {
  it("sends task done notification with correct content", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyTaskDone("Fix bug #42", "deadbeef12345678");

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const args = bot.api.sendMessage.mock.calls[0];
    expect(typeof args[0]).toBe("number");
    expect(args[1]).toContain("Tache terminee");
    expect(args[1]).toContain("Fix bug #42");
    expect(args[1]).toContain("deadbeef"); // first 8 chars
    expect(args[2]).toHaveProperty("message_thread_id");
  });

  it("truncates task ID to 8 characters", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyTaskDone("Task", "1234567890abcdef");

    const message = bot.api.sendMessage.mock.calls[0][1];
    expect(message).toContain("[12345678]");
    expect(message).not.toContain("1234567890");
  });
});

describe("error handling", () => {
  it("catches and logs Telegram API errors without throwing", async () => {
    const bot = createMockBot(true); // will reject
    initNotifications(bot);

    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

    // Should not throw
    await notifyTaskStarted("Failing task", "abcdef1234567890");

    expect(consoleSpy).toHaveBeenCalled();
    const errorArgs = consoleSpy.mock.calls[0];
    expect(errorArgs[0]).toContain("Notification error");

    consoleSpy.mockRestore();
  });

  it("handles multiple consecutive errors gracefully", async () => {
    const bot = createMockBot(true);
    initNotifications(bot);

    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

    await notifyTaskStarted("Task 1", "aaaa000011112222");
    await notifyTaskDone("Task 2", "bbbb000011112222");
    await notifyPRCreated("Task 3", "https://pr", "branch");

    expect(consoleSpy.mock.calls.length).toBe(3);

    consoleSpy.mockRestore();
  });
});
