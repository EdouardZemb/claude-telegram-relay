/**
 * Unit Tests — src/cost-tracking.ts (S23-05/06/07)
 *
 * Tests for token usage parsing, cost estimation,
 * persistence, aggregation, and formatting.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  estimateCost,
  parseTokenUsage,
  logCost,
  getSprintCostSummary,
  getTotalCost,
  formatCostSummary,
  formatTokenCount,
} from "../../src/cost-tracking";

// ── estimateCost ─────────────────────────────────────────────

describe("estimateCost", () => {
  it("calculates cost from token counts", () => {
    // 1M input at $3/M + 1M output at $15/M = $18
    const cost = estimateCost(1_000_000, 1_000_000);
    expect(cost).toBe(18);
  });

  it("handles zero tokens", () => {
    expect(estimateCost(0, 0)).toBe(0);
  });

  it("handles small token counts", () => {
    const cost = estimateCost(1000, 500);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.1);
  });

  it("returns 4 decimal places", () => {
    const cost = estimateCost(5000, 2000);
    const decimals = cost.toString().split(".")[1]?.length || 0;
    expect(decimals).toBeLessThanOrEqual(4);
  });
});

// ── parseTokenUsage ──────────────────────────────────────────

describe("parseTokenUsage", () => {
  it("parses structured usage data from output", () => {
    const output = 'Some text {"input_tokens": 5000, "output_tokens": 2000} more text';
    const usage = parseTokenUsage(output, 1000);

    expect(usage.tokensInput).toBe(5000);
    expect(usage.tokensOutput).toBe(2000);
    expect(usage.tokensTotal).toBe(7000);
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it("falls back to estimation when no structured data", () => {
    const output = "This is a normal text output without any JSON usage data.";
    const usage = parseTokenUsage(output, 2000);

    expect(usage.tokensInput).toBeGreaterThan(0);
    expect(usage.tokensOutput).toBeGreaterThan(0);
    expect(usage.tokensTotal).toBe(usage.tokensInput + usage.tokensOutput);
  });

  it("estimates based on text lengths", () => {
    const shortOutput = "Short";
    const longOutput = "x".repeat(4000);

    const shortUsage = parseTokenUsage(shortOutput, 100);
    const longUsage = parseTokenUsage(longOutput, 100);

    expect(longUsage.tokensOutput).toBeGreaterThan(shortUsage.tokensOutput);
  });

  it("handles empty output", () => {
    const usage = parseTokenUsage("", 0);
    expect(usage.tokensInput).toBeGreaterThan(0); // minimum 500/4
    expect(usage.tokensOutput).toBeGreaterThan(0); // minimum 100/4
  });
});

// ── logCost ──────────────────────────────────────────────────

describe("logCost", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("inserts cost entry to cost_tracking table", async () => {
    await logCost(supabase, {
      taskId: "task-1",
      sprintId: "S22",
      agentRole: "dev",
      agentName: "Amelia",
      tokensInput: 5000,
      tokensOutput: 2000,
      costUsd: 0.045,
      durationMs: 30000,
      retryAttempt: 0,
      context: "orchestration",
    });

    const entries = supabase._getTable("cost_tracking");
    expect(entries.length).toBe(1);
    expect(entries[0].task_id).toBe("task-1");
    expect(entries[0].sprint_id).toBe("S22");
    expect(entries[0].agent_role).toBe("dev");
    expect(entries[0].tokens_input).toBe(5000);
    expect(entries[0].tokens_output).toBe(2000);
    expect(entries[0].cost_usd).toBe(0.045);
  });

  it("handles null supabase gracefully", async () => {
    // Should not throw
    await logCost(null, {
      tokensInput: 1000,
      tokensOutput: 500,
      costUsd: 0.01,
      durationMs: 5000,
    });
  });

  it("handles optional fields", async () => {
    await logCost(supabase, {
      tokensInput: 1000,
      tokensOutput: 500,
      costUsd: 0.01,
      durationMs: 5000,
    });

    const entries = supabase._getTable("cost_tracking");
    expect(entries.length).toBe(1);
    expect(entries[0].task_id).toBeNull();
    expect(entries[0].sprint_id).toBeNull();
  });
});

// ── getSprintCostSummary ─────────────────────────────────────

describe("getSprintCostSummary", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      cost_tracking: [
        { sprint_id: "S22", task_id: "t1", agent_role: "analyst", agent_name: "Chen", tokens_input: 3000, tokens_output: 1000, cost_usd: 0.024 },
        { sprint_id: "S22", task_id: "t1", agent_role: "dev", agent_name: "Amelia", tokens_input: 8000, tokens_output: 5000, cost_usd: 0.099 },
        { sprint_id: "S22", task_id: "t2", agent_role: "dev", agent_name: "Amelia", tokens_input: 6000, tokens_output: 3000, cost_usd: 0.063 },
        { sprint_id: "S21", task_id: "t3", agent_role: "qa", agent_name: "Raj", tokens_input: 2000, tokens_output: 800, cost_usd: 0.018 },
      ],
    });
  });

  it("aggregates costs for a sprint", async () => {
    const summary = await getSprintCostSummary(supabase, "S22");
    expect(summary).not.toBeNull();
    expect(summary!.sprintId).toBe("S22");
    expect(summary!.agentExecutions).toBe(3);
    expect(summary!.totalInputTokens).toBe(17000);
    expect(summary!.totalOutputTokens).toBe(9000);
    expect(summary!.totalTokens).toBe(26000);
    expect(summary!.totalCostUsd).toBeGreaterThan(0);
  });

  it("groups costs by agent", async () => {
    const summary = await getSprintCostSummary(supabase, "S22");
    expect(summary!.costByAgent["dev"]).toBeDefined();
    expect(summary!.costByAgent["dev"].count).toBe(2);
    expect(summary!.costByAgent["analyst"]).toBeDefined();
    expect(summary!.costByAgent["analyst"].count).toBe(1);
  });

  it("groups costs by task", async () => {
    const summary = await getSprintCostSummary(supabase, "S22");
    expect(summary!.costByTask.length).toBe(2);
    expect(summary!.costByTask[0].taskId).toBeDefined();
  });

  it("returns empty summary for unknown sprint", async () => {
    const summary = await getSprintCostSummary(supabase, "S99");
    expect(summary).not.toBeNull();
    expect(summary!.agentExecutions).toBe(0);
    expect(summary!.totalTokens).toBe(0);
  });

  it("returns null for null supabase", async () => {
    const summary = await getSprintCostSummary(null, "S22");
    expect(summary).toBeNull();
  });
});

// ── getTotalCost ─────────────────────────────────────────────

describe("getTotalCost", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      cost_tracking: [
        { tokens_input: 3000, tokens_output: 1000, cost_usd: 0.024 },
        { tokens_input: 8000, tokens_output: 5000, cost_usd: 0.099 },
      ],
    });
  });

  it("sums all costs", async () => {
    const total = await getTotalCost(supabase);
    expect(total.totalTokens).toBe(17000);
    expect(total.totalCostUsd).toBeGreaterThan(0);
    expect(total.executions).toBe(2);
  });

  it("returns zeros for null supabase", async () => {
    const total = await getTotalCost(null);
    expect(total.totalTokens).toBe(0);
    expect(total.totalCostUsd).toBe(0);
    expect(total.executions).toBe(0);
  });
});

// ── formatCostSummary ────────────────────────────────────────

describe("formatCostSummary", () => {
  it("formats a complete summary", () => {
    const result = formatCostSummary({
      sprintId: "S22",
      totalTokens: 26000,
      totalInputTokens: 17000,
      totalOutputTokens: 9000,
      totalCostUsd: 0.186,
      agentExecutions: 3,
      costByAgent: {
        dev: { tokens: 22000, cost: 0.162, count: 2 },
        analyst: { tokens: 4000, cost: 0.024, count: 1 },
      },
      costByTask: [
        { taskId: "abcd1234-5678-9abc-def0-123456789abc", tokens: 17000, cost: 0.123 },
      ],
    });

    expect(result).toContain("S22");
    expect(result).toContain("3");
    expect(result).toContain("26.0k");
    expect(result).toContain("$0.1860");
    expect(result).toContain("dev");
    expect(result).toContain("analyst");
    expect(result).toContain("abcd1234");
  });

  it("handles null summary", () => {
    const result = formatCostSummary(null);
    expect(result).toContain("Pas de donnees");
  });

  it("handles empty summary", () => {
    const result = formatCostSummary({
      sprintId: "S22",
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      agentExecutions: 0,
      costByAgent: {},
      costByTask: [],
    });
    expect(result).toContain("Aucune execution");
  });
});

// ── formatTokenCount ─────────────────────────────────────────

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("formats thousands", () => {
    expect(formatTokenCount(26_000)).toBe("26.0k");
  });

  it("formats small numbers", () => {
    expect(formatTokenCount(500)).toBe("500");
  });

  it("formats zero", () => {
    expect(formatTokenCount(0)).toBe("0");
  });
});
