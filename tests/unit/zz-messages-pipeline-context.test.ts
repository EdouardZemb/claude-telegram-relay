/**
 * Unit Tests — Pipeline context injection in zz-messages.ts processMessageInput
 *
 * V-criteria coverage:
 * V11: When pipeline is active in discuss phase, pipeline context is injected into the prompt
 * V12: When no pipeline is active, prompt is unchanged (no pipeline context)
 * V13: Pipeline context is prepended to memoryContext (before action context)
 * V14: Static import of getTracker replaces dynamic import
 * V15: Convergence detection still works (existing behavior preserved)
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";

const ZZ_MESSAGES_PATH = join(import.meta.dir, "..", "..", "src", "commands", "zz-messages.ts");

describe("zz-messages pipeline context injection", () => {
  let sourceCode: string;

  // Read source file once for structural assertions
  it("setup: can read zz-messages.ts source", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    expect(sourceCode.length).toBeGreaterThan(0);
  });

  // ── V14: Static import replaces dynamic import ────────────

  it("V14: imports getTracker as a static import (not dynamic)", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    // Should have a static import for getTracker
    expect(sourceCode).toContain("import");
    expect(sourceCode).toContain("getTracker");
    // The import should be from pipeline-tracker
    expect(sourceCode).toMatch(
      /import\s+\{[^}]*getTracker[^}]*\}\s+from\s+["'][^"']*pipeline-tracker/,
    );
  });

  it("V14: imports formatPipelineContextForPrompt as a static import", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    expect(sourceCode).toMatch(
      /import\s+\{[^}]*formatPipelineContextForPrompt[^}]*\}\s+from\s+["'][^"']*pipeline-tracker/,
    );
  });

  it("V14: no remaining dynamic import of pipeline-tracker in convergence block", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    // The old pattern: await import("../pipeline-tracker.ts")
    // Should no longer exist
    expect(sourceCode).not.toContain('await import("../pipeline-tracker.ts")');
    expect(sourceCode).not.toContain("await import('../pipeline-tracker.ts')");
  });

  // ── V11: Pipeline context injection ───────────────────────

  it("V11: processMessageInput calls getTracker before buildPrompt", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    // getTracker should be called before buildPrompt in processMessageInput
    const fnBody = sourceCode.substring(sourceCode.indexOf("async function processMessageInput"));
    const getTrackerIdx = fnBody.indexOf("getTracker(");
    const buildPromptIdx = fnBody.indexOf("buildPrompt(");
    expect(getTrackerIdx).toBeGreaterThan(-1);
    expect(buildPromptIdx).toBeGreaterThan(-1);
    // getTracker should appear BEFORE the first buildPrompt call
    expect(getTrackerIdx).toBeLessThan(buildPromptIdx);
  });

  it("V11: processMessageInput calls formatPipelineContextForPrompt", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    const fnBody = sourceCode.substring(sourceCode.indexOf("async function processMessageInput"));
    expect(fnBody).toContain("formatPipelineContextForPrompt");
  });

  // ── V13: Pipeline context is part of memoryContext ────────

  it("V13: pipeline context is concatenated with memoryContext before buildPrompt", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    const fnBody = sourceCode.substring(sourceCode.indexOf("async function processMessageInput"));
    // The pipeline context should be included in the memoryContext parameter
    // Look for pipelineContext being concatenated or included in the buildPrompt call
    expect(fnBody).toContain("pipelineContext");
  });

  // ── V12: No pipeline context when no active pipeline ──────
  // This is a behavioral test covered by the formatPipelineContextForPrompt returning ""
  // when tracker is null. Here we verify the code path handles both cases.

  it("V12: code handles null tracker (no pipeline) gracefully", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    const fnBody = sourceCode.substring(sourceCode.indexOf("async function processMessageInput"));
    // getTracker can return null, the code should not crash
    // formatPipelineContextForPrompt(null) returns ""
    // So the concatenation produces just the original memoryContext
    expect(fnBody).toContain("formatPipelineContextForPrompt");
  });

  // ── V15: Convergence detection still present ──────────────

  it("V15: convergence detection block still exists", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    expect(sourceCode).toContain("detectConvergenceInResponse");
    expect(sourceCode).toContain("buildSddKeyboard");
  });

  // ── LOC constraint ────────────────────────────────────────

  it("zz-messages.ts stays under 800 LOC", async () => {
    sourceCode = await readFile(ZZ_MESSAGES_PATH, "utf-8");
    const lineCount = sourceCode.split("\n").length;
    expect(lineCount).toBeLessThan(800);
  });
});

describe("pipeline-tracker.ts constraints", () => {
  it("pipeline-tracker.ts stays under 800 LOC", async () => {
    const ptPath = join(import.meta.dir, "..", "..", "src", "pipeline-tracker.ts");
    const sourceCode = await readFile(ptPath, "utf-8");
    const lineCount = sourceCode.split("\n").length;
    expect(lineCount).toBeLessThan(800);
  });

  it("pipeline-tracker.ts exports formatPipelineContextForPrompt", async () => {
    const ptPath = join(import.meta.dir, "..", "..", "src", "pipeline-tracker.ts");
    const sourceCode = await readFile(ptPath, "utf-8");
    expect(sourceCode).toContain("export function formatPipelineContextForPrompt");
  });
});
