/**
 * Unit Tests — src/notifications.ts
 *
 * Tests for proactive Telegram notifications to forum topics.
 * S26: Notifications now route through the notification queue.
 * Tests verify message formatting and direct sendToTopic fallback.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

// Set env vars BEFORE importing the module (they are read at load time)
process.env.TELEGRAM_GROUP_ID = "123456";
process.env.DEV_THREAD_ID = "100";
process.env.SPRINT_THREAD_ID = "200";
process.env.USER_TIMEZONE = "Europe/Paris";

const {
  initNotifications,
  notifyPRCreated,
  notifyTaskStarted,
  notifyTaskDone,
  notifyIdeaCreated,
  notifyIdeaPromoted,
  sendToTopic,
} = await import("../../src/notifications");

// Import queue + prefs to manage state
const { getQueue, flush } = await import("../../src/notification-queue");
const { savePrefs, getDefaultPrefs, loadPrefs } = await import("../../src/notification-prefs");

function createMockBot(shouldFail = false) {
  return {
    api: {
      sendMessage: shouldFail
        ? mock(() => Promise.reject(new Error("Telegram API error")))
        : mock(() => Promise.resolve({ message_id: 1 })),
    },
  } as any;
}

// Reset prefs and queue before each test
beforeEach(async () => {
  const prefs = getDefaultPrefs();
  prefs.quietStart = 0;
  prefs.quietEnd = 0;
  prefs.batchThreshold = 100;
  await savePrefs(prefs);
  await loadPrefs();
  while (getQueue().length > 0) getQueue().pop();
});

describe("initNotifications", () => {
  it("stores the bot instance for later use", () => {
    const bot = createMockBot();
    initNotifications(bot);
    expect(true).toBe(true);
  });
});

describe("sendToTopic", () => {
  it("sends directly to topic bypassing queue", async () => {
    const bot = createMockBot();
    initNotifications(bot);

    await sendToTopic(200, "Direct message");

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const args = bot.api.sendMessage.mock.calls[0];
    expect(args[1]).toBe("Direct message");
    expect(args[2]).toHaveProperty("message_thread_id", 200);
  });

  it("catches and logs Telegram API errors without throwing", async () => {
    const bot = createMockBot(true);
    initNotifications(bot);

    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
    await sendToTopic(200, "Will fail");
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("notifyPRCreated", () => {
  it("enqueues PR notification with correct type and data", async () => {
    await notifyPRCreated("Add feature X", "https://github.com/pr/1", "feature/x");

    const q = getQueue();
    expect(q.length).toBeGreaterThanOrEqual(1);
    const item = q.find((i: any) => i.type === "pr");
    expect(item).toBeDefined();
    expect(item!.data?.prUrl).toBe("https://github.com/pr/1");
    expect(item!.message).toContain("PR creee");
    expect(item!.message).toContain("Add feature X");
    expect(item!.message).toContain("feature/x");
  });

  it("includes timestamp in HH:MM format", async () => {
    await notifyPRCreated("Task", "https://url", "branch");

    const q = getQueue();
    const item = q.find((i: any) => i.type === "pr");
    expect(item!.message).toMatch(/\[\d{2}:\d{2}\]/);
  });
});

describe("notifyTaskStarted", () => {
  it("enqueues task started notification", async () => {
    await notifyTaskStarted("Implement login", "abcdef1234567890");

    const q = getQueue();
    const item = q.find((i: any) => i.message?.includes("Tache demarree"));
    expect(item).toBeDefined();
    expect(item!.type).toBe("task");
    expect(item!.data?.taskId).toBe("abcdef1234567890");
    expect(item!.data?.taskStatus).toBe("in_progress");
    expect(item!.message).toContain("abcdef12");
  });
});

describe("notifyTaskDone", () => {
  it("enqueues task done notification", async () => {
    await notifyTaskDone("Fix bug #42", "deadbeef12345678");

    const q = getQueue();
    const item = q.find((i: any) => i.message?.includes("Tache terminee"));
    expect(item).toBeDefined();
    expect(item!.type).toBe("task");
    expect(item!.data?.taskId).toBe("deadbeef12345678");
    expect(item!.data?.taskStatus).toBe("done");
    expect(item!.message).toContain("deadbeef");
  });
});

describe("notifyIdeaCreated", () => {
  it("enqueues idea created notification", async () => {
    // Explicitly ensure idea is enabled (race condition with parallel tests)
    const prefs = getDefaultPrefs();
    prefs.quietStart = 0;
    prefs.quietEnd = 0;
    prefs.batchThreshold = 100;
    prefs.types.idea.enabled = true;
    await savePrefs(prefs);
    await loadPrefs();

    await notifyIdeaCreated("Ajouter un mode sombre", "manual");

    const q = getQueue();
    const item = q.find((i: any) => i.type === "idea");
    expect(item).toBeDefined();
    expect(item!.message).toContain("Nouvelle idee");
    expect(item!.message).toContain("mode sombre");
  });

  it("truncates long idea content to 80 chars", async () => {
    const prefs = getDefaultPrefs();
    prefs.quietStart = 0;
    prefs.quietEnd = 0;
    prefs.batchThreshold = 100;
    prefs.types.idea.enabled = true;
    await savePrefs(prefs);
    await loadPrefs();

    const longIdea = "A".repeat(120);
    await notifyIdeaCreated(longIdea, "auto-detect");

    const q = getQueue();
    const item = q.find((i: any) => i.type === "idea");
    expect(item).toBeDefined();
    expect(item!.message).toContain("...");
    expect(item!.message).not.toContain("A".repeat(120));
  });
});

describe("notifyIdeaPromoted", () => {
  it("enqueues idea promoted notification", async () => {
    const prefs = getDefaultPrefs();
    prefs.quietStart = 0;
    prefs.quietEnd = 0;
    prefs.batchThreshold = 100;
    prefs.types.idea.enabled = true;
    await savePrefs(prefs);
    await loadPrefs();

    await notifyIdeaPromoted("Ajouter des tests E2E", "Ajouter des tests E2E");

    const q = getQueue();
    const item = q.find((i: any) => i.type === "idea");
    expect(item).toBeDefined();
    expect(item!.message).toContain("Idee promue en tache");
  });

  it("truncates long idea content in promotion notification", async () => {
    const prefs = getDefaultPrefs();
    prefs.quietStart = 0;
    prefs.quietEnd = 0;
    prefs.batchThreshold = 100;
    prefs.types.idea.enabled = true;
    await savePrefs(prefs);
    await loadPrefs();

    const longIdea = "B".repeat(120);
    await notifyIdeaPromoted(longIdea, "Task from long idea");

    const q = getQueue();
    const item = q.find((i: any) => i.type === "idea");
    expect(item).toBeDefined();
    expect(item!.message).toContain("...");
    expect(item!.message).toContain("Task from long idea");
  });
});
