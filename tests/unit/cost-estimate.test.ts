/**
 * Unit Tests — src/cost-estimate.ts (S29-T7)
 */

import { describe, it, expect } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  estimatePipelineCost,
  estimateSprintCost,
  formatCostEstimate,
} from "../../src/cost-estimate";

describe("estimatePipelineCost", () => {
  it("estimates DEFAULT pipeline cost", () => {
    const result = estimatePipelineCost("DEFAULT", 1);
    // DEFAULT = analyst($0.50) + pm($0.50) + architect($1) + dev($2) + qa($1) + sm($0.25) = $5.25
    expect(result.costPerTask).toBe(5.25);
    expect(result.totalEstimate).toBe(5.25);
    expect(result.agentBreakdown.length).toBe(6);
  });

  it("estimates QUICK pipeline cost", () => {
    const result = estimatePipelineCost("QUICK", 1);
    // QUICK = dev($2) + qa($1) = $3
    expect(result.costPerTask).toBe(3);
    expect(result.agentBreakdown.length).toBe(2);
  });

  it("estimates REVIEW pipeline cost", () => {
    const result = estimatePipelineCost("REVIEW", 1);
    // REVIEW = qa($1) + architect($1) = $2
    expect(result.costPerTask).toBe(2);
    expect(result.agentBreakdown.length).toBe(2);
  });

  it("multiplies by task count", () => {
    const result = estimatePipelineCost("DEFAULT", 8);
    expect(result.totalEstimate).toBe(5.25 * 8);
    expect(result.taskCount).toBe(8);
  });

  it("falls back to DEFAULT for unknown pipeline", () => {
    const result = estimatePipelineCost("UNKNOWN", 1);
    expect(result.costPerTask).toBe(5.25);
  });
});

describe("estimateSprintCost", () => {
  it("returns estimate with no historical data", async () => {
    const result = await estimateSprintCost(null, 5, "DEFAULT");
    expect(result.estimate.totalEstimate).toBe(5.25 * 5);
    expect(result.historicalAvg).toBeNull();
    expect(result.ratio).toBeNull();
    expect(result.warning).toBe(false);
  });

  it("compares with historical average", async () => {
    const supabase = createMockSupabase({
      cost_tracking: [
        { sprint_id: "S27", cost_usd: 10 },
        { sprint_id: "S27", cost_usd: 5 },
        { sprint_id: "S28", cost_usd: 8 },
      ],
    });

    const result = await estimateSprintCost(supabase, 10, "DEFAULT");
    expect(result.historicalAvg).not.toBeNull();
    expect(result.ratio).not.toBeNull();
  });

  it("warns when estimate exceeds 2x historical", async () => {
    const supabase = createMockSupabase({
      cost_tracking: [
        { sprint_id: "S27", cost_usd: 2 },
        { sprint_id: "S28", cost_usd: 3 },
      ],
    });

    // 10 tasks * $5.25 = $52.50 vs avg ~$2.5 = ~21x -> warning
    const result = await estimateSprintCost(supabase, 10, "DEFAULT");
    expect(result.warning).toBe(true);
  });
});

describe("formatCostEstimate", () => {
  it("formats estimate with breakdown", () => {
    const result = {
      pipeline: "DEFAULT",
      taskCount: 5,
      estimate: {
        pipeline: "DEFAULT",
        taskCount: 5,
        costPerTask: 5.25,
        totalEstimate: 26.25,
        agentBreakdown: [
          { role: "analyst", budget: 0.5 },
          { role: "dev", budget: 2.0 },
        ],
      },
      historicalAvg: 15,
      ratio: 1.8,
      warning: false,
    };

    const text = formatCostEstimate(result);
    expect(text).toContain("5 taches");
    expect(text).toContain("DEFAULT");
    expect(text).toContain("analyst");
    expect(text).toContain("$26.25");
    expect(text).toContain("$15.00");
    expect(text).not.toContain("ATTENTION");
  });

  it("shows warning when ratio exceeds threshold", () => {
    const result = {
      pipeline: "DEFAULT",
      taskCount: 10,
      estimate: {
        pipeline: "DEFAULT",
        taskCount: 10,
        costPerTask: 5.25,
        totalEstimate: 52.5,
        agentBreakdown: [],
      },
      historicalAvg: 10,
      ratio: 5.3,
      warning: true,
    };

    const text = formatCostEstimate(result);
    expect(text).toContain("ATTENTION");
  });

  it("handles no historical data", () => {
    const result = {
      pipeline: "QUICK",
      taskCount: 3,
      estimate: {
        pipeline: "QUICK",
        taskCount: 3,
        costPerTask: 3,
        totalEstimate: 9,
        agentBreakdown: [],
      },
      historicalAvg: null,
      ratio: null,
      warning: false,
    };

    const text = formatCostEstimate(result);
    expect(text).toContain("Pas de donnees historiques");
  });
});
