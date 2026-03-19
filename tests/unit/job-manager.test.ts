import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  launch,
  list,
  get,
  cancel,
  cleanup,
  formatJobList,
  getCapacity,
  getCompletionKeyboard,
  initJobManager,
  isJobManagerEnabled,
  _resetForTests,
  type Job,
} from "../../src/job-manager.ts";

// Mock notification-queue to avoid side effects
const originalEnqueue = await import("../../src/notification-queue.ts");

describe("job-manager", () => {
  beforeEach(() => {
    _resetForTests();
  });

  describe("launch", () => {
    it("returns a job ID immediately", async () => {
      const id = await launch("test", 123, async () => {
        return "done";
      });
      expect(id).toBeTruthy();
      expect(id.length).toBe(8);
    });

    it("creates a job with correct initial state", async () => {
      const id = await launch("exec", 456, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "result";
      });

      const job = await get(id);
      expect(job).toBeDefined();
      expect(job!.type).toBe("exec");
      expect(job!.chatId).toBe(456);
      // Job should be pending or running (race condition with semaphore)
      expect(["pending", "running"]).toContain(job!.status);
    });

    it("stores taskId when provided", async () => {
      const id = await launch("orchestrate", 123, async () => "ok", {
        taskId: "abc12345-full-uuid",
      });

      const job = await get(id);
      expect(job!.taskId).toBe("abc12345-full-uuid");
    });

    it("completes a job successfully", async () => {
      const id = await launch("test", 123, async () => {
        return "success result";
      });

      // Wait for job to complete
      await new Promise((r) => setTimeout(r, 100));

      const job = await get(id);
      expect(job!.status).toBe("completed");
      expect(job!.result).toBe("success result");
      expect(job!.completedAt).toBeTruthy();
    });

    it("marks failed job on error", async () => {
      const id = await launch("test", 123, async () => {
        throw new Error("boom");
      });

      await new Promise((r) => setTimeout(r, 100));

      const job = await get(id);
      expect(job!.status).toBe("failed");
      expect(job!.error).toBe("boom");
      expect(job!.completedAt).toBeTruthy();
    });

    it("truncates result to 500 chars", async () => {
      const longResult = "x".repeat(1000);
      const id = await launch("test", 123, async () => longResult);

      await new Promise((r) => setTimeout(r, 100));

      const job = await get(id);
      expect(job!.result!.length).toBeLessThanOrEqual(500);
    });

    it("truncates error to 500 chars", async () => {
      const longError = "e".repeat(1000);
      const id = await launch("test", 123, async () => {
        throw new Error(longError);
      });

      await new Promise((r) => setTimeout(r, 100));

      const job = await get(id);
      expect(job!.error!.length).toBeLessThanOrEqual(500);
    });

    it("handles timeout", async () => {
      const id = await launch(
        "test",
        123,
        async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return "never";
        },
        { timeoutMs: 50 },
      );

      await new Promise((r) => setTimeout(r, 200));

      const job = await get(id);
      expect(job!.status).toBe("failed");
      expect(job!.error).toContain("timeout");
    });

    it("runs multiple jobs concurrently", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await launch("test", 123, async () => {
          await new Promise((r) => setTimeout(r, 50));
          return `job-${i}`;
        });
        ids.push(id);
      }

      // All should be running or pending
      const { running } = await list();
      expect(running.length).toBeGreaterThanOrEqual(1);

      // Wait for all to complete
      await new Promise((r) => setTimeout(r, 300));

      for (const id of ids) {
        const job = await get(id);
        expect(job!.status).toBe("completed");
      }
    });

    it("queues 4th job when semaphore is full (max 3)", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const id = await launch("test", 123, async () => {
          await new Promise((r) => setTimeout(r, 100));
          return `job-${i}`;
        });
        ids.push(id);
      }

      // Give time for first 3 to start
      await new Promise((r) => setTimeout(r, 20));

      // At least one should be pending or waiting
      const capacity = getCapacity();
      expect(capacity.current).toBeLessThanOrEqual(3);

      // Wait for all to complete
      await new Promise((r) => setTimeout(r, 500));

      for (const id of ids) {
        const job = await get(id);
        expect(job!.status).toBe("completed");
      }
    });
  });

  describe("list", () => {
    it("shows running jobs", async () => {
      await launch("exec", 123, async () => {
        await new Promise((r) => setTimeout(r, 500));
        return "ok";
      });

      await new Promise((r) => setTimeout(r, 20));

      const { running } = await list();
      expect(running.length).toBeGreaterThanOrEqual(1);
      const execJob = running.find((j) => j.type === "exec");
      expect(execJob).toBeDefined();
    });

    it("shows recent completed jobs", async () => {
      const id = await launch("listtest", 123, async () => "done");
      await new Promise((r) => setTimeout(r, 100));

      const { recent } = await list();
      const found = recent.find((j) => j.id === id);
      expect(found).toBeDefined();
      expect(found!.status).toBe("completed");
    });

    it("limits recent jobs to specified count", async () => {
      for (let i = 0; i < 8; i++) {
        await launch("test", 123, async () => `result-${i}`);
      }
      await new Promise((r) => setTimeout(r, 300));

      const { recent } = await list(3);
      expect(recent.length).toBeLessThanOrEqual(3);
    });
  });

  describe("get", () => {
    it("returns undefined for unknown ID", async () => {
      const job = await get("nonexist");
      expect(job).toBeUndefined();
    });

    it("returns job by ID", async () => {
      const id = await launch("explore", 789, async () => "found");
      const job = await get(id);
      expect(job).toBeDefined();
      expect(job!.id).toBe(id);
      expect(job!.type).toBe("explore");
    });
  });

  describe("cancel", () => {
    it("returns undefined for unknown ID", async () => {
      const result = await cancel("nonexist");
      expect(result).toBeUndefined();
    });

    it("marks running job as failed/cancelled", async () => {
      const id = await launch("test", 123, async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return "never";
      });

      await new Promise((r) => setTimeout(r, 20));

      const job = await cancel(id);
      expect(job).toBeDefined();
      expect(job!.status).toBe("failed");
      expect(job!.error).toBe("cancelled");
      expect(job!.completedAt).toBeTruthy();
    });

    it("does not modify already completed jobs", async () => {
      const id = await launch("test", 123, async () => "done");
      await new Promise((r) => setTimeout(r, 100));

      const job = await cancel(id);
      expect(job!.status).toBe("completed");
      expect(job!.error).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("returns 0 when nothing to clean", async () => {
      const removed = await cleanup();
      expect(removed).toBe(0);
    });

    it("does not remove recent jobs", async () => {
      const id = await launch("test", 123, async () => "done");
      await new Promise((r) => setTimeout(r, 100));

      const removed = await cleanup();
      expect(removed).toBe(0);

      // The job we just launched should still be there
      const job = await get(id);
      expect(job).toBeDefined();
      expect(job!.status).toBe("completed");
    });
  });

  describe("getCapacity", () => {
    it("returns semaphore state", () => {
      const cap = getCapacity();
      expect(cap.max).toBe(3);
      expect(cap.current).toBeGreaterThanOrEqual(0);
      expect(cap.waiting).toBeGreaterThanOrEqual(0);
    });
  });

  describe("formatJobList", () => {
    it("formats empty list", () => {
      const result = formatJobList([], []);
      expect(result).toContain("Jobs en cours");
      expect(result).toContain("(aucun)");
    });

    it("formats running jobs with duration", () => {
      const running: Job[] = [
        {
          id: "abc12345",
          type: "orchestrate",
          status: "running",
          chatId: 123,
          taskId: "task-uuid-full",
          startedAt: new Date(Date.now() - 195000).toISOString(), // 3m15s ago
          completedAt: null,
          result: null,
          error: null,
        },
      ];
      const result = formatJobList(running, []);
      expect(result).toContain("abc12345");
      expect(result).toContain("orchestrate");
      expect(result).toContain("task-uui");
      expect(result).toContain("3m");
    });

    it("formats recent completed jobs", () => {
      const recent: Job[] = [
        {
          id: "def67890",
          type: "exec",
          status: "completed",
          chatId: 123,
          taskId: "task-uuid",
          startedAt: new Date(Date.now() - 330000).toISOString(),
          completedAt: new Date(Date.now() - 30000).toISOString(),
          result: "done",
          error: null,
        },
      ];
      const result = formatJobList([], recent);
      expect(result).toContain("Derniers termines");
      expect(result).toContain("def67890");
      expect(result).toContain("OK");
    });

    it("formats failed jobs", () => {
      const recent: Job[] = [
        {
          id: "fail1234",
          type: "plan",
          status: "failed",
          chatId: 123,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          result: null,
          error: "timeout",
        },
      ];
      const result = formatJobList([], recent);
      expect(result).toContain("FAIL");
    });
  });

  describe("isJobManagerEnabled", () => {
    it("returns a boolean", () => {
      const result = isJobManagerEnabled();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("initJobManager", () => {
    it("accepts a bot instance without error", () => {
      const fakeBotInstance = { api: { sendMessage: async () => {} } } as any;
      expect(() => initJobManager(fakeBotInstance)).not.toThrow();
    });
  });

  describe("messageThreadId", () => {
    it("stores messageThreadId from launch options", async () => {
      const id = await launch("test", 123, async () => "ok", {
        messageThreadId: 456,
      });

      const job = await get(id);
      expect(job!.messageThreadId).toBe(456);
    });

    it("messageThreadId is undefined when not provided", async () => {
      const id = await launch("test", 123, async () => "ok");

      const job = await get(id);
      expect(job!.messageThreadId).toBeUndefined();
    });
  });

  describe("getCompletionKeyboard", () => {
    const baseJob: Job = {
      id: "abc12345",
      type: "exec",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "done",
      error: null,
    };

    it("returns undefined for failed jobs", () => {
      const kb = getCompletionKeyboard({ ...baseJob, status: "failed" });
      expect(kb).toBeUndefined();
    });

    it("returns keyboard with PR button for exec with PR URL", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "exec",
        taskId: "task-uuid-1234",
        result: "PR created: https://github.com/user/repo/pull/42",
      });
      expect(kb).toBeDefined();
    });

    it("returns keyboard with task done button for exec with taskId", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "exec",
        taskId: "task-uuid-1234",
        result: "completed without PR",
      });
      expect(kb).toBeDefined();
    });

    it("returns backlog button for prd-decompose", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "prd-decompose",
        result: "5 taches creees",
      });
      expect(kb).toBeDefined();
    });

    it("returns backlog button for plan", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "plan",
        result: "3 taches ajoutees",
      });
      expect(kb).toBeDefined();
    });

    it("returns PRD buttons for prd with PRD_CREATED result", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "prd",
        result: "PRD_CREATED:c495951a-full-uuid",
      });
      expect(kb).toBeDefined();
    });

    it("returns undefined for prd without PRD_CREATED result", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "prd",
        result: "some other result",
      });
      expect(kb).toBeUndefined();
    });

    it("returns explore button for explore", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "explore",
        result: "analysis complete",
      });
      expect(kb).toBeDefined();
    });

    it("returns undefined for unknown job type", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "rollback",
        result: "rolled back",
      });
      expect(kb).toBeUndefined();
    });

    it("returns keyboard for orchestrate with PR and taskId", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "orchestrate",
        taskId: "task-uuid-5678",
        result: "ORCHESTRATION OK\nhttps://github.com/user/repo/pull/99",
      });
      expect(kb).toBeDefined();
    });

    it("returns keyboard for autopipeline", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "autopipeline",
        taskId: "task-uuid-9999",
        result: "PIPELINE OK",
      });
      expect(kb).toBeDefined();
    });
  });

  describe("direct notification", () => {
    it("sends to originating chat on completion when bot is initialized", async () => {
      let sentMessage: any = null;
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: any, text: string, opts?: any) => {
            sentMessage = { chatId, text, opts };
          },
        },
      } as any;

      initJobManager(fakeBotInstance);

      const id = await launch("plan", 12345, async () => "3 taches creees", {
        messageThreadId: 678,
      });

      // Wait for job to complete and notification to send
      await new Promise((r) => setTimeout(r, 200));

      expect(sentMessage).not.toBeNull();
      expect(sentMessage.chatId).toBe(12345);
      expect(sentMessage.text).toContain("plan terminé");
      expect(sentMessage.text).toContain("3 taches creees");
      expect(sentMessage.opts?.message_thread_id).toBe(678);
      expect(sentMessage.opts?.reply_markup).toBeDefined();
    });

    it("sends error notification for failed jobs", async () => {
      let sentMessage: any = null;
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: any, text: string, opts?: any) => {
            sentMessage = { chatId, text, opts };
          },
        },
      } as any;

      initJobManager(fakeBotInstance);

      await launch("exec", 999, async () => {
        throw new Error("agent crashed");
      }, { messageThreadId: 111 });

      await new Promise((r) => setTimeout(r, 200));

      expect(sentMessage).not.toBeNull();
      expect(sentMessage.chatId).toBe(999);
      expect(sentMessage.text).toContain("échoué");
      expect(sentMessage.text).toContain("agent crashed");
      expect(sentMessage.opts?.message_thread_id).toBe(111);
    });
  });
});
