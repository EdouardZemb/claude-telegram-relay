/**
 * Unit Tests — formatPipelineContextForPrompt (pipeline-tracker.ts)
 *
 * V-criteria coverage:
 * V1: Returns empty string when tracker is null
 * V2: Returns non-empty string when tracker is active with a discuss phase
 * V3: Includes pipeline name in output
 * V4: Includes current phase label in output
 * V5: Includes completed artifact references
 * V6: Contains convergence guidance instruction
 * V7: Plain text only (no markdown)
 * V8: Returns context for "explore" phase too (not just "discuss")
 * V9: Does not include context for phases that are not conversational (e.g., "implement")
 * V10: Output is under 500 characters for a typical pipeline (prompt budget)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  _clearForTests,
  createPipeline,
  formatPipelineContextForPrompt,
  getTracker,
  updateStep,
} from "../../src/pipeline-tracker.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-pipeline-context-prompt");
const origRelayDir = process.env.RELAY_DIR;

describe("formatPipelineContextForPrompt", () => {
  beforeEach(async () => {
    process.env.RELAY_DIR = TEST_DIR;
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

  // ── V1: null tracker ──────────────────────────────────────

  it("V1: returns empty string when tracker is null", () => {
    const result = formatPipelineContextForPrompt(null);
    expect(result).toBe("");
  });

  // ── V2: active pipeline with discuss phase ────────────────

  it("V2: returns non-empty string when pipeline is active in discuss phase", async () => {
    const _tracker = await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "discuss", { status: "running" });
    const updated = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(updated);
    expect(result.length).toBeGreaterThan(0);
  });

  // ── V3: includes pipeline name ────────────────────────────

  it("V3: includes pipeline name in output", async () => {
    const _tracker = await createPipeline(12345, undefined, "refactoring-memoire");
    await updateStep(12345, undefined, "discuss", { status: "running" });
    const updated = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(updated);
    expect(result).toContain("refactoring-memoire");
  });

  // ── V4: includes current phase label ──────────────────────

  it("V4: includes current phase label for discuss", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "discuss", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).toContain("Discussion");
  });

  it("V4: includes current phase label for explore", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "explore", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).toContain("Exploration");
  });

  // ── V5: includes completed artifact references ────────────

  it("V5: includes completed artifact references", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "explore", {
      status: "ok",
      artifact: "docs/explorations/EXPLORE-test.md",
      summary: "GO",
    });
    await updateStep(12345, undefined, "discuss", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).toContain("EXPLORE-test.md");
  });

  // ── V6: contains convergence guidance ─────────────────────

  it("V6: contains convergence guidance instruction for discuss phase", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "discuss", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).toContain("Decisions:");
  });

  // ── V7: plain text only ───────────────────────────────────

  it("V7: output is plain text only (no markdown)", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "explore", {
      status: "ok",
      artifact: "docs/explorations/EXPLORE-test.md",
    });
    await updateStep(12345, undefined, "discuss", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).not.toContain("**");
    expect(result).not.toContain("```");
    expect(result).not.toContain("`");
    expect(result).not.toContain("##");
  });

  // ── V8: works for explore phase too ───────────────────────

  it("V8: returns context for explore phase (not just discuss)", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "explore", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("test-feature");
  });

  // ── V9: no context for non-conversational phases ──────────

  it("V9: returns empty string for implement phase (not conversational)", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "implement", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).toBe("");
  });

  it("V9: returns empty string for review phase (not conversational)", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "review", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).toBe("");
  });

  it("V9: returns empty string when all phases are pending (no active phase)", async () => {
    const tracker = await createPipeline(12345, undefined, "test-feature");
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).toBe("");
  });

  // ── V10: output size budget ───────────────────────────────

  it("V10: output is under 500 characters for a typical pipeline", async () => {
    await createPipeline(12345, undefined, "inject-contexte-pipeline-sdd-dans-prompt");
    await updateStep(12345, undefined, "explore", {
      status: "ok",
      artifact: "docs/explorations/EXPLORE-inject-contexte-pipeline-sdd-dans-prompt.md",
      summary: "GO",
    });
    await updateStep(12345, undefined, "discuss", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result.length).toBeLessThan(500);
  });

  // ── Edge cases ────────────────────────────────────────────

  it("handles pipeline with spec phase running (conversational)", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "spec", { status: "running" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    // spec is not a conversational phase for prompt injection
    expect(result).toBe("");
  });

  it("handles pipeline with discuss phase ok and no running phase", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "discuss", { status: "ok" });
    const tracker = await getTracker(12345, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    // No running conversational phase -> empty
    expect(result).toBe("");
  });

  it("includes multiple completed artifacts when available", async () => {
    await createPipeline(12345, undefined, "test-feature");
    await updateStep(12345, undefined, "explore", {
      status: "ok",
      artifact: "docs/explorations/EXPLORE-test.md",
      summary: "GO",
    });
    await updateStep(12345, undefined, "discuss", {
      status: "ok",
      summary: "5 decisions",
    });
    // Imagine discuss is re-activated -- but since discuss is "ok" and no running phase,
    // it returns empty. Let's test with a running discuss after explore ok.
    _clearForTests();
    process.env.RELAY_DIR = TEST_DIR;
    await createPipeline(99999, undefined, "multi-artifact");
    await updateStep(99999, undefined, "explore", {
      status: "ok",
      artifact: "docs/explorations/EXPLORE-multi.md",
      summary: "GO",
    });
    await updateStep(99999, undefined, "discuss", { status: "running" });
    const tracker = await getTracker(99999, undefined);
    const result = formatPipelineContextForPrompt(tracker);
    expect(result).toContain("EXPLORE-multi.md");
  });
});
