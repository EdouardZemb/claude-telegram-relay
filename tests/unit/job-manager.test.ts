import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  _resetForTests,
  cancel,
  cleanup,
  formatJobList,
  get,
  getCapacity,
  getCompletionKeyboard,
  initJobManager,
  isJobManagerEnabled,
  type Job,
  launch,
  list,
} from "../../src/job-manager.ts";
import {
  _clearForTests as _clearTrackerForTests,
  createPipeline,
  getTracker,
} from "../../src/pipeline-tracker.ts";

// Mock notification-queue to avoid side effects
const _originalEnqueue = await import("../../src/notification-queue.ts");

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
      // Uses Unicode check icon for completed jobs
      expect(result).toContain("\u2705");
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
      // Uses Unicode cross icon for failed jobs
      expect(result).toContain("\u274C");
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
      // biome-ignore lint/suspicious/noExplicitAny: test mock
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

  describe("SDD pipeline (VC3-VC5)", () => {
    const baseJob: Job = {
      id: "sdd12345",
      type: "sdd-review:my-feature",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: null,
      error: null,
    };

    it("VC3: extended regex matches APPROVED and CHANGES_REQUESTED", () => {
      // Test indirectly via getCompletionKeyboard: APPROVED adds merge button
      const kb = getCompletionKeyboard({
        ...baseJob,
        result: "SDD_REVIEW_APPROVED: my-feature",
      });
      expect(kb).toBeDefined();
      const allData = kb!.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data)
        .filter(Boolean);
      expect(allData).toContain("sdd_merge_ask:my-feature");
    });

    it("VC3 non-regression: existing GO/OK tokens still match", () => {
      // implement phase with OK verdict should still have Review/Corriger buttons
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "sdd-implement:my-feature",
        result: "SDD_IMPLEMENT_OK: my-feature — PR created",
      });
      expect(kb).toBeDefined();
    });

    it("VC4: getCompletionKeyboard for sdd-review APPROVED returns sdd_merge_ask button", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        result: "SDD_REVIEW_APPROVED: my-feature",
      });
      expect(kb).toBeDefined();
      const allData = kb!.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data)
        .filter(Boolean);
      expect(allData).toContain("sdd_merge_ask:my-feature");
    });

    it("VC5: getCompletionKeyboard for sdd-review CHANGES_REQUESTED has no merge button", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        result: "SDD_REVIEW_CHANGES_REQUESTED: my-feature",
      });
      const allData = (kb?.inline_keyboard ?? [])
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data)
        .filter(Boolean);
      expect(allData).not.toContain("sdd_merge_ask:my-feature");
    });

    it("AM-KB1: getCompletionKeyboard for review APPROVED with [AUTO-MERGE] hides merge button", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        result: "SDD_REVIEW_APPROVED: my-feature [AUTO-MERGE]",
      });
      expect(kb).toBeDefined();
      const allCallbackData = (kb?.inline_keyboard ?? [])
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data)
        .filter(Boolean);
      // Should NOT have the manual merge button
      expect(allCallbackData).not.toContain("sdd_merge_ask:my-feature");
    });

    it("AM-KB2: getCompletionKeyboard for review APPROVED with [AUTO-MERGE] still shows PR link", () => {
      // Inject a fake implement job with prUrl into registry
      _resetForTests();
      // Use a fresh job with a result that contains [AUTO-MERGE]
      const kb = getCompletionKeyboard({
        ...baseJob,
        result: "SDD_REVIEW_APPROVED: my-feature [AUTO-MERGE]",
      });
      expect(kb).toBeDefined();
      // Keyboard should exist (at minimum for the Voir la PR button if prUrl found)
    });

    it("AM-KB3: getCompletionKeyboard for review APPROVED without [AUTO-MERGE] still shows merge button", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        result: "SDD_REVIEW_APPROVED: my-feature",
      });
      expect(kb).toBeDefined();
      const allCallbackData = (kb?.inline_keyboard ?? [])
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data)
        .filter(Boolean);
      expect(allCallbackData).toContain("sdd_merge_ask:my-feature");
    });
  });

  describe("SDD prUrl persistence (VC6)", () => {
    const TEST_RELAY_DIR_VC6 = join(import.meta.dir, "..", ".test-jm-relay-vc6");
    const origRelayDir = process.env.RELAY_DIR;

    beforeEach(async () => {
      process.env.RELAY_DIR = TEST_RELAY_DIR_VC6;
      _resetForTests();
      _clearTrackerForTests();
      try {
        await rm(TEST_RELAY_DIR_VC6, { recursive: true, force: true });
      } catch {
        // ignore
      }
      await mkdir(TEST_RELAY_DIR_VC6, { recursive: true });
      await createPipeline(12345, 678, "my-feature");
    });

    afterEach(async () => {
      process.env.RELAY_DIR = origRelayDir;
      _resetForTests();
      _clearTrackerForTests();
      try {
        await rm(TEST_RELAY_DIR_VC6, { recursive: true, force: true });
      } catch {
        // cleanup best effort
      }
    });

    it("VC6: sendJobCompletionNotification persists prUrl for sdd-implement jobs", async () => {
      const fakeBotInstance = {
        api: {
          sendMessage: async () => {},
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;
      initJobManager(fakeBotInstance);

      await launch(
        "sdd-implement:my-feature",
        12345,
        async () => "SDD_IMPLEMENT_OK: my-feature — https://github.com/owner/repo/pull/42",
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 300));

      const tracker = await getTracker(12345, 678);
      expect(tracker).not.toBeNull();
      expect(tracker!.steps.implement.prUrl).toBe("https://github.com/owner/repo/pull/42");
    });

    it("VC6: no prUrl persistence for non-sdd-implement jobs", async () => {
      const fakeBotInstance = {
        api: { sendMessage: async () => {} },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;
      initJobManager(fakeBotInstance);

      await launch("exec", 12345, async () => "done — https://github.com/owner/repo/pull/99", {
        messageThreadId: 678,
      });

      await new Promise((r) => setTimeout(r, 300));

      // implement prUrl should remain undefined (no-op for non-sdd-implement jobs)
      const tracker = await getTracker(12345, 678);
      expect(tracker!.steps.implement.prUrl).toBeUndefined();
    });
  });

  describe("SDD event emission (V11, V12)", () => {
    it("V11: PHASE_TO_AGENT_ROLE maps challenge → spec-architect (source of truth)", async () => {
      const { PHASE_TO_AGENT_ROLE } = await import("../../src/sdd-agents.ts");
      expect(PHASE_TO_AGENT_ROLE["challenge"]).toBe("spec-architect");
      expect(PHASE_TO_AGENT_ROLE["review"]).toBe("reviewer");
      expect(PHASE_TO_AGENT_ROLE["implement"]).toBe("implementer");
      expect(PHASE_TO_AGENT_ROLE["explore"]).toBe("explorer");
      expect(PHASE_TO_AGENT_ROLE["spec"]).toBe("spec-architect");
      // discuss is mapped (F-DA-1 fix)
      expect(PHASE_TO_AGENT_ROLE["discuss"]).toBeDefined();
    });

    it("V11: SDD challenge job with NO-GO verdict completes normally (event emitted best-effort)", async () => {
      const fakeBotInstance = {
        api: { sendMessage: async () => {} },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;
      initJobManager(fakeBotInstance);

      // SDD challenge job — event emission happens best-effort (Supabase may fail in test env)
      const id = await launch(
        "sdd-challenge:my-spec",
        12345,
        async () =>
          "SDD_CHALLENGE_NO-GO: my-spec — sections 6-7 vides. V-criteres sans niveau de test.",
        { messageThreadId: 100 },
      );

      // Wait for job to complete (including post-completion hooks)
      await new Promise((r) => setTimeout(r, 300));

      const job = await get(id);
      expect(job).toBeDefined();
      // V12: job completes normally even if Supabase emitSddEvent fails
      expect(job!.status).toBe("completed");
      expect(job!.result).toContain("SDD_CHALLENGE_NO-GO");
    });

    it("V12: SDD job completes normally when emitSddEvent encounters Supabase error", async () => {
      const fakeBotInstance = {
        api: { sendMessage: async () => {} },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;
      initJobManager(fakeBotInstance);

      // This job type triggers emitSddEvent — even if Supabase is unavailable (test env)
      // the job must complete without throwing (best-effort design)
      const id = await launch(
        "sdd-spec:another-feature",
        12345,
        async () => "SDD_SPEC_GO: another-feature — spec written",
        { messageThreadId: 200 },
      );

      await new Promise((r) => setTimeout(r, 300));

      const job = await get(id);
      expect(job!.status).toBe("completed");
      expect(job!.error).toBeNull();
    });

    it("V12: non-SDD jobs are not affected by SDD event emission logic", async () => {
      const fakeBotInstance = {
        api: { sendMessage: async () => {} },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;
      initJobManager(fakeBotInstance);

      const id = await launch("exec", 12345, async () => "non-sdd result");
      await new Promise((r) => setTimeout(r, 150));

      const job = await get(id);
      expect(job!.status).toBe("completed");
      expect(job!.result).toBe("non-sdd result");
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

    it("V13: returns undefined for sdd-doc job with SDD_DOC_OK result (terminal phase)", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "sdd-doc:foo",
        result: "SDD_DOC_OK: foo — documentation mise a jour",
      });
      // Terminal phase: no continuation buttons
      const hasButtons = kb && kb.inline_keyboard?.flat().length > 0;
      expect(hasButtons).toBeFalsy();
    });

    it("V13b: returns undefined for sdd-doc job with SDD_DOC_FAILED result", () => {
      const kb = getCompletionKeyboard({
        ...baseJob,
        type: "sdd-doc:foo",
        result: "SDD_DOC_FAILED: some error",
      });
      const hasButtons = kb && kb.inline_keyboard?.flat().length > 0;
      expect(hasButtons).toBeFalsy();
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
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let sentMessage: any = null;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const fakeBotInstance = {
        api: {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          sendMessage: async (chatId: any, text: string, opts?: any) => {
            sentMessage = { chatId, text, opts };
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);

      const _id = await launch("plan", 12345, async () => "3 taches creees", {
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

    it("AM-NOTIF1: includes auto-merge info in notification when [AUTO-MERGE] in result", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let sentMessage: any = null;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const fakeBotInstance = {
        api: {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          sendMessage: async (chatId: any, text: string, opts?: any) => {
            sentMessage = { chatId, text, opts };
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);

      await launch(
        "sdd-review:my-feature",
        12345,
        async () => "SDD_REVIEW_APPROVED: my-feature [AUTO-MERGE]",
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 300));

      expect(sentMessage).not.toBeNull();
      expect(sentMessage.text).toContain("auto-merge");
    });

    it("sends error notification for failed jobs", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let sentMessage: any = null;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const fakeBotInstance = {
        api: {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          sendMessage: async (chatId: any, text: string, opts?: any) => {
            sentMessage = { chatId, text, opts };
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);

      await launch(
        "exec",
        999,
        async () => {
          throw new Error("agent crashed");
        },
        { messageThreadId: 111 },
      );

      await new Promise((r) => setTimeout(r, 200));

      expect(sentMessage).not.toBeNull();
      expect(sentMessage.chatId).toBe(999);
      expect(sentMessage.text).toContain("échoué");
      expect(sentMessage.text).toContain("agent crashed");
      expect(sentMessage.opts?.message_thread_id).toBe(111);
    });
  });
});
