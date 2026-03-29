/**
 * Unit tests — src/maturation/observability.ts
 *
 * V-criteria:
 * V1: getMaturationStats returns zero stats when no runs exist
 * V2: getMaturationStats counts totalRuns and completedRuns
 * V3: getMaturationStats extracts maturity scores correctly
 * V4: getMaturationStats counts showstoppers
 * V5: getMaturationStats counts loop-backs (iteration > 0)
 * V6: getMaturationStats tracks overlaysUsed
 * V7: formatMaturationStats returns readable text with no runs
 * V8: formatMaturationStats includes recent runs summary
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

import { _setBaseDirForTests, initRun, saveRunMeta } from "../../src/maturation/documents.ts";
import { formatMaturationStats, getMaturationStats } from "../../src/maturation/observability.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-observability");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  _setBaseDirForTests(TEST_DIR);
});

afterEach(async () => {
  _setBaseDirForTests(undefined);
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("maturation/observability — getMaturationStats", () => {
  it("V1: returns zero stats when no runs", async () => {
    const stats = await getMaturationStats();
    expect(stats.totalRuns).toBe(0);
    expect(stats.completedRuns).toBe(0);
    expect(stats.showstopperCount).toBe(0);
    expect(stats.avgMaturityScore).toBe(0);
    expect(stats.recentRuns).toHaveLength(0);
  });

  it("V2: counts totalRuns and completedRuns", async () => {
    const run1 = createEmptyRun(1, undefined, "run-a", "idea a");
    await initRun(run1);

    const run2 = createEmptyRun(1, undefined, "run-b", "idea b");
    run2.currentPhase = "validate";
    await initRun(run2);

    const stats = await getMaturationStats();
    expect(stats.totalRuns).toBe(2);
    expect(stats.completedRuns).toBe(1);
  });

  it("V3: extracts maturity score from synthesize step", async () => {
    const run = createEmptyRun(1, undefined, "scored-run", "idea");
    run.steps.synthesize.status = "ok";
    run.steps.synthesize.score = 8;
    run.steps.synthesize.documents = [];
    await initRun(run);
    await saveRunMeta(run);

    const stats = await getMaturationStats();
    expect(stats.avgMaturityScore).toBe(8);
  });

  it("V4: counts showstoppers from advocate verdict", async () => {
    const run = createEmptyRun(1, undefined, "stop-run", "idea");
    run.steps.advocate.status = "ok";
    run.steps.advocate.verdict = "SHOWSTOPPER: Critical flaw";
    run.steps.advocate.documents = [];
    await initRun(run);
    await saveRunMeta(run);

    const stats = await getMaturationStats();
    expect(stats.showstopperCount).toBe(1);
  });

  it("V5: counts loop-backs from iteration > 0", async () => {
    const run = createEmptyRun(1, undefined, "loop-run", "idea");
    run.iteration = 1;
    await initRun(run);
    await saveRunMeta(run);

    const stats = await getMaturationStats();
    expect(stats.loopbackCount).toBe(1);
  });

  it("V6: detects overlaysUsed from step flags", async () => {
    const run = createEmptyRun(1, undefined, "overlay-run", "idea");
    run.steps.explore.overlaysUsed = true;
    await initRun(run);
    await saveRunMeta(run);

    const stats = await getMaturationStats();
    expect(stats.overlayUsageCount).toBe(1);
  });
});

describe("maturation/observability — formatMaturationStats", () => {
  it("V7: returns message for zero runs", () => {
    const text = formatMaturationStats({
      totalRuns: 0,
      completedRuns: 0,
      showstopperCount: 0,
      loopbackCount: 0,
      avgMaturityScore: 0,
      overlayUsageCount: 0,
      byPhase: {},
      recentRuns: [],
    });
    expect(text).toContain("Aucun run");
  });

  it("V8: includes run summary with score and phase", () => {
    const text = formatMaturationStats({
      totalRuns: 2,
      completedRuns: 1,
      showstopperCount: 0,
      loopbackCount: 0,
      avgMaturityScore: 7.5,
      overlayUsageCount: 0,
      byPhase: { validate: 1, advocate: 1 },
      recentRuns: [
        {
          id: "abc12345",
          name: "my-feature-idea",
          currentPhase: "validate",
          maturityScore: 8,
          hasShowstopper: false,
          iteration: 0,
          overlaysUsed: false,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(text).toContain("my-feature-idea");
    expect(text).toContain("validate");
    expect(text).toContain("8/10");
    expect(text).toContain("7.5");
  });
});
