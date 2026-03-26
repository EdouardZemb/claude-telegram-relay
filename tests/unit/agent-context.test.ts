/**
 * Unit Tests — src/agent-context.ts
 *
 * Tests for buildAgentContext: fetches Supabase data (memory, tasks, sprint, agent memories)
 * and formats a compact context block (<1500 tokens) for injection into SDD agent prompts.
 *
 * V-criteria coverage:
 * V1: buildAgentContext returns a non-empty string with Supabase data
 * V2: Parallel fetching via Promise.all (all sources fetched)
 * V3: Timeout enforcement (3s default, returns partial on timeout)
 * V4: Graceful fallback when supabase is null (returns "")
 * V5: Context size capped at ~6000 chars (~1500 tokens)
 * V6: Role-specific agent memories included
 * V7: Phase-based data selection (different data per phase)
 * V8: Injectable hooks for testing (no real Supabase calls in tests)
 * V9: Feature flag gating (agent_context_injection)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

// ── Mock dependencies before importing ────────────────────────

// Mock memory module
const mockGetMemoryContext = async () => "FACTS:\n- Project uses Bun\nGOALS:\n- Ship v2";
let _getMemoryContextImpl = mockGetMemoryContext;

// Mock tasks module
const mockGetCurrentSprint = async () => "S40";
const mockGetSprintSummary = async () => ({
  total: 10,
  backlog: 3,
  in_progress: 4,
  review: 1,
  done: 2,
});
const mockGetBacklog = async () => [
  {
    id: "task-1",
    title: "Implement agent context",
    status: "in_progress",
    priority: 1,
    sprint: "S40",
    tags: [],
    description: "Add context injection",
    project: "relay",
    created_at: "2026-03-26",
    updated_at: "2026-03-26",
    estimated_hours: null,
    actual_hours: null,
    blocked_by: null,
    notes: null,
    completed_at: null,
    acceptance_criteria: null,
    dev_notes: null,
    architecture_ref: null,
    subtasks: [],
    project_id: null,
    sdd_pipeline_name: null,
  },
  {
    id: "task-2",
    title: "Fix memory leak",
    status: "backlog",
    priority: 2,
    sprint: "S40",
    tags: [],
    description: null,
    project: "relay",
    created_at: "2026-03-26",
    updated_at: "2026-03-26",
    estimated_hours: null,
    actual_hours: null,
    blocked_by: null,
    notes: null,
    completed_at: null,
    acceptance_criteria: null,
    dev_notes: null,
    architecture_ref: null,
    subtasks: [],
    project_id: null,
    sdd_pipeline_name: null,
  },
];

let _getCurrentSprintImpl = mockGetCurrentSprint;
let _getSprintSummaryImpl = mockGetSprintSummary;
let _getBacklogImpl = mockGetBacklog;

// Mock agent-memory module
const mockGetAgentMemories = async () => [
  {
    id: "am-1",
    content: "Always check for null supabase",
    agent_role: "explorer",
    tags: ["pattern"],
    importance_score: 0.8,
    created_at: "2026-03-25",
    last_accessed_at: null,
    access_count: 3,
    metadata: {},
  },
];
let _getAgentMemoriesImpl = mockGetAgentMemories;

// Now import the module under test
import {
  buildAgentContext,
  setAgentMemoriesHook,
  setBacklogHook,
  setCurrentSprintHook,
  setFeatureCheckHook,
  setMemoryContextHook,
  setSprintSummaryHook,
} from "../../src/agent-context.ts";

// ── Setup / Teardown ─────────────────────────────────────────

let featureCheckResult = true;

beforeEach(() => {
  featureCheckResult = true;
  _getMemoryContextImpl = mockGetMemoryContext;
  _getCurrentSprintImpl = mockGetCurrentSprint;
  _getSprintSummaryImpl = mockGetSprintSummary;
  _getBacklogImpl = mockGetBacklog;
  _getAgentMemoriesImpl = mockGetAgentMemories;

  // Install hooks
  setMemoryContextHook(async (sb) => _getMemoryContextImpl());
  setCurrentSprintHook(async (sb) => _getCurrentSprintImpl());
  setSprintSummaryHook(async (sb, sprint) => _getSprintSummaryImpl());
  setBacklogHook(async (sb, opts) => _getBacklogImpl());
  setAgentMemoriesHook(async (sb, role, limit) => _getAgentMemoriesImpl());
  setFeatureCheckHook((flag) => featureCheckResult);
});

afterEach(() => {
  // Reset hooks
  setMemoryContextHook(undefined);
  setCurrentSprintHook(undefined);
  setSprintSummaryHook(undefined);
  setBacklogHook(undefined);
  setAgentMemoriesHook(undefined);
  setFeatureCheckHook(undefined);
});

// biome-ignore lint/suspicious/noExplicitAny: test mock
const mockSupabase = {} as any;

// ── V4: Graceful fallback when supabase is null ──────────────

describe("buildAgentContext — null supabase", () => {
  it("V4: returns empty string when supabase is null", async () => {
    const result = await buildAgentContext(null, "explorer", "explore");
    expect(result).toBe("");
  });
});

// ── V9: Feature flag gating ─────────────────────────────────

describe("buildAgentContext — feature flag disabled", () => {
  it("V9: returns empty string when agent_context_injection flag is disabled", async () => {
    featureCheckResult = false;
    setFeatureCheckHook((flag) => featureCheckResult);
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result).toBe("");
  });
});

// ── V1, V2: Basic fetching and formatting ───────────────────

describe("buildAgentContext — basic operation", () => {
  it("V1: returns a non-empty string with context data", async () => {
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("CONTEXTE PROJET");
  });

  it("V2: includes memory context", async () => {
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result).toContain("Project uses Bun");
    expect(result).toContain("Ship v2");
  });

  it("V2: includes sprint summary", async () => {
    const result = await buildAgentContext(mockSupabase, "spec-architect", "spec");
    expect(result).toContain("S40");
    expect(result).toContain("10");
  });

  it("V2: includes active tasks", async () => {
    const result = await buildAgentContext(mockSupabase, "spec-architect", "spec");
    expect(result).toContain("Implement agent context");
  });

  it("V6: includes role-specific agent memories", async () => {
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result).toContain("Always check for null supabase");
  });
});

// ── V7: Phase-based data selection ──────────────────────────

describe("buildAgentContext — phase-based selection", () => {
  it("V7: explore phase includes memory + tasks but limited sprint details", async () => {
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result).toContain("MEMOIRE");
    expect(result).toContain("TACHES");
  });

  it("V7: implement phase includes sprint summary for budget awareness", async () => {
    const result = await buildAgentContext(mockSupabase, "implementer", "implement");
    expect(result).toContain("SPRINT");
  });

  it("V7: review phase includes all context sections", async () => {
    const result = await buildAgentContext(mockSupabase, "reviewer", "review");
    expect(result).toContain("MEMOIRE");
    expect(result).toContain("SPRINT");
    expect(result).toContain("TACHES");
  });

  it("V7: challenge phase includes tasks for impact evaluation", async () => {
    const result = await buildAgentContext(mockSupabase, "spec-architect", "challenge");
    expect(result).toContain("TACHES");
  });
});

// ── V5: Context size cap ────────────────────────────────────

describe("buildAgentContext — size constraints", () => {
  it("V5: context is capped at ~6000 chars", async () => {
    // Set up oversized data
    const longContent = "A".repeat(10000);
    setMemoryContextHook(async () => longContent);
    setBacklogHook(async () => {
      const tasks = [];
      for (let i = 0; i < 50; i++) {
        tasks.push({
          id: `task-${i}`,
          title: `Very long task title number ${i} with extensive description`,
          status: "backlog" as const,
          priority: 3,
          sprint: "S40",
          tags: [],
          description: "Long description ".repeat(20),
          project: "relay",
          created_at: "2026-03-26",
          updated_at: "2026-03-26",
          estimated_hours: null,
          actual_hours: null,
          blocked_by: null,
          notes: null,
          completed_at: null,
          acceptance_criteria: null,
          dev_notes: null,
          architecture_ref: null,
          subtasks: [],
          project_id: null,
          sdd_pipeline_name: null,
        });
      }
      return tasks;
    });

    const result = await buildAgentContext(mockSupabase, "reviewer", "review");
    expect(result.length).toBeLessThanOrEqual(6000); // MAX_CONTEXT_CHARS cap
  });
});

// ── V3: Timeout enforcement ─────────────────────────────────

describe("buildAgentContext — timeout handling", () => {
  it("V3: returns partial context when one fetch times out", async () => {
    // Make memory context hang forever
    setMemoryContextHook(
      () => new Promise(() => {}), // never resolves
    );

    const result = await buildAgentContext(mockSupabase, "explorer", "explore", {
      timeoutMs: 200,
    });

    // Should still have other sections (sprint, tasks, agent memories)
    // Memory section should be absent or empty
    expect(result).not.toContain("MEMOIRE");
    // But tasks/sprint should be present
    expect(result).toContain("TACHES");
  });

  it("V3: returns partial context when all fetches time out", async () => {
    // Make all fetches hang
    const neverResolves = () => new Promise<never>(() => {});
    setMemoryContextHook(neverResolves);
    setCurrentSprintHook(neverResolves);
    setBacklogHook(neverResolves);
    setAgentMemoriesHook(neverResolves);

    const result = await buildAgentContext(mockSupabase, "explorer", "explore", {
      timeoutMs: 200,
    });

    // Should return empty or minimal context (just the wrapper, no data)
    expect(result.length).toBeLessThan(100);
  });
});

// ── V8: Injectable hooks ────────────────────────────────────

describe("buildAgentContext — injectable hooks", () => {
  it("V8: custom memory context hook is used", async () => {
    setMemoryContextHook(async () => "CUSTOM_MEMORY_CONTEXT");
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result).toContain("CUSTOM_MEMORY_CONTEXT");
  });

  it("V8: custom backlog hook is used", async () => {
    setBacklogHook(async () => [
      {
        id: "custom-1",
        title: "Custom task from hook",
        status: "in_progress" as const,
        priority: 1,
        sprint: "S40",
        tags: [],
        description: null,
        project: "relay",
        created_at: "2026-03-26",
        updated_at: "2026-03-26",
        estimated_hours: null,
        actual_hours: null,
        blocked_by: null,
        notes: null,
        completed_at: null,
        acceptance_criteria: null,
        dev_notes: null,
        architecture_ref: null,
        subtasks: [],
        project_id: null,
        sdd_pipeline_name: null,
      },
    ]);

    const result = await buildAgentContext(mockSupabase, "spec-architect", "spec");
    expect(result).toContain("Custom task from hook");
  });

  it("V8: custom agent memories hook is used", async () => {
    setAgentMemoriesHook(async () => [
      {
        id: "custom-am",
        content: "Custom agent memory",
        agent_role: "explorer",
        tags: [],
        importance_score: 0.9,
        created_at: "2026-03-26",
        last_accessed_at: null,
        access_count: 1,
        metadata: {},
      },
    ]);

    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result).toContain("Custom agent memory");
  });
});

// ── Edge cases ──────────────────────────────────────────────

describe("buildAgentContext — edge cases", () => {
  it("returns context even when sprint is null", async () => {
    setCurrentSprintHook(async () => null);
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result.length).toBeGreaterThan(0);
    // Should still have memory and tasks
    expect(result).toContain("MEMOIRE");
  });

  it("returns context even when backlog is empty", async () => {
    setBacklogHook(async () => []);
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns context even when agent memories are empty", async () => {
    setAgentMemoriesHook(async () => []);
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result.length).toBeGreaterThan(0);
    // Agent memory section should be absent
    expect(result).not.toContain("APPRENTISSAGES AGENT");
  });

  it("handles error in one fetch gracefully", async () => {
    setMemoryContextHook(async () => {
      throw new Error("Supabase connection failed");
    });
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    // Should still return other sections
    expect(result).toContain("TACHES");
  });

  it("handles unknown phase gracefully", async () => {
    const result = await buildAgentContext(mockSupabase, "explorer", "unknown-phase");
    // Should still return some context (uses default data selection)
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles unknown role gracefully", async () => {
    const result = await buildAgentContext(mockSupabase, "unknown-role", "explore");
    // Should still return context without agent memories section
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── Format validation ───────────────────────────────────────

describe("buildAgentContext — format", () => {
  it("uses structured sections with clear delimiters", async () => {
    const result = await buildAgentContext(mockSupabase, "explorer", "explore");
    expect(result).toContain("--- CONTEXTE PROJET ---");
    expect(result).toContain("---");
  });

  it("sections are clearly labeled", async () => {
    const result = await buildAgentContext(mockSupabase, "reviewer", "review");
    // Check for section headers
    expect(result).toMatch(/MEMOIRE/);
    expect(result).toMatch(/SPRINT|TACHES/);
  });
});
