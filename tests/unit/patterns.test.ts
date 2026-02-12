/**
 * Unit Tests — src/patterns.ts
 *
 * Tests for pattern detection, suggestion generation, and formatting.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  analyzePatterns,
  formatPatterns,
  type PatternAnalysis,
  type DetectedPattern,
} from "../../src/patterns";

describe("Pattern Analysis — Slow Steps", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S10", tasks_planned: 16, tasks_completed: 15, created_at: "2026-01-15" },
        { sprint_id: "S11", tasks_planned: 13, tasks_completed: 13, created_at: "2026-02-01" },
      ],
      workflow_logs: [
        // Execution step consistently slow (> 1 hour each)
        { sprint_id: "S10", step_from: "execution", step_to: "review", duration_seconds: 5400, had_rework: false, checkpoint_result: "pass", created_at: "2026-01-16" },
        { sprint_id: "S10", step_from: "execution", step_to: "review", duration_seconds: 4800, had_rework: false, checkpoint_result: "pass", created_at: "2026-01-17" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", duration_seconds: 6000, had_rework: false, checkpoint_result: "pass", created_at: "2026-02-02" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", duration_seconds: 7200, had_rework: false, checkpoint_result: "pass", created_at: "2026-02-03" },
        // Request step fast
        { sprint_id: "S10", step_from: "request", step_to: "decomposition", duration_seconds: 30, had_rework: false, checkpoint_result: "skipped", created_at: "2026-01-16" },
        { sprint_id: "S11", step_from: "request", step_to: "decomposition", duration_seconds: 25, had_rework: false, checkpoint_result: "skipped", created_at: "2026-02-02" },
      ],
      retros: [],
    });
  });

  it("detects slow steps", async () => {
    const analysis = await analyzePatterns(supabase);
    const slowSteps = analysis.patterns.filter((p) => p.type === "slow_step");
    expect(slowSteps.length).toBeGreaterThan(0);
    expect(slowSteps[0].data.step).toBe("execution");
  });

  it("does not flag fast steps as slow", async () => {
    const analysis = await analyzePatterns(supabase);
    const slowSteps = analysis.patterns.filter((p) => p.type === "slow_step");
    expect(slowSteps.every((p) => p.data.step !== "request")).toBe(true);
  });
});

describe("Pattern Analysis — Checkpoints", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S11", tasks_planned: 10, tasks_completed: 10, created_at: "2026-02-01" },
      ],
      workflow_logs: [
        // Decomposition checkpoint: always passes (5+ entries)
        ...[1, 2, 3, 4, 5].map((i) => ({
          sprint_id: "S11",
          step_from: "decomposition",
          step_to: "execution",
          duration_seconds: 120,
          had_rework: false,
          checkpoint_result: "pass",
          created_at: `2026-02-0${i}`,
        })),
        // Execution checkpoint: fails often (3/5)
        { sprint_id: "S11", step_from: "execution", step_to: "review", duration_seconds: 3600, had_rework: false, checkpoint_result: "fail", created_at: "2026-02-01" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", duration_seconds: 3600, had_rework: false, checkpoint_result: "fail", created_at: "2026-02-02" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", duration_seconds: 3600, had_rework: false, checkpoint_result: "corrected", created_at: "2026-02-03" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", duration_seconds: 3600, had_rework: false, checkpoint_result: "pass", created_at: "2026-02-04" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", duration_seconds: 3600, had_rework: false, checkpoint_result: "pass", created_at: "2026-02-05" },
      ],
      retros: [],
    });
  });

  it("detects useless checkpoints", async () => {
    const analysis = await analyzePatterns(supabase);
    const useless = analysis.patterns.filter((p) => p.type === "useless_checkpoint");
    expect(useless.length).toBe(1);
    expect(useless[0].data.step).toBe("decomposition");
  });

  it("detects critical checkpoints", async () => {
    const analysis = await analyzePatterns(supabase);
    const critical = analysis.patterns.filter((p) => p.type === "critical_checkpoint");
    expect(critical.length).toBe(1);
    expect(critical[0].data.step).toBe("execution");
  });
});

describe("Pattern Analysis — Rework", () => {
  it("detects high rework rate", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [{ sprint_id: "S11", tasks_planned: 10, tasks_completed: 8, created_at: "2026-02-01" }],
      workflow_logs: [
        { sprint_id: "S11", step_from: "review", step_to: "execution", had_rework: true, checkpoint_result: "fail", created_at: "2026-02-01" },
        { sprint_id: "S11", step_from: "review", step_to: "execution", had_rework: true, checkpoint_result: "fail", created_at: "2026-02-02" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", had_rework: false, checkpoint_result: "pass", created_at: "2026-02-03" },
        { sprint_id: "S11", step_from: "execution", step_to: "review", had_rework: false, checkpoint_result: "pass", created_at: "2026-02-04" },
      ],
      retros: [],
    });

    const analysis = await analyzePatterns(supabase);
    const rework = analysis.patterns.filter((p) => p.type === "high_rework");
    expect(rework.length).toBe(1);
    expect(rework[0].data.sprint).toBe("S11");
  });
});

describe("Pattern Analysis — Trends", () => {
  it("detects improving trend", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S09", tasks_planned: 10, tasks_completed: 6, created_at: "2026-01-01" },
        { sprint_id: "S10", tasks_planned: 10, tasks_completed: 8, created_at: "2026-01-15" },
        { sprint_id: "S11", tasks_planned: 10, tasks_completed: 10, created_at: "2026-02-01" },
      ],
      workflow_logs: [],
      retros: [],
    });

    const analysis = await analyzePatterns(supabase);
    const improving = analysis.patterns.filter((p) => p.type === "improving");
    expect(improving.length).toBe(1);
  });

  it("detects degrading trend", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S09", tasks_planned: 10, tasks_completed: 10, created_at: "2026-01-01" },
        { sprint_id: "S10", tasks_planned: 10, tasks_completed: 7, created_at: "2026-01-15" },
        { sprint_id: "S11", tasks_planned: 10, tasks_completed: 4, created_at: "2026-02-01" },
      ],
      workflow_logs: [],
      retros: [],
    });

    const analysis = await analyzePatterns(supabase);
    const degrading = analysis.patterns.filter((p) => p.type === "degrading");
    expect(degrading.length).toBe(1);
  });

  it("needs minimum sprints for trend detection", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S11", tasks_planned: 10, tasks_completed: 10, created_at: "2026-02-01" },
      ],
      workflow_logs: [],
      retros: [],
    });

    const analysis = await analyzePatterns(supabase);
    const trends = analysis.patterns.filter((p) => p.type === "improving" || p.type === "degrading");
    expect(trends.length).toBe(0);
  });
});

describe("Pattern Analysis — Suggestions", () => {
  it("suggests disabling useless checkpoint", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [{ sprint_id: "S11", tasks_planned: 10, tasks_completed: 10, created_at: "2026-02-01" }],
      workflow_logs: [
        ...[1, 2, 3, 4, 5].map((i) => ({
          sprint_id: "S11",
          step_from: "decomposition",
          step_to: "execution",
          duration_seconds: 120,
          had_rework: false,
          checkpoint_result: "pass",
          created_at: `2026-02-0${i}`,
        })),
      ],
      retros: [],
    });

    const analysis = await analyzePatterns(supabase);
    const disableSuggestions = analysis.suggestions.filter((s) =>
      s.action.includes("Desactiver")
    );
    expect(disableSuggestions.length).toBeGreaterThan(0);
  });

  it("filters out already-accepted actions", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [{ sprint_id: "S11", tasks_planned: 10, tasks_completed: 10, created_at: "2026-02-01" }],
      workflow_logs: [
        ...[1, 2, 3, 4, 5].map((i) => ({
          sprint_id: "S11",
          step_from: "decomposition",
          step_to: "execution",
          duration_seconds: 120,
          had_rework: false,
          checkpoint_result: "pass",
          created_at: `2026-02-0${i}`,
        })),
      ],
      retros: [
        {
          sprint_id: "S10",
          actions_accepted: [
            { action: 'Desactiver le checkpoint sur "decomposition"', priority: "low" },
          ],
          created_at: "2026-01-15",
        },
      ],
    });

    const analysis = await analyzePatterns(supabase);
    const disableSuggestions = analysis.suggestions.filter((s) =>
      s.action.includes('Desactiver le checkpoint sur "decomposition"')
    );
    expect(disableSuggestions.length).toBe(0);
  });
});

describe("Pattern Analysis — Empty Data", () => {
  it("handles empty data gracefully", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [],
      workflow_logs: [],
      retros: [],
    });

    const analysis = await analyzePatterns(supabase);
    expect(analysis.patterns.length).toBe(0);
    expect(analysis.suggestions.length).toBe(0);
    expect(analysis.sprintCount).toBe(0);
  });
});

describe("Pattern Formatting", () => {
  it("formats patterns with severity icons", () => {
    const analysis: PatternAnalysis = {
      patterns: [
        { type: "slow_step", severity: "warning", description: "Execution lente", data: {} },
        { type: "useless_checkpoint", severity: "info", description: "Checkpoint inutile", data: {} },
      ],
      suggestions: [
        { action: "Desactiver checkpoint", reason: "Inutile", priority: "low" },
      ],
      sprintCount: 3,
      analyzedAt: new Date().toISOString(),
    };

    const result = formatPatterns(analysis);
    expect(result).toContain("3 sprints");
    expect(result).toContain("Execution lente");
    expect(result).toContain("Checkpoint inutile");
    expect(result).toContain("Desactiver checkpoint");
  });

  it("formats empty analysis", () => {
    const analysis: PatternAnalysis = {
      patterns: [],
      suggestions: [],
      sprintCount: 2,
      analyzedAt: new Date().toISOString(),
    };

    const result = formatPatterns(analysis);
    expect(result).toContain("Pas de patterns");
  });
});
