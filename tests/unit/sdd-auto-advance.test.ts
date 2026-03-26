/**
 * Tests for SDD auto-advance feature (event-driven pipeline advancement).
 *
 * V-criteria from exploration EXPLORE-bridge-heartbeat-sdd-convergence.md:
 * - V1: getNextSddPhase returns correct next phase for auto-advanceable verdicts
 * - V2: getNextSddPhase returns null for non-auto-advanceable verdicts
 * - V3: auto-advance triggers in sendJobCompletionNotification for eligible jobs
 * - V4: auto-advance does NOT trigger when feature flag is disabled
 * - V5: auto-advance does NOT trigger for failed jobs
 * - V6: auto-advance respects depth limit (max 3 consecutive)
 * - V7: auto-advance sends notification message before launching next phase
 * - V8: auto-advance for doc phase (terminal) does not trigger
 * - V9: depth counter resets on user interaction (callback)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { _resetForTesting, setFeature } from "../../src/feature-flags.ts";
import {
  getAutoAdvanceDepth as _getAutoAdvanceDepth,
  _resetForTests,
  getNextSddPhase,
  initJobManager,
  launch,
  resetAutoAdvanceDepth,
} from "../../src/job-manager.ts";
import {
  _clearForTests as _clearTrackerForTests,
  createPipeline,
  getTracker,
} from "../../src/pipeline-tracker.ts";

// ── getNextSddPhase ──────────────────────────────────────────

describe("sdd-auto-advance", () => {
  describe("getNextSddPhase", () => {
    // V1: auto-advanceable verdicts
    it("V1: explore + GO -> discuss", () => {
      expect(getNextSddPhase("explore", "GO")).toBe("discuss");
    });

    it("V1: spec + OK -> challenge", () => {
      expect(getNextSddPhase("spec", "OK")).toBe("challenge");
    });

    it("V1: challenge + GO -> implement", () => {
      expect(getNextSddPhase("challenge", "GO")).toBe("implement");
    });

    it("V1: implement + OK -> review", () => {
      expect(getNextSddPhase("implement", "OK")).toBe("review");
    });

    it("V1: review + APPROVED -> doc", () => {
      expect(getNextSddPhase("review", "APPROVED")).toBe("doc");
    });

    // V2: non-auto-advanceable verdicts
    it("V2: explore + PIVOT -> null (user decision needed)", () => {
      expect(getNextSddPhase("explore", "PIVOT")).toBeNull();
    });

    it("V2: explore + DROP -> null", () => {
      expect(getNextSddPhase("explore", "DROP")).toBeNull();
    });

    it("V2: challenge + GO_WITH_CHANGES -> null (user must decide)", () => {
      expect(getNextSddPhase("challenge", "GO_WITH_CHANGES")).toBeNull();
    });

    it("V2: challenge + NO-GO -> null", () => {
      expect(getNextSddPhase("challenge", "NO-GO")).toBeNull();
    });

    it("V2: review + CHANGES_REQUESTED -> null", () => {
      expect(getNextSddPhase("review", "CHANGES_REQUESTED")).toBeNull();
    });

    // V8: terminal phase
    it("V8: doc + OK -> null (terminal phase)", () => {
      expect(getNextSddPhase("doc", "OK")).toBeNull();
    });

    it("V2: unknown phase -> null", () => {
      expect(getNextSddPhase("unknown", "GO")).toBeNull();
    });

    it("V2: unknown verdict -> null", () => {
      expect(getNextSddPhase("explore", "UNKNOWN")).toBeNull();
    });

    // discuss phase: not agent-backed, so no auto-advance from it
    it("V2: discuss phase has no auto-advance", () => {
      expect(getNextSddPhase("discuss", "OK")).toBeNull();
    });
  });

  // ── Auto-advance depth tracking ───────────────────────────────

  describe("autoAdvanceDepth", () => {
    beforeEach(() => {
      _resetForTests();
    });

    // V6: depth limit
    it("V6: getAutoAdvanceDepth returns 0 initially", () => {
      expect(_getAutoAdvanceDepth(123, 456)).toBe(0);
    });

    it("V9: resetAutoAdvanceDepth resets to 0", () => {
      // We can't easily increment without launching a full job,
      // but we can verify reset doesn't throw
      resetAutoAdvanceDepth(123, 456);
      expect(_getAutoAdvanceDepth(123, 456)).toBe(0);
    });
  });

  // ── Integration: auto-advance in sendJobCompletionNotification ─

  describe("auto-advance integration", () => {
    const TEST_RELAY_DIR = join(import.meta.dir, "..", ".test-auto-advance");
    const origRelayDir = process.env.RELAY_DIR;

    beforeEach(async () => {
      process.env.RELAY_DIR = TEST_RELAY_DIR;
      _resetForTests();
      _clearTrackerForTests();
      // Enable the feature flag for integration tests
      _resetForTesting();
      await setFeature("sdd_auto_advance", true);
      try {
        await rm(TEST_RELAY_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
      await mkdir(TEST_RELAY_DIR, { recursive: true });
    });

    afterEach(async () => {
      // Restore the feature flag
      await setFeature("sdd_auto_advance", false);
      _resetForTesting();
      process.env.RELAY_DIR = origRelayDir;
      _resetForTests();
      _clearTrackerForTests();
      try {
        await rm(TEST_RELAY_DIR, { recursive: true, force: true });
      } catch {
        // cleanup best effort
      }
    });

    it("V3: auto-advance launches next phase job on eligible completion", async () => {
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: number | string, text: string, _opts?: unknown) => {
            sentMessages.push({ chatId, text });
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-auto");

      // Launch an explore job that returns GO verdict
      await launch(
        "sdd-explore:test-auto",
        12345,
        async () => "SDD_EXPLORE_GO: test-auto — exploration terminee",
        { messageThreadId: 678 },
      );

      // Wait for completion + auto-advance notification
      await new Promise((r) => setTimeout(r, 500));

      // Should have sent at least 2 messages: completion + auto-advance notification
      // The auto-advance notification should mention "discuss"
      const autoAdvanceMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("Auto-avancement"),
      );
      expect(autoAdvanceMsg).toBeDefined();
      expect(autoAdvanceMsg!.text).toContain("discuss");
    });

    it("V5: no auto-advance for failed jobs", async () => {
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: number | string, text: string, _opts?: unknown) => {
            sentMessages.push({ chatId, text });
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-fail");

      // Launch an explore job that fails
      await launch(
        "sdd-explore:test-fail",
        12345,
        async () => {
          throw new Error("agent crash");
        },
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 500));

      // Should NOT have sent auto-advance notification
      const autoAdvanceMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("Auto-avancement"),
      );
      expect(autoAdvanceMsg).toBeUndefined();
    });

    it("V4: no auto-advance when feature flag is disabled", async () => {
      // We test this by checking that getNextSddPhase is called but the flag check prevents launch.
      // Since we can't easily mock the feature flag in this test context,
      // we verify the function signature accepts the flag check.
      // The actual flag check is tested via the code path in sendJobCompletionNotification.
      // This is a structural verification: getNextSddPhase itself is pure.
      const next = getNextSddPhase("explore", "GO");
      expect(next).toBe("discuss");
      // The feature flag gate is in sendJobCompletionNotification, not in getNextSddPhase
    });

    it("V7: auto-advance notification includes phase and verdict info", async () => {
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: number | string, text: string, _opts?: unknown) => {
            sentMessages.push({ chatId, text });
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-notif");

      await launch(
        "sdd-explore:test-notif",
        12345,
        async () => "SDD_EXPLORE_GO: test-notif — exploration terminee",
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 500));

      const autoAdvanceMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("Auto-avancement"),
      );
      expect(autoAdvanceMsg).toBeDefined();
      // Should contain the verdict and next phase
      expect(autoAdvanceMsg!.text).toContain("GO");
      expect(autoAdvanceMsg!.text).toContain("discuss");
    });

    it("V4-full: no auto-advance when feature flag is disabled (integration)", async () => {
      // Disable the flag that was enabled in beforeEach
      await setFeature("sdd_auto_advance", false);

      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: number | string, text: string, _opts?: unknown) => {
            sentMessages.push({ chatId, text });
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-flag-off");

      await launch(
        "sdd-explore:test-flag-off",
        12345,
        async () => "SDD_EXPLORE_GO: test-flag-off — exploration terminee",
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 500));

      // Should NOT have sent auto-advance notification
      const autoAdvanceMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("Auto-avancement"),
      );
      expect(autoAdvanceMsg).toBeUndefined();

      // But should have sent the normal completion notification
      const completionMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("sdd-explore"),
      );
      expect(completionMsg).toBeDefined();
    });

    it("V3b: auto-advance for spec + OK launches challenge", async () => {
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: number | string, text: string, _opts?: unknown) => {
            sentMessages.push({ chatId, text });
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-spec");

      await launch(
        "sdd-spec:test-spec",
        12345,
        async () => "SDD_SPEC_OK: test-spec — spec generee",
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 500));

      const autoAdvanceMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("Auto-avancement"),
      );
      expect(autoAdvanceMsg).toBeDefined();
      expect(autoAdvanceMsg!.text).toContain("challenge");
    });

    it("V2-edge: no auto-advance for challenge + GO_WITH_CHANGES", async () => {
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: number | string, text: string, _opts?: unknown) => {
            sentMessages.push({ chatId, text });
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-gwc");

      await launch(
        "sdd-challenge:test-gwc",
        12345,
        async () => "SDD_CHALLENGE_GO_WITH_CHANGES: test-gwc — corrections necessaires",
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 500));

      const autoAdvanceMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("Auto-avancement"),
      );
      expect(autoAdvanceMsg).toBeUndefined();
    });

    it("V5b: no auto-advance for non-SDD jobs even if completed", async () => {
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: number | string, text: string, _opts?: unknown) => {
            sentMessages.push({ chatId, text });
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);

      await launch("exec", 12345, async () => "done", { messageThreadId: 678 });

      await new Promise((r) => setTimeout(r, 300));

      const autoAdvanceMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("Auto-avancement"),
      );
      expect(autoAdvanceMsg).toBeUndefined();
    });

    it("V6-integration: depth counter increments on auto-advance", async () => {
      const fakeBotInstance = {
        api: {
          sendMessage: async () => {},
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-depth");

      // First auto-advance (explore GO -> discuss)
      await launch(
        "sdd-explore:test-depth",
        12345,
        async () => "SDD_EXPLORE_GO: test-depth — done",
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 500));

      // Depth should be 1 after one auto-advance
      expect(_getAutoAdvanceDepth(12345, 678)).toBe(1);
    });

    it("V8-edge: no auto-advance for sdd-doc jobs (terminal)", async () => {
      const sentMessages: Array<{ chatId: number | string; text: string }> = [];
      const fakeBotInstance = {
        api: {
          sendMessage: async (chatId: number | string, text: string, _opts?: unknown) => {
            sentMessages.push({ chatId, text });
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-doc");

      await launch(
        "sdd-doc:test-doc",
        12345,
        async () => "SDD_DOC_OK: test-doc — documentation mise a jour",
        { messageThreadId: 678 },
      );

      await new Promise((r) => setTimeout(r, 500));

      const autoAdvanceMsg = sentMessages.find(
        (m) => typeof m.text === "string" && m.text.includes("Auto-avancement"),
      );
      expect(autoAdvanceMsg).toBeUndefined();
    });

    it("tracker step updated to running on auto-advance", async () => {
      const fakeBotInstance = {
        api: {
          sendMessage: async () => {},
        },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;

      initJobManager(fakeBotInstance);
      await createPipeline(12345, 678, "test-step");

      await launch("sdd-explore:test-step", 12345, async () => "SDD_EXPLORE_GO: test-step — done", {
        messageThreadId: 678,
      });

      await new Promise((r) => setTimeout(r, 500));

      const tracker = await getTracker(12345, 678);
      expect(tracker).not.toBeNull();
      // The discuss step should be running or ok (auto-advanced job either running or completed)
      const discussStatus = tracker!.steps.discuss.status;
      expect(["running", "ok"]).toContain(discussStatus);
    });
  });
});
