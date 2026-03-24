import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  _clearForTests,
  createPipeline,
  formatStatusBar,
  getTracker,
  initPipelineTracker,
  toPipelineName,
  updateStep,
  type PipelineTracker,
  type SddPhase,
} from "../../src/pipeline-tracker.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-pipeline-tracker");
const PIPELINES_FILE = join(TEST_DIR, "pipelines.json");

// Override RELAY_DIR for tests
const origRelayDir = process.env.RELAY_DIR;

describe("pipeline-tracker", () => {
  beforeEach(async () => {
    process.env.RELAY_DIR = TEST_DIR;
    // Clean slate: remove old test dir and recreate
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await mkdir(TEST_DIR, { recursive: true });
    _clearForTests();
  });

  afterEach(async () => {
    _clearForTests();
    process.env.RELAY_DIR = origRelayDir;
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  // ── V1: toPipelineName basic ──────────────────────────────

  describe("toPipelineName", () => {
    it("V1: converts description to kebab-case", () => {
      expect(toPipelineName("Refactoring memoire permanente")).toBe(
        "refactoring-memoire-permanente",
      );
    });

    it("V2: handles diacritics and punctuation", () => {
      expect(toPipelineName("Phase 2 : Creer les modules (avec accents)")).toBe(
        "phase-2-creer-les-modules-avec-accents",
      );
    });

    it("handles empty string", () => {
      expect(toPipelineName("")).toBe("");
    });

    it("handles special characters", () => {
      expect(toPipelineName("Hello!!! World...")).toBe("hello-world");
    });

    it("collapses multiple hyphens", () => {
      expect(toPipelineName("a---b")).toBe("a-b");
    });

    it("trims leading/trailing hyphens", () => {
      expect(toPipelineName("---hello---")).toBe("hello");
    });
  });

  // ── V3: createPipeline ────────────────────────────────────

  describe("createPipeline", () => {
    it("V3: creates tracker with 6 steps all pending", async () => {
      const tracker = await createPipeline(12345, undefined, "test-pipeline");

      expect(tracker.chatId).toBe(12345);
      expect(tracker.name).toBe("test-pipeline");
      expect(tracker.createdAt).toBeTruthy();
      expect(tracker.updatedAt).toBeTruthy();

      const phases: SddPhase[] = ["explore", "discuss", "spec", "challenge", "implement", "review"];
      for (const phase of phases) {
        expect(tracker.steps[phase]).toBeDefined();
        expect(tracker.steps[phase].status).toBe("pending");
        expect(tracker.steps[phase].phase).toBe(phase);
      }
    });

    it("V4: storage key for threadId=67 is '12345:67'", async () => {
      await createPipeline(12345, 67, "test");
      const tracker = await getTracker(12345, 67);
      expect(tracker).not.toBeNull();
      expect(tracker!.chatId).toBe(12345);
      expect(tracker!.threadId).toBe(67);
    });

    it("V4: storage key for threadId=undefined is '12345:main'", async () => {
      await createPipeline(12345, undefined, "test");
      const tracker = await getTracker(12345, undefined);
      expect(tracker).not.toBeNull();
      expect(tracker!.chatId).toBe(12345);
    });

    it("stores threadId when provided", async () => {
      const tracker = await createPipeline(12345, 67, "test");
      expect(tracker.threadId).toBe(67);
    });
  });

  // ── V5: TTL expiry ────────────────────────────────────────

  describe("getTracker TTL", () => {
    it("V5: returns null after TTL 7 days", async () => {
      const tracker = await createPipeline(12345, undefined, "old-pipeline");

      // Manually backdate the updatedAt
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      tracker.updatedAt = eightDaysAgo;

      // Force save so the backdated tracker is persisted
      _clearForTests();

      // Write directly to disk to simulate old data
      const entries = [{ key: "12345:main", tracker }];
      await writeFile(PIPELINES_FILE, JSON.stringify(entries, null, 2));

      const result = await getTracker(12345, undefined);
      expect(result).toBeNull();
    });

    it("returns tracker when within TTL", async () => {
      await createPipeline(12345, undefined, "fresh-pipeline");
      const tracker = await getTracker(12345, undefined);
      expect(tracker).not.toBeNull();
      expect(tracker!.name).toBe("fresh-pipeline");
    });

    it("returns null for unknown chatId", async () => {
      const result = await getTracker(99999, undefined);
      expect(result).toBeNull();
    });
  });

  // ── V5b: updateStep ───────────────────────────────────────

  describe("updateStep", () => {
    it("updates step status and refreshes updatedAt", async () => {
      const tracker = await createPipeline(12345, undefined, "test");
      const originalUpdatedAt = tracker.updatedAt;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      await updateStep(12345, undefined, "explore", { status: "running" });

      const updated = await getTracker(12345, undefined);
      expect(updated!.steps.explore.status).toBe("running");
      expect(updated!.steps.explore.startedAt).toBeTruthy();
      expect(updated!.updatedAt).not.toBe(originalUpdatedAt);
    });

    it("updates artifact and summary", async () => {
      await createPipeline(12345, undefined, "test");
      await updateStep(12345, undefined, "explore", {
        status: "ok",
        artifact: "docs/explorations/EXPLORE-test.md",
        summary: "GO — 3 alternatives",
      });

      const tracker = await getTracker(12345, undefined);
      expect(tracker!.steps.explore.artifact).toBe("docs/explorations/EXPLORE-test.md");
      expect(tracker!.steps.explore.summary).toBe("GO — 3 alternatives");
      expect(tracker!.steps.explore.completedAt).toBeTruthy();
    });

    it("updates jobId", async () => {
      await createPipeline(12345, undefined, "test");
      await updateStep(12345, undefined, "spec", { jobId: "abc123" });

      const tracker = await getTracker(12345, undefined);
      expect(tracker!.steps.spec.jobId).toBe("abc123");
    });

    it("no-op when tracker not found", async () => {
      // Should not throw
      await updateStep(99999, undefined, "explore", { status: "running" });
    });

    it("sets completedAt when status is ok or failed", async () => {
      await createPipeline(12345, undefined, "test");
      await updateStep(12345, undefined, "explore", { status: "ok" });

      const tracker = await getTracker(12345, undefined);
      expect(tracker!.steps.explore.completedAt).toBeTruthy();
    });
  });

  // ── V6, V7: formatStatusBar ───────────────────────────────

  describe("formatStatusBar", () => {
    it("V6: produces correct symbol for each status", () => {
      const tracker: PipelineTracker = {
        chatId: 12345,
        name: "test-pipeline",
        steps: {
          explore: { phase: "explore", status: "ok" },
          discuss: { phase: "discuss", status: "running" },
          spec: { phase: "spec", status: "pending" },
          challenge: { phase: "challenge", status: "failed" },
          implement: { phase: "implement", status: "pending" },
          review: { phase: "review", status: "pending" },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const bar = formatStatusBar(tracker);
      expect(bar).toContain("OK Exploration");
      expect(bar).toContain("EN COURS Discussion");
      expect(bar).toContain("-- Spec");
      expect(bar).toContain("ECHEC Challenge");
    });

    it("V7: displays artifact when present", () => {
      const tracker: PipelineTracker = {
        chatId: 12345,
        name: "test-pipeline",
        steps: {
          explore: {
            phase: "explore",
            status: "ok",
            artifact: "docs/explorations/EXPLORE-test.md",
            summary: "GO",
          },
          discuss: { phase: "discuss", status: "ok", summary: "3 decisions" },
          spec: { phase: "spec", status: "pending" },
          challenge: { phase: "challenge", status: "pending" },
          implement: { phase: "implement", status: "pending" },
          review: { phase: "review", status: "pending" },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const bar = formatStatusBar(tracker);
      expect(bar).toContain("EXPLORE-test.md");
      expect(bar).toContain("(GO)");
      expect(bar).toContain("(3 decisions)");
    });

    it("includes pipeline name in header", () => {
      const tracker: PipelineTracker = {
        chatId: 12345,
        name: "refactoring-memoire",
        steps: {
          explore: { phase: "explore", status: "pending" },
          discuss: { phase: "discuss", status: "pending" },
          spec: { phase: "spec", status: "pending" },
          challenge: { phase: "challenge", status: "pending" },
          implement: { phase: "implement", status: "pending" },
          review: { phase: "review", status: "pending" },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const bar = formatStatusBar(tracker);
      expect(bar).toStartWith("Pipeline « refactoring-memoire »");
    });

    it("is plain text only (no markdown)", () => {
      const tracker: PipelineTracker = {
        chatId: 12345,
        name: "test",
        steps: {
          explore: { phase: "explore", status: "ok", summary: "GO" },
          discuss: { phase: "discuss", status: "ok" },
          spec: { phase: "spec", status: "running" },
          challenge: { phase: "challenge", status: "pending" },
          implement: { phase: "implement", status: "pending" },
          review: { phase: "review", status: "pending" },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const bar = formatStatusBar(tracker);
      expect(bar).not.toContain("*");
      expect(bar).not.toContain("_");
      expect(bar).not.toContain("`");
    });

    it("adds ... indicator for running status", () => {
      const tracker: PipelineTracker = {
        chatId: 12345,
        name: "test",
        steps: {
          explore: { phase: "explore", status: "ok" },
          discuss: { phase: "discuss", status: "ok" },
          spec: { phase: "spec", status: "running" },
          challenge: { phase: "challenge", status: "pending" },
          implement: { phase: "implement", status: "pending" },
          review: { phase: "review", status: "pending" },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const bar = formatStatusBar(tracker);
      expect(bar).toContain("EN COURS Spec...");
    });
  });

  // ── V8: Persistence round-trip ────────────────────────────

  describe("persistence", () => {
    it("V8: createPipeline then _clearForTests then getTracker loads from disk", async () => {
      await createPipeline(12345, undefined, "persist-test");

      // Clear in-memory
      _clearForTests();

      // getTracker should reload from disk
      const tracker = await getTracker(12345, undefined);
      expect(tracker).not.toBeNull();
      expect(tracker!.name).toBe("persist-test");
      expect(tracker!.chatId).toBe(12345);
    });

    it("V9: _clearForTests voids in-memory store and forces disk reload", async () => {
      await createPipeline(12345, undefined, "clear-test");
      const before = await getTracker(12345, undefined);
      expect(before).not.toBeNull();

      _clearForTests();

      // After clear, next call should reload from disk
      const after = await getTracker(12345, undefined);
      expect(after).not.toBeNull();
      expect(after!.name).toBe("clear-test");
    });

    it("handles missing RELAY_DIR gracefully", async () => {
      process.env.RELAY_DIR = join(TEST_DIR, "nonexistent-subdir");
      _clearForTests();

      // Should not throw
      const tracker = await getTracker(99999, undefined);
      expect(tracker).toBeNull();
    });

    it("handles corrupted JSON gracefully", async () => {
      await writeFile(PIPELINES_FILE, "INVALID JSON{{{");
      _clearForTests();

      // Should not throw
      const tracker = await getTracker(12345, undefined);
      expect(tracker).toBeNull();
    });
  });

  // ── V21 (partial): No forbidden imports ────────────────────

  describe("import constraints", () => {
    it("V21: pipeline-tracker.ts does not import from forbidden modules", async () => {
      const content = await readFile(
        join(import.meta.dir, "..", "..", "src", "pipeline-tracker.ts"),
        "utf-8",
      );

      expect(content).not.toContain('from "./orchestrator');
      expect(content).not.toContain("from './orchestrator");
      expect(content).not.toContain('from "./blackboard');
      expect(content).not.toContain("from './blackboard");
      expect(content).not.toContain('from "./agent-schemas');
      expect(content).not.toContain("from './agent-schemas");
      expect(content).not.toContain('from "./pipeline-state');
      expect(content).not.toContain("from './pipeline-state");
    });
  });

  // ── initPipelineTracker ────────────────────────────────────

  describe("initPipelineTracker", () => {
    it("pre-loads from disk without error", async () => {
      // Write some data first
      const entries = [
        {
          key: "12345:main",
          tracker: {
            chatId: 12345,
            name: "init-test",
            steps: {
              explore: { phase: "explore", status: "pending" },
              discuss: { phase: "discuss", status: "pending" },
              spec: { phase: "spec", status: "pending" },
              challenge: { phase: "challenge", status: "pending" },
              implement: { phase: "implement", status: "pending" },
              review: { phase: "review", status: "pending" },
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      ];
      await writeFile(PIPELINES_FILE, JSON.stringify(entries, null, 2));
      _clearForTests();

      await initPipelineTracker();
      const tracker = await getTracker(12345, undefined);
      expect(tracker).not.toBeNull();
      expect(tracker!.name).toBe("init-test");
    });
  });
});
