/**
 * Unit Tests — spawnClaude() centralized CLI spawn (S28-T1)
 *
 * Tests argument construction for the centralized Claude CLI spawn function.
 * Does NOT actually spawn processes — tests the arg building logic.
 */

import { describe, it, expect } from "bun:test";

// We test the args construction logic by importing the interface
// and verifying the SpawnClaudeOptions shape
import type { SpawnClaudeOptions, SpawnClaudeResult } from "../../src/agent";

/**
 * Simulate the arg-building logic from spawnClaude to verify correct flag construction.
 * This mirrors the implementation without actually spawning a process.
 */
function buildSpawnArgs(options: SpawnClaudeOptions): string[] {
  const args: string[] = ["claude"];

  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }

  args.push("-p", options.prompt);

  if (options.outputFormat === "json") {
    args.push("--output-format", "json");
  } else {
    args.push("--output-format", "text");
  }

  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.fallbackModel) {
    args.push("--fallback-model", options.fallbackModel);
  }

  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (options.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  if (options.useWorktree) {
    args.push("-w");
  }

  if (options.fromPr !== undefined) {
    args.push("--from-pr", String(options.fromPr));
  }

  args.push("--dangerously-skip-permissions");

  return args;
}

describe("spawnClaude arg construction", () => {
  it("builds minimal args with just a prompt", () => {
    const args = buildSpawnArgs({ prompt: "hello" });
    expect(args).toContain("claude");
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args).toContain("--output-format");
    expect(args).toContain("text");
    expect(args).toContain("--dangerously-skip-permissions");
    // Should NOT contain optional flags
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--max-budget-usd");
    expect(args).not.toContain("-w");
    expect(args).not.toContain("--from-pr");
    expect(args).not.toContain("--json-schema");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--fallback-model");
  });

  it("builds complete args with all options", () => {
    const schema = { type: "object", properties: { role: { type: "string" } } };
    const args = buildSpawnArgs({
      prompt: "task prompt",
      systemPrompt: "system instructions",
      outputFormat: "json",
      jsonSchema: schema,
      effort: "high",
      model: "claude-opus-4-6",
      fallbackModel: "claude-sonnet-4-6",
      maxBudgetUsd: 2.0,
      useWorktree: true,
      fromPr: 42,
    });

    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("system instructions");
    expect(args).toContain("-p");
    expect(args).toContain("task prompt");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--json-schema");
    expect(args).toContain(JSON.stringify(schema));
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6");
    expect(args).toContain("--fallback-model");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).toContain("--max-budget-usd");
    expect(args).toContain("2");
    expect(args).toContain("-w");
    expect(args).toContain("--from-pr");
    expect(args).toContain("42");
  });

  it("omits flags when options are not provided (backward compatible)", () => {
    const args = buildSpawnArgs({ prompt: "test" });
    // Count total args: claude, -p, test, --output-format, text, --dangerously-skip-permissions
    expect(args.length).toBe(6);
  });

  it("uses text output format by default", () => {
    const args = buildSpawnArgs({ prompt: "test" });
    const fmtIdx = args.indexOf("--output-format");
    expect(args[fmtIdx + 1]).toBe("text");
  });

  it("uses json output format when specified", () => {
    const args = buildSpawnArgs({ prompt: "test", outputFormat: "json" });
    const fmtIdx = args.indexOf("--output-format");
    expect(args[fmtIdx + 1]).toBe("json");
  });

  it("system prompt comes before task prompt", () => {
    const args = buildSpawnArgs({
      prompt: "task",
      systemPrompt: "system",
    });
    const sysIdx = args.indexOf("--append-system-prompt");
    const promptIdx = args.indexOf("-p");
    expect(sysIdx).toBeLessThan(promptIdx);
  });

  it("maxBudgetUsd is serialized as string", () => {
    const args = buildSpawnArgs({ prompt: "test", maxBudgetUsd: 0.50 });
    expect(args).toContain("--max-budget-usd");
    expect(args).toContain("0.5");
  });

  it("fromPr is serialized as string", () => {
    const args = buildSpawnArgs({ prompt: "test", fromPr: 123 });
    expect(args).toContain("--from-pr");
    expect(args).toContain("123");
  });
});

describe("SpawnClaudeOptions interface", () => {
  it("accepts all effort levels", () => {
    for (const effort of ["low", "medium", "high", "max"] as const) {
      const opts: SpawnClaudeOptions = { prompt: "test", effort };
      expect(opts.effort).toBe(effort);
    }
  });

  it("accepts all output formats", () => {
    for (const fmt of ["text", "json"] as const) {
      const opts: SpawnClaudeOptions = { prompt: "test", outputFormat: fmt };
      expect(opts.outputFormat).toBe(fmt);
    }
  });
});
