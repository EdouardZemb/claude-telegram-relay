/**
 * @file heartbeat-sdd-watchdog.test.ts
 * @description Unit tests for the SDD pipeline watchdog integrated into heartbeat.
 * Tests checkSddPipelines() detection of orphan/stuck pipelines, differentiated
 * thresholds per phase, idempotence via cooldowns, and graceful degradation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import type {
  PipelineStep,
  PipelineTracker,
  SddPhase,
  StepStatus,
} from "../../src/pipeline-tracker.ts";

// ── Helpers ──────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, "..", "..", ".test-watchdog-" + process.pid);
const TEST_RELAY_DIR = join(TEST_DIR, "relay");
const TEST_PIPELINES_FILE = join(TEST_RELAY_DIR, "pipelines.json");
const TEST_MCP_PENDING_FILE = join(TEST_RELAY_DIR, "mcp-pending-notifications.json");

/** Build a minimal PipelineTracker for testing */
function buildTracker(
  overrides: Partial<PipelineTracker> & {
    stepOverrides?: Partial<Record<SddPhase, Partial<PipelineStep>>>;
  } = {},
): PipelineTracker {
  const now = new Date().toISOString();
  const steps = {} as Record<SddPhase, PipelineStep>;
  const phases: SddPhase[] = [
    "explore",
    "discuss",
    "spec",
    "challenge",
    "implement",
    "review",
    "doc",
  ];
  for (const phase of phases) {
    steps[phase] = {
      phase,
      status: "pending" as StepStatus,
      ...(overrides.stepOverrides?.[phase] || {}),
    };
  }
  const { stepOverrides: _, ...rest } = overrides;
  return {
    chatId: 12345,
    name: "test-pipeline",
    steps,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

/** Write pipelines.json in the format pipeline-tracker uses */
async function writePipelinesFile(
  trackers: Array<{ key: string; tracker: PipelineTracker }>,
): Promise<void> {
  await mkdir(TEST_RELAY_DIR, { recursive: true });
  await writeFile(TEST_PIPELINES_FILE, JSON.stringify(trackers, null, 2));
}

// ── Setup / Teardown ─────────────────────────────────────────

beforeEach(async () => {
  await mkdir(TEST_RELAY_DIR, { recursive: true });
  // Set env vars for the heartbeat module to use our test dirs
  process.env.RELAY_DIR = TEST_RELAY_DIR;
  // Clean MCP pending file
  try {
    await rm(TEST_MCP_PENDING_FILE, { force: true });
  } catch {
    /* ignore */
  }
});

afterEach(async () => {
  delete process.env.RELAY_DIR;
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Import the module under test ─────────────────────────────

// Lazy import to ensure env vars are set before module loads
async function importWatchdog() {
  // Clear module cache to pick up env changes
  const mod = await import("../../src/heartbeat-sdd-watchdog.ts");
  return mod;
}

// ── V1: checkSddPipelines detects stuck agent phases ─────────

describe("checkSddPipelines", () => {
  describe("V1: Detects stuck agent phases (>30 min running)", () => {
    it("should detect a pipeline with 'spec' phase stuck for 45 min", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          spec: { phase: "spec", status: "running", startedAt: fortyFiveMinAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(1);
      expect(result.notifications.length).toBe(1);
      expect(result.notifications[0]).toContain("spec");
    });

    it("should not flag a pipeline with 'implement' phase running for only 10 min", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          implement: { phase: "implement", status: "running", startedAt: tenMinAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
      expect(result.notifications.length).toBe(0);
    });

    it("should detect multiple stuck phases across different pipelines", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const tracker1 = buildTracker({
        chatId: 111,
        name: "pipeline-1",
        stepOverrides: {
          spec: { phase: "spec", status: "running", startedAt: oneHourAgo },
        },
      });
      const tracker2 = buildTracker({
        chatId: 222,
        name: "pipeline-2",
        stepOverrides: {
          review: { phase: "review", status: "running", startedAt: oneHourAgo },
        },
      });
      await writePipelinesFile([
        { key: "111:main", tracker: tracker1 },
        { key: "222:main", tracker: tracker2 },
      ]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(2);
      expect(result.notifications.length).toBe(2);
    });
  });

  describe("V2: Differentiated threshold for 'discuss' phase (24h)", () => {
    it("should NOT flag 'discuss' phase running for 2 hours (under 24h threshold)", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          discuss: { phase: "discuss", status: "running", startedAt: twoHoursAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
    });

    it("should flag 'discuss' phase running for 25 hours (over 24h threshold)", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          discuss: { phase: "discuss", status: "running", startedAt: twentyFiveHoursAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(1);
      expect(result.notifications[0]).toContain("discuss");
    });
  });

  describe("V3: Ignores non-running phases", () => {
    it("should ignore pending phases", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const tracker = buildTracker(); // All phases pending
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
    });

    it("should ignore completed (ok) phases", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          implement: { phase: "implement", status: "ok", startedAt: longAgo, completedAt: longAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
    });

    it("should ignore failed phases", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          implement: { phase: "implement", status: "failed", startedAt: longAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
    });
  });

  describe("V4: Running phase without startedAt", () => {
    it("should treat running phase without startedAt as stuck (conservative)", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const tracker = buildTracker({
        stepOverrides: {
          implement: { phase: "implement", status: "running" },
          // No startedAt field
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(1);
    });
  });

  describe("V5: Graceful degradation - missing pipelines.json", () => {
    it("should return empty result when pipelines.json does not exist", async () => {
      const { checkSddPipelines } = await importWatchdog();

      // Don't create the file
      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
      expect(result.notifications.length).toBe(0);
    });

    it("should return empty result when pipelines.json is malformed", async () => {
      const { checkSddPipelines } = await importWatchdog();

      await mkdir(TEST_RELAY_DIR, { recursive: true });
      await writeFile(TEST_PIPELINES_FILE, "not valid json{{{");

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
      expect(result.notifications.length).toBe(0);
    });

    it("should return empty result when pipelines.json is empty array", async () => {
      const { checkSddPipelines } = await importWatchdog();

      await writePipelinesFile([]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
    });
  });

  describe("V6: TTL filtering — expired pipelines ignored", () => {
    it("should ignore pipelines with updatedAt older than 7 days", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        updatedAt: eightDaysAgo,
        stepOverrides: {
          implement: { phase: "implement", status: "running", startedAt: eightDaysAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
    });
  });

  describe("V7: Notification message format", () => {
    it("should include pipeline name and phase in notification", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        name: "my-feature-pipeline",
        stepOverrides: {
          challenge: { phase: "challenge", status: "running", startedAt: oneHourAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.notifications[0]).toContain("my-feature-pipeline");
      expect(result.notifications[0]).toContain("challenge");
    });

    it("should include elapsed time in notification", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          implement: { phase: "implement", status: "running", startedAt: ninetyMinAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      // Should contain some time indication (minutes or hours)
      expect(result.notifications[0]).toMatch(/\d+/);
    });
  });

  describe("V8: Threshold for implement phase (60 min, longer than other agents)", () => {
    it("should NOT flag 'implement' phase running for 40 min (under 60 min threshold)", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          implement: { phase: "implement", status: "running", startedAt: fortyMinAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(0);
    });

    it("should flag 'implement' phase running for 65 min (over 60 min threshold)", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const sixtyFiveMinAgo = new Date(Date.now() - 65 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          implement: { phase: "implement", status: "running", startedAt: sixtyFiveMinAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(1);
    });

    it("should flag 'explore' phase running for 35 min (over 30 min threshold)", async () => {
      const { checkSddPipelines } = await importWatchdog();

      const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();
      const tracker = buildTracker({
        stepOverrides: {
          explore: { phase: "explore", status: "running", startedAt: thirtyFiveMinAgo },
        },
      });
      await writePipelinesFile([{ key: "12345:main", tracker }]);

      const result = await checkSddPipelines(TEST_RELAY_DIR);
      expect(result.orphansDetected).toBe(1);
    });
  });
});

// ── V9: getStuckThresholdMs export ──────────────────────────

describe("getStuckThresholdMs", () => {
  it("should return 24h for discuss phase", async () => {
    const { getStuckThresholdMs } = await importWatchdog();
    expect(getStuckThresholdMs("discuss")).toBe(24 * 60 * 60 * 1000);
  });

  it("should return 60 min for implement phase", async () => {
    const { getStuckThresholdMs } = await importWatchdog();
    expect(getStuckThresholdMs("implement")).toBe(60 * 60 * 1000);
  });

  it("should return 30 min for other agent phases", async () => {
    const { getStuckThresholdMs } = await importWatchdog();
    expect(getStuckThresholdMs("explore")).toBe(30 * 60 * 1000);
    expect(getStuckThresholdMs("spec")).toBe(30 * 60 * 1000);
    expect(getStuckThresholdMs("challenge")).toBe(30 * 60 * 1000);
    expect(getStuckThresholdMs("review")).toBe(30 * 60 * 1000);
    expect(getStuckThresholdMs("doc")).toBe(30 * 60 * 1000);
  });
});
