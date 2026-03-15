/**
 * Unit Tests — src/notifications.ts
 *
 * Tests for proactive Telegram notifications to forum topics.
 * Note: GROUP_ID, DEV_THREAD_ID, SPRINT_THREAD_ID are read at module load time
 * from process.env, so we assert on message content rather than parsed env values.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";

// Set env vars BEFORE importing the module (they are read at load time)
process.env.TELEGRAM_GROUP_ID = "123456";
process.env.DEV_THREAD_ID = "100";
process.env.SPRINT_THREAD_ID = "200";

// Force re-import with env vars set
const { initNotifications, notifyPRCreated, notifyTaskStarted, notifyTaskDone, notifyIdeaCreated, notifyIdeaPromoted } = await import("../../src/notifications");

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

describe("notifyIdeaCreated", () => {
  it("sends idea created notification with source", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyIdeaCreated("Ajouter un mode sombre au dashboard", "manual");

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const args = bot.api.sendMessage.mock.calls[0];
    expect(typeof args[0]).toBe("number");
    expect(args[1]).toContain("Nouvelle idee");
    expect(args[1]).toContain("manual");
    expect(args[1]).toContain("mode sombre");
    expect(args[2]).toHaveProperty("message_thread_id");
  });

  it("truncates long idea content to 80 chars", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    const longIdea = "A".repeat(120);
    await notifyIdeaCreated(longIdea, "auto-detect");

    const message = bot.api.sendMessage.mock.calls[0][1];
    expect(message).toContain("...");
    expect(message).not.toContain("A".repeat(120));
  });

  it("includes timestamp in HH:MM format", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyIdeaCreated("Some idea", "intent-tag");

    const message = bot.api.sendMessage.mock.calls[0][1];
    expect(message).toMatch(/\[\d{2}:\d{2}\]/);
  });
});

describe("notifyIdeaPromoted", () => {
  it("sends idea promoted notification with task title", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyIdeaPromoted("Ajouter des tests E2E", "Ajouter des tests E2E");

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const args = bot.api.sendMessage.mock.calls[0];
    expect(typeof args[0]).toBe("number");
    expect(args[1]).toContain("Idee promue en tache");
    expect(args[1]).toContain("tests E2E");
    expect(args[1]).toContain("Tache:");
    expect(args[2]).toHaveProperty("message_thread_id");
  });

  it("truncates long idea content in promotion notification", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    const longIdea = "B".repeat(120);
    await notifyIdeaPromoted(longIdea, "Task from long idea");

    const message = bot.api.sendMessage.mock.calls[0][1];
    expect(message).toContain("...");
    expect(message).toContain("Task from long idea");
  });

  it("formats message with line breaks", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await notifyIdeaPromoted("Mon idee", "Ma tache");

    const message = bot.api.sendMessage.mock.calls[0][1];
    const lines = message.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe("Tache: Ma tache");
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
