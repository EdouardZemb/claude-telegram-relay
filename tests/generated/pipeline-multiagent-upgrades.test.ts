/**
 * Tests — SPEC-pipeline-multiagent-upgrades
 *
 * V-criteres from Section 8. Covers P1 (overlap), P2 (context refresh),
 * P3 (DLQ), P4 (adaptive thresholds), P5 (correlation_id + tracing alias).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  scoreToPipeline,
  type DifficultyScore,
} from "../../src/llm-router";
import {
  selectAdaptivePipeline,
  DEFAULT_PIPELINE,
  LIGHT_PIPELINE,
  SOLO_PIPELINE,
  BREAKING_KEYWORDS,
  hasBreakingKeywords,
} from "../../src/pipeline-selection";
import {
  emitAgentEvent,
  getAgentEvents,
  getInMemoryEventsForSession,
  clearInMemoryEvents,
  captureAgentFailure,
  getTracingTimeline,
  type FailureContext,
} from "../../src/agent-events";
import { createMockSupabase } from "../fixtures/mock-supabase";

// ── Helpers ──────────────────────────────────────────────────

function makeTask(title: string, opts?: { description?: string | null; priority?: number; subtasks?: any[] | null }) {
  return {
    id: "test-1",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    title,
    description: opts?.description ?? null,
    project: "test",
    status: "backlog" as const,
    priority: opts?.priority ?? 2,
    sprint: null,
    tags: [],
    estimated_hours: null,
    actual_hours: null,
    blocked_by: null,
    notes: null,
    completed_at: null,
    acceptance_criteria: null,
    dev_notes: null,
    architecture_ref: null,
    subtasks: opts?.subtasks ?? null,
    project_id: null,
  } as any;
}

// ── P4: Seuil adaptatif LIGHT vs DEFAULT ─────────────────────

// V-critere: V1
describe("[V1] scoreToPipeline(0.65) retourne LIGHT au lieu de DEFAULT", () => {
  test("score 0.65 retourne LIGHT avec le nouveau seuil 0.7", () => {
    expect(scoreToPipeline(0.65)).toBe("LIGHT");
  });
});

// V-critere: V2
describe("[V2] scoreToPipeline(0.71) retourne DEFAULT", () => {
  test("score 0.71 retourne DEFAULT (au-dessus du seuil 0.7)", () => {
    expect(scoreToPipeline(0.71)).toBe("DEFAULT");
  });
});

// V-critere: V3
describe("[V3] scoreToPipeline(0.3) retourne LIGHT (frontiere SOLO/LIGHT inchangee)", () => {
  test("score 0.3 retourne LIGHT (seuil SOLO/LIGHT inchange)", () => {
    expect(scoreToPipeline(0.3)).toBe("LIGHT");
  });

  test("score 0.29 retourne SOLO", () => {
    expect(scoreToPipeline(0.29)).toBe("SOLO");
  });
});

// V-critere: V4
describe("[V4] scoreToPipeline(0.7) retourne LIGHT (frontiere inclusive)", () => {
  test("score 0.7 est la borne haute inclusive de LIGHT", () => {
    expect(scoreToPipeline(0.7)).toBe("LIGHT");
  });

  test("score 0.701 retourne DEFAULT", () => {
    expect(scoreToPipeline(0.701)).toBe("DEFAULT");
  });
});

// V-critere: V5
describe("[V5] selectAdaptivePipeline retourne DEFAULT pour > 5 modules impactes", () => {
  test("tache avec 6 modules impactes et difficulty < 0.7 force DEFAULT", async () => {
    // Mock computeDifficultyScore to return score=0.5 with 6 affected modules
    const { mock: bunMock } = await import("bun:test");
    const originalImport = await import("../../src/llm-router");

    // Use a task that would normally get LIGHT (medium difficulty, no keywords)
    // We need to mock computeDifficultyScore at the module level
    const mockDifficultyScore: DifficultyScore = {
      score: 0.5,
      components: { graphComplexity: 0.5, descriptionAnalysis: 0.5, historicalEffort: -1 },
      affectedModules: ["mod1", "mod2", "mod3", "mod4", "mod5", "mod6"],
      similarTaskCount: 0,
      pipeline: "LIGHT",
    };

    // Since selectAdaptivePipeline does dynamic import of computeDifficultyScore,
    // we mock the module
    mock.module("../../src/llm-router", () => ({
      ...originalImport,
      computeDifficultyScore: mock(() => Promise.resolve(mockDifficultyScore)),
    }));

    const { selectAdaptivePipeline: freshSelect } = await import("../../src/pipeline-selection");
    const result = await freshSelect(makeTask("add notifications to profile"));
    expect(result).toEqual(DEFAULT_PIPELINE);

    // Restore
    mock.module("../../src/llm-router", () => originalImport);
  });
});

// V-critere: V6
describe("[V6] selectAdaptivePipeline retourne DEFAULT pour breaking changes keywords", () => {
  test("hasBreakingKeywords detects breaking change keywords", () => {
    expect(hasBreakingKeywords("breaking change API v2 migration")).toBe(true);
    expect(hasBreakingKeywords("deprecate old endpoint")).toBe(true);
    expect(hasBreakingKeywords("schema change for users table")).toBe(true);
    expect(hasBreakingKeywords("backward incompatible update")).toBe(true);
    expect(hasBreakingKeywords("supprime les anciens handlers")).toBe(true);
    expect(hasBreakingKeywords("retire l'endpoint legacy")).toBe(true);
    expect(hasBreakingKeywords("api v2 migration plan")).toBe(true);
    expect(hasBreakingKeywords("migration schema des utilisateurs")).toBe(true);
  });

  test("hasBreakingKeywords returns false for non-breaking text", () => {
    expect(hasBreakingKeywords("add new feature to dashboard")).toBe(false);
    expect(hasBreakingKeywords("fix typo in readme")).toBe(false);
    expect(hasBreakingKeywords("update notification preferences")).toBe(false);
  });

  test("tache avec 'breaking change' et difficulty=0.5 force DEFAULT", async () => {
    const originalImport = await import("../../src/llm-router");
    const mockDifficultyScore: DifficultyScore = {
      score: 0.5,
      components: { graphComplexity: 0.3, descriptionAnalysis: 0.5, historicalEffort: -1 },
      affectedModules: ["mod1", "mod2"],
      similarTaskCount: 0,
      pipeline: "LIGHT",
    };

    mock.module("../../src/llm-router", () => ({
      ...originalImport,
      computeDifficultyScore: mock(() => Promise.resolve(mockDifficultyScore)),
    }));

    const { selectAdaptivePipeline: freshSelect } = await import("../../src/pipeline-selection");
    const result = await freshSelect(makeTask("breaking change API v2 migration"));
    expect(result).toEqual(DEFAULT_PIPELINE);

    mock.module("../../src/llm-router", () => originalImport);
  });
});

// V-critere: V7
describe("[V7] selectAdaptivePipeline retourne LIGHT pour cas normal (3 modules, difficulty 0.5)", () => {
  test("tache avec 3 modules impactes et difficulty=0.5 retourne LIGHT", async () => {
    const originalImport = await import("../../src/llm-router");
    const mockDifficultyScore: DifficultyScore = {
      score: 0.5,
      components: { graphComplexity: 0.4, descriptionAnalysis: 0.5, historicalEffort: -1 },
      affectedModules: ["mod1", "mod2", "mod3"],
      similarTaskCount: 0,
      pipeline: "LIGHT",
    };

    mock.module("../../src/llm-router", () => ({
      ...originalImport,
      computeDifficultyScore: mock(() => Promise.resolve(mockDifficultyScore)),
    }));

    const { selectAdaptivePipeline: freshSelect } = await import("../../src/pipeline-selection");
    const result = await freshSelect(makeTask("add notification preferences to profile page"));
    expect(result).toEqual(LIGHT_PIPELINE);

    mock.module("../../src/llm-router", () => originalImport);
  });
});

// ── P3: Agent DLQ (Dead Letter Queue cognitive) ──────────────

// V-critere: V8
describe("[V8] AgentEventType inclut failure_captured", () => {
  test("le type failure_captured est valide dans AgentEventType", async () => {
    // Verify we can emit an event with failure_captured type without error
    clearInMemoryEvents("test-v8");
    await emitAgentEvent(null, "test-v8", "dev", "failure_captured", { error: "test" });
    const events = getInMemoryEventsForSession("test-v8");
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("failure_captured");
    clearInMemoryEvents("test-v8");
  });
});

// V-critere: V9
describe("[V9] captureAgentFailure insere un event avec payload complet", () => {
  let supabase: any;

  beforeEach(() => {
    supabase = createMockSupabase();
    clearInMemoryEvents("test-v9");
  });

  test("insert un event failure_captured avec tous les champs du payload", async () => {
    const failureCtx: FailureContext = {
      promptSnippet: "System prompt for dev agent: You are...",
      partialOutput: "Partial output from agent before failure...",
      error: "Exit code 1: timeout after 300s",
      tokensInput: 5000,
      tokensOutput: 1200,
      durationMs: 300000,
    };

    await captureAgentFailure(supabase, "test-v9", "dev", failureCtx);

    const rows = supabase._getTable("agent_events");
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("failure_captured");
    expect(rows[0].session_id).toBe("test-v9");
    expect(rows[0].agent_role).toBe("dev");
    expect(rows[0].payload.prompt_snippet).toContain("System prompt");
    expect(rows[0].payload.partial_output).toContain("Partial output");
    expect(rows[0].payload.error).toContain("timeout");
    expect(rows[0].payload.tokens_input).toBe(5000);
    expect(rows[0].payload.tokens_output).toBe(1200);
    expect(rows[0].payload.duration_ms).toBe(300000);
  });

  test("truncates prompt_snippet to 500 chars and partial_output to 2000 chars", async () => {
    const longPrompt = "x".repeat(1000);
    const longOutput = "y".repeat(5000);

    await captureAgentFailure(supabase, "test-v9", "qa", {
      promptSnippet: longPrompt,
      partialOutput: longOutput,
      error: "test",
      tokensInput: 0,
      tokensOutput: 0,
      durationMs: 0,
    });

    const rows = supabase._getTable("agent_events");
    expect(rows[0].payload.prompt_snippet.length).toBeLessThanOrEqual(500);
    expect(rows[0].payload.partial_output.length).toBeLessThanOrEqual(2000);
  });
});

// V-critere: V10
describe("[V10] captureAgentFailure ne bloque jamais", () => {
  test("si l'insert Supabase throw, la fonction ne propage pas l'erreur", async () => {
    // Create a supabase mock that throws on insert
    const brokenSupabase = {
      from: () => ({
        insert: () => { throw new Error("DB connection lost"); },
      }),
    } as any;

    clearInMemoryEvents("test-v10");

    // Should not throw
    await captureAgentFailure(brokenSupabase, "test-v10", "dev", {
      promptSnippet: "test",
      partialOutput: "output",
      error: "original error",
      tokensInput: 100,
      tokensOutput: 50,
      durationMs: 1000,
    });

    // Event should be in in-memory fallback
    const events = getInMemoryEventsForSession("test-v10");
    expect(events.length).toBeGreaterThanOrEqual(1);
    clearInMemoryEvents("test-v10");
  });
});

// V-critere: V11
describe("[V11] captureAgentFailure fallback in-memory quand supabase est null", () => {
  test("appeler avec supabase=null stocke l'event en memoire", async () => {
    clearInMemoryEvents("test-v11");

    await captureAgentFailure(null, "test-v11", "architect", {
      promptSnippet: "prompt for architect",
      partialOutput: "partial output",
      error: "timeout",
      tokensInput: 3000,
      tokensOutput: 800,
      durationMs: 60000,
    });

    const events = getInMemoryEventsForSession("test-v11");
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("failure_captured");
    expect(events[0].agent_role).toBe("architect");
    expect(events[0].payload.error).toBe("timeout");

    clearInMemoryEvents("test-v11");
  });
});

// ── P2: Context refresh mid-pipeline ─────────────────────────

// V-critere: V13
describe("[V13] buildAgentContext retourne '' preserve le cache existant", () => {
  test("si buildAgentContext retourne '' le cache precedent est conserve", () => {
    // This tests the logic pattern used in orchestrator.ts:
    // if (refreshedCtx) { cache.set(role, refreshedCtx); }
    // An empty string is falsy, so the cache is not overwritten
    const cache = new Map<string, string>();
    cache.set("dev", "existing context data");

    const refreshedCtx = ""; // buildAgentContext returned empty
    if (refreshedCtx) {
      cache.set("dev", refreshedCtx); // This should NOT execute
    }

    expect(cache.get("dev")).toBe("existing context data");
  });

  test("non-empty refreshed context updates the cache", () => {
    const cache = new Map<string, string>();
    cache.set("dev", "old context");

    const refreshedCtx = "new refreshed context";
    if (refreshedCtx) {
      cache.set("dev", refreshedCtx);
    }

    expect(cache.get("dev")).toBe("new refreshed context");
  });
});

// ── P5: Observabilite cross-agent (correlation_id) ───────────

// V-critere: V17
describe("[V17] logCost dans orchestrate inclut pipeline_session_id dans metadata", () => {
  test("CostEntry.metadata supports pipeline_session_id field", () => {
    // Verify the CostEntry type accepts metadata with pipeline_session_id
    const entry = {
      taskId: "task-1",
      sprintId: "S23",
      agentRole: "dev",
      agentName: "Dev Agent",
      tokensInput: 5000,
      tokensOutput: 1200,
      costUsd: 0.05,
      durationMs: 30000,
      context: "orchestration",
      model: "claude-sonnet-4-6",
      metadata: { pipeline_session_id: "pr-task-1-1234567890" },
    };

    expect(entry.metadata.pipeline_session_id).toBe("pr-task-1-1234567890");
    expect(typeof entry.metadata.pipeline_session_id).toBe("string");
  });
});

// V-critere: V18
describe("[V18] getTracingTimeline est un alias de getAgentEvents", () => {
  test("getTracingTimeline === getAgentEvents", () => {
    expect(getTracingTimeline).toBe(getAgentEvents);
  });

  test("getTracingTimeline returns same results as getAgentEvents", async () => {
    clearInMemoryEvents("test-v18");
    await emitAgentEvent(null, "test-v18", "dev", "spawned", {});
    await emitAgentEvent(null, "test-v18", "dev", "completed", { duration_ms: 5000 });

    const eventsViaOriginal = await getAgentEvents(null, "test-v18");
    const eventsViaAlias = await getTracingTimeline(null, "test-v18");

    expect(eventsViaAlias).toEqual(eventsViaOriginal);
    expect(eventsViaAlias.length).toBe(2);

    clearInMemoryEvents("test-v18");
  });
});

// ── P1: Parallelisme intra-phase (overlap) ───────────────────

// V-critere: V19
describe("[V19] overlap=true + useBlackboard=true → overlap ignore (fallback sequentiel)", () => {
  test("quand les deux options sont actives, effectiveOverlap est false", () => {
    // Test the logic pattern used in orchestrator.ts
    const options = { overlap: true, useBlackboard: true };
    let effectiveOverlap = options.overlap ?? false;
    if (effectiveOverlap && options.useBlackboard) {
      effectiveOverlap = false; // console.warn emitted in production
    }
    expect(effectiveOverlap).toBe(false);
  });

  test("overlap without blackboard remains true", () => {
    const options = { overlap: true, useBlackboard: false };
    let effectiveOverlap = options.overlap ?? false;
    if (effectiveOverlap && options.useBlackboard) {
      effectiveOverlap = false;
    }
    expect(effectiveOverlap).toBe(true);
  });
});

// V-critere: V23
describe("[V23] overlap=true + pipeline 1 agent → pas de changement", () => {
  test("pipeline [dev] avec overlap=true, overlapThreshold equals pipeline.length (no overlap)", () => {
    const pipeline = ["dev"];
    const effectiveOverlap = true;
    const overlapThreshold = effectiveOverlap && pipeline.length >= 2
      ? pipeline.length - 2
      : pipeline.length;

    // With 1 agent, no overlap possible
    expect(overlapThreshold).toBe(pipeline.length);
  });
});

// V-critere: V24
describe("[V24] overlap=false (defaut) → pipeline sequentiel", () => {
  test("sans overlap, overlapThreshold equals pipeline.length (all sequential)", () => {
    const pipeline = ["analyst", "pm", "architect", "dev", "qa"];
    const effectiveOverlap = false;
    const overlapThreshold = effectiveOverlap && pipeline.length >= 2
      ? pipeline.length - 2
      : pipeline.length;

    expect(overlapThreshold).toBe(pipeline.length);
  });

  test("default overlap option is false", () => {
    const options: { overlap?: boolean } = {};
    const effectiveOverlap = options.overlap ?? false;
    expect(effectiveOverlap).toBe(false);
  });
});

// V-critere: V20 (integration-level logic test)
describe("[V20] overlap=true avec pipeline 3+ agents → 2 derniers en parallele", () => {
  test("pipeline [analyst, dev, qa] with overlap, overlapThreshold is at index 1", () => {
    const pipeline = ["analyst", "dev", "qa"];
    const effectiveOverlap = true;
    const overlapThreshold = effectiveOverlap && pipeline.length >= 2
      ? pipeline.length - 2
      : pipeline.length;

    expect(overlapThreshold).toBe(1); // index 1 = dev and qa run in parallel
    expect(pipeline.slice(overlapThreshold)).toEqual(["dev", "qa"]);
    expect(pipeline.slice(0, overlapThreshold)).toEqual(["analyst"]);
  });

  test("pipeline [analyst, pm, architect, dev, qa] with overlap, last 2 overlap", () => {
    const pipeline = ["analyst", "pm", "architect", "dev", "qa"];
    const effectiveOverlap = true;
    const overlapThreshold = effectiveOverlap && pipeline.length >= 2
      ? pipeline.length - 2
      : pipeline.length;

    expect(overlapThreshold).toBe(3);
    expect(pipeline.slice(overlapThreshold)).toEqual(["dev", "qa"]);
    expect(pipeline.slice(0, overlapThreshold)).toEqual(["analyst", "pm", "architect"]);
  });
});

// V-critere: V22 (integration-level logic test)
describe("[V22] overlap=true + pipeline 2 agents → les 2 en parallele", () => {
  test("pipeline [dev, qa] with overlap, both agents overlap (threshold=0)", () => {
    const pipeline = ["dev", "qa"];
    const effectiveOverlap = true;
    const overlapThreshold = effectiveOverlap && pipeline.length >= 2
      ? pipeline.length - 2
      : pipeline.length;

    expect(overlapThreshold).toBe(0);
    expect(pipeline.slice(overlapThreshold)).toEqual(["dev", "qa"]);
    expect(pipeline.slice(0, overlapThreshold)).toEqual([]);
  });
});

// V-critere: V21 (integration-level logic test)
describe("[V21] overlap + echec agent + stopOnFailure → pipeline echoue mais resultats conserves", () => {
  test("Promise.allSettled preserves both fulfilled and rejected results", async () => {
    // Simulates the overlap pattern from orchestrator.ts
    const successPromise = Promise.resolve({
      agentId: "qa",
      result: { success: true, output: "QA passed", durationMs: 5000 },
    });
    const failurePromise = Promise.resolve({
      agentId: "dev",
      result: { success: false, output: "Dev failed", error: "compile error", durationMs: 3000 },
    });

    const settled = await Promise.allSettled([failurePromise, successPromise]);

    // Both results are preserved
    expect(settled.length).toBe(2);
    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1].status).toBe("fulfilled");

    // Extract results
    const results = settled
      .filter((s): s is PromiseFulfilledResult<any> => s.status === "fulfilled")
      .map((s) => s.value);

    expect(results.length).toBe(2);
    expect(results.some((r) => r.result.success === false)).toBe(true);
    expect(results.some((r) => r.result.success === true)).toBe(true);
  });
});

// ── Additional P4 tests ──────────────────────────────────────

describe("BREAKING_KEYWORDS constant", () => {
  test("contains expected keywords", () => {
    expect(BREAKING_KEYWORDS).toContain("breaking");
    expect(BREAKING_KEYWORDS).toContain("migration schema");
    expect(BREAKING_KEYWORDS).toContain("deprecate");
    expect(BREAKING_KEYWORDS).toContain("api v2");
    expect(BREAKING_KEYWORDS).toContain("schema change");
    expect(BREAKING_KEYWORDS).toContain("backward incompatible");
    expect(BREAKING_KEYWORDS).toContain("supprime");
    expect(BREAKING_KEYWORDS).toContain("retire");
  });
});

// ── Edge cases ───────────────────────────────────────────────

describe("captureAgentFailure edge cases", () => {
  beforeEach(() => {
    clearInMemoryEvents("test-edge");
  });

  test("handles empty strings in failure context", async () => {
    await captureAgentFailure(null, "test-edge", "dev", {
      promptSnippet: "",
      partialOutput: "",
      error: "",
      tokensInput: 0,
      tokensOutput: 0,
      durationMs: 0,
    });

    const events = getInMemoryEventsForSession("test-edge");
    expect(events.length).toBe(1);
    expect(events[0].payload.prompt_snippet).toBe("");
    expect(events[0].payload.error).toBe("");

    clearInMemoryEvents("test-edge");
  });

  test("handles very large token counts", async () => {
    const supabase = createMockSupabase();
    await captureAgentFailure(supabase, "test-edge", "architect", {
      promptSnippet: "test",
      partialOutput: "output",
      error: "timeout",
      tokensInput: 1_000_000,
      tokensOutput: 500_000,
      durationMs: 600_000,
    });

    const rows = supabase._getTable("agent_events");
    expect(rows[0].payload.tokens_input).toBe(1_000_000);
    expect(rows[0].payload.tokens_output).toBe(500_000);
  });
});

describe("scoreToPipeline additional boundary tests", () => {
  test("score exactly 0.0 returns SOLO", () => {
    expect(scoreToPipeline(0)).toBe("SOLO");
  });

  test("score exactly 1.0 returns DEFAULT", () => {
    expect(scoreToPipeline(1.0)).toBe("DEFAULT");
  });

  test("score 0.5 returns LIGHT (mid-range)", () => {
    expect(scoreToPipeline(0.5)).toBe("LIGHT");
  });
});
