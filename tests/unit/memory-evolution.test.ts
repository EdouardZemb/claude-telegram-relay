/**
 * Unit Tests — Memory Evolution (S36-03/04/05/06/08)
 *
 * Tests for duplicate detection, contradiction handling, complement merging,
 * actionability filtering, and working memory promotion.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  findSimilarFact,
  resolveMemoryConflict,
  updateMemoryWithRevision,
  autoRemember,
  processMemoryIntents,
  promoteWorkingMemory,
} from "../../src/memory";
import type { ConflictResolution, WorkingMemoryData } from "../../src/memory";

// ── findSimilarFact (S36-03) ────────────────────────────────────

describe("findSimilarFact", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns matching fact when similarity above threshold", async () => {
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Edouard is a developer", type: "fact", similarity: 0.90 },
    ]);

    const result = await findSimilarFact(supabase, "Edouard works as a developer");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("f1");
    expect(result!.content).toBe("Edouard is a developer");
    expect(result!.similarity).toBe(0.90);
  });

  it("returns null when no match found", async () => {
    supabase._registerFunction("search", () => []);

    const result = await findSimilarFact(supabase, "Something completely new");
    expect(result).toBeNull();
  });

  it("ignores non-fact types", async () => {
    supabase._registerFunction("search", () => [
      { id: "g1", content: "Similar goal", type: "goal", similarity: 0.90 },
    ]);

    const result = await findSimilarFact(supabase, "Similar goal text");
    expect(result).toBeNull();
  });

  it("returns null for null supabase", async () => {
    const result = await findSimilarFact(null, "test");
    expect(result).toBeNull();
  });

  it("returns null for empty content", async () => {
    const result = await findSimilarFact(supabase, "");
    expect(result).toBeNull();
  });

  it("returns null when search function throws", async () => {
    supabase._registerFunction("search", () => {
      throw new Error("Network error");
    });

    const result = await findSimilarFact(supabase, "test");
    expect(result).toBeNull();
  });

  it("uses custom threshold", async () => {
    let searchBody: any = null;
    supabase._registerFunction("search", (opts: any) => {
      searchBody = opts?.body;
      return [];
    });

    await findSimilarFact(supabase, "test", 0.90);
    expect(searchBody.match_threshold).toBe(0.90);
  });
});

// ── resolveMemoryConflict (S36-03/04/05) ────────────────────────

describe("resolveMemoryConflict", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns 'insert' when no similar fact exists", async () => {
    supabase._registerFunction("search", () => []);

    const result = await resolveMemoryConflict(supabase, "Brand new fact");

    expect(result.action).toBe("insert");
  });

  it("returns 'skip' for duplicate (similarity >= 0.85)", async () => {
    supabase._registerRpc("bump_memory_access", () => null);
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Exact same fact", type: "fact", similarity: 0.92 },
    ]);

    const result = await resolveMemoryConflict(supabase, "Exact same fact");

    expect(result.action).toBe("skip");
    expect((result as any).existingId).toBe("f1");
  });

  it("bumps access on duplicate detection", async () => {
    let bumpedIds: string[] = [];
    supabase._registerRpc("bump_memory_access", (params: any) => {
      bumpedIds = params.memory_ids;
      return null;
    });
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Same fact", type: "fact", similarity: 0.88 },
    ]);

    await resolveMemoryConflict(supabase, "Same fact rephrased");

    expect(bumpedIds).toContain("f1");
  });

  it("returns 'update' for contradiction (0.80 <= similarity < 0.85)", async () => {
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Old version of fact", type: "fact", similarity: 0.82 },
    ]);

    const result = await resolveMemoryConflict(supabase, "Updated version of fact");

    expect(result.action).toBe("update");
    expect((result as any).existingId).toBe("f1");
  });

  it("returns 'merge' for complement (0.75 <= similarity < 0.80)", async () => {
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Base fact", type: "fact", similarity: 0.77 },
    ]);

    const result = await resolveMemoryConflict(supabase, "Additional detail about base fact");

    expect(result.action).toBe("merge");
    expect((result as any).existingId).toBe("f1");
  });

  it("returns 'insert' for null supabase", async () => {
    const result = await resolveMemoryConflict(null, "test");
    expect(result.action).toBe("insert");
  });

  it("returns 'insert' when search not available", async () => {
    // No search handler = default empty response
    const result = await resolveMemoryConflict(supabase, "test");
    expect(result.action).toBe("insert");
  });

  it("boundary: exactly 0.85 is skip", async () => {
    supabase._registerRpc("bump_memory_access", () => null);
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Fact", type: "fact", similarity: 0.85 },
    ]);

    const result = await resolveMemoryConflict(supabase, "Fact");
    expect(result.action).toBe("skip");
  });

  it("boundary: exactly 0.80 is update", async () => {
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Fact", type: "fact", similarity: 0.80 },
    ]);

    const result = await resolveMemoryConflict(supabase, "Fact");
    expect(result.action).toBe("update");
  });

  it("boundary: exactly 0.75 is merge", async () => {
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Fact", type: "fact", similarity: 0.75 },
    ]);

    const result = await resolveMemoryConflict(supabase, "Fact");
    expect(result.action).toBe("merge");
  });
});

// ── updateMemoryWithRevision (S36-04/05) ────────────────────────

describe("updateMemoryWithRevision", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      memory: [
        {
          id: "f1",
          type: "fact",
          content: "Original content",
          metadata: {},
          embedding: [0.1, 0.2],
        },
      ],
    });
  });

  it("replaces content in update mode (contradiction)", async () => {
    const result = await updateMemoryWithRevision(supabase, "f1", "New content", "update");

    expect(result).toBe(true);
    const memory = supabase._getTable("memory");
    expect(memory[0].content).toBe("New content");
  });

  it("appends content in merge mode (complement)", async () => {
    const result = await updateMemoryWithRevision(supabase, "f1", "Extra detail", "merge");

    expect(result).toBe(true);
    const memory = supabase._getTable("memory");
    expect(memory[0].content).toBe("Original content. Extra detail");
  });

  it("stores previous version in metadata", async () => {
    await updateMemoryWithRevision(supabase, "f1", "New content", "update");

    const memory = supabase._getTable("memory");
    expect(memory[0].metadata.previous_versions).toEqual(["Original content"]);
  });

  it("increments revision_count", async () => {
    await updateMemoryWithRevision(supabase, "f1", "Rev 1", "update");

    const memory = supabase._getTable("memory");
    expect(memory[0].metadata.revision_count).toBe(1);
  });

  it("accumulates previous versions on multiple revisions", async () => {
    await updateMemoryWithRevision(supabase, "f1", "Rev 1", "update");
    await updateMemoryWithRevision(supabase, "f1", "Rev 2", "update");

    const memory = supabase._getTable("memory");
    expect(memory[0].metadata.previous_versions).toEqual(["Original content", "Rev 1"]);
    expect(memory[0].metadata.revision_count).toBe(2);
    expect(memory[0].content).toBe("Rev 2");
  });

  it("clears embedding to trigger regeneration", async () => {
    await updateMemoryWithRevision(supabase, "f1", "New", "update");

    const memory = supabase._getTable("memory");
    expect(memory[0].embedding).toBeNull();
  });

  it("sets last_revised_at timestamp", async () => {
    await updateMemoryWithRevision(supabase, "f1", "New", "update");

    const memory = supabase._getTable("memory");
    expect(memory[0].metadata.last_revised_at).toBeDefined();
  });

  it("returns false for null supabase", async () => {
    const result = await updateMemoryWithRevision(null, "f1", "New", "update");
    expect(result).toBe(false);
  });

  it("returns false for empty existingId", async () => {
    const result = await updateMemoryWithRevision(supabase, "", "New", "update");
    expect(result).toBe(false);
  });

  it("returns false when memory not found", async () => {
    const result = await updateMemoryWithRevision(supabase, "nonexistent", "New", "update");
    expect(result).toBe(false);
  });
});

// ── processMemoryIntents with conflict resolution (S36-03/04/05) ─

describe("processMemoryIntents conflict resolution", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("skips duplicate REMEMBER tag (similarity >= 0.85)", async () => {
    supabase._registerRpc("bump_memory_access", () => null);
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Same fact exists", type: "fact", similarity: 0.90 },
    ]);

    const input = "Noted. [REMEMBER: Same fact exists already]";
    const result = await processMemoryIntents(supabase, input);

    expect(result).toBe("Noted.");
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(0); // No new memory created
  });

  it("updates existing on contradiction (0.80 <= sim < 0.85)", async () => {
    supabase._store.memory = [
      { id: "f1", type: "fact", content: "Project uses MySQL", metadata: {} },
    ];
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Project uses MySQL", type: "fact", similarity: 0.82 },
    ]);

    const input = "[REMEMBER: Project uses PostgreSQL now]";
    await processMemoryIntents(supabase, input);

    const memory = supabase._getTable("memory");
    expect(memory[0].content).toBe("Project uses PostgreSQL now");
    expect(memory[0].metadata.previous_versions).toEqual(["Project uses MySQL"]);
  });

  it("merges on complement (0.75 <= sim < 0.80)", async () => {
    supabase._store.memory = [
      { id: "f1", type: "fact", content: "Edouard is a developer", metadata: {} },
    ];
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Edouard is a developer", type: "fact", similarity: 0.77 },
    ]);

    const input = "[REMEMBER: based in Paris]";
    await processMemoryIntents(supabase, input);

    const memory = supabase._getTable("memory");
    expect(memory[0].content).toBe("Edouard is a developer. based in Paris");
  });

  it("inserts normally when no similar fact (< 0.75)", async () => {
    supabase._registerFunction("search", () => []);

    const input = "[REMEMBER: Brand new unique fact]";
    await processMemoryIntents(supabase, input);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].content).toBe("Brand new unique fact");
    expect(memory[0].type).toBe("fact");
  });
});

// ── autoRemember with actionability filter (S36-06) ─────────────

describe("autoRemember actionability filter", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("filters out facts with low actionability (< 5)", async () => {
    const classification = {
      type: "observation",
      topics: ["chat"],
      people: [],
      action_items: [],
      is_memorable: true,
      actionability_score: 3,
      summary: "Just chatting",
    };

    await autoRemember(supabase, "Just chatting about stuff", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(0);
  });

  it("allows facts with high actionability (>= 5)", async () => {
    const classification = {
      type: "decision",
      topics: ["architecture"],
      people: [],
      action_items: [],
      is_memorable: true,
      actionability_score: 8,
      summary: "Use PostgreSQL for the project",
    };

    await autoRemember(supabase, "We use PostgreSQL", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].type).toBe("fact");
  });

  it("bypasses filter for ideas regardless of score", async () => {
    const classification = {
      type: "idea",
      topics: ["feature"],
      people: [],
      action_items: [],
      is_memorable: true,
      is_idea: true,
      actionability_score: 2,
      summary: "Maybe add a dark mode",
    };

    await autoRemember(supabase, "Maybe add a dark mode", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].type).toBe("idea");
  });

  it("defaults to actionability 7 when not provided (EC-003)", async () => {
    const classification = {
      type: "decision",
      topics: ["database"],
      people: [],
      action_items: [],
      is_memorable: true,
      // No actionability_score — should default to 7, which passes threshold
      summary: "Use PostgreSQL",
    };

    await autoRemember(supabase, "We use PostgreSQL", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1); // Should be stored (7 >= 5)
  });

  it("boundary: actionability exactly 5 passes", async () => {
    const classification = {
      type: "observation",
      topics: ["note"],
      people: [],
      action_items: [],
      is_memorable: true,
      actionability_score: 5,
      summary: "Moderate observation",
    };

    await autoRemember(supabase, "Moderate observation", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
  });

  it("boundary: actionability 4 is filtered", async () => {
    const classification = {
      type: "observation",
      topics: ["note"],
      people: [],
      action_items: [],
      is_memorable: true,
      actionability_score: 4,
      summary: "Low value observation",
    };

    await autoRemember(supabase, "Low value observation", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(0);
  });
});

// ── autoRemember with conflict resolution (S36-03/04/05) ────────

describe("autoRemember conflict resolution for facts", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("skips duplicate fact in autoRemember", async () => {
    supabase._registerRpc("bump_memory_access", () => null);
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Same fact", type: "fact", similarity: 0.90 },
    ]);

    const classification = {
      type: "decision",
      topics: ["db"],
      people: [],
      action_items: [],
      is_memorable: true,
      actionability_score: 8,
      summary: "Same fact rephrased",
    };

    await autoRemember(supabase, "Same fact rephrased", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(0); // No new memory
  });

  it("updates existing fact on contradiction in autoRemember", async () => {
    supabase._store.memory = [
      { id: "f1", type: "fact", content: "Uses MySQL", metadata: {} },
    ];
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Uses MySQL", type: "fact", similarity: 0.82 },
    ]);

    const classification = {
      type: "decision",
      topics: ["db"],
      people: [],
      action_items: [],
      is_memorable: true,
      actionability_score: 8,
      summary: "Now uses PostgreSQL",
    };

    await autoRemember(supabase, "We switched to PostgreSQL", classification);

    const memory = supabase._getTable("memory");
    expect(memory[0].content).toBe("Now uses PostgreSQL");
    expect(memory[0].metadata.revision_count).toBe(1);
  });

  it("still creates goals from action_items when fact is deduplicated", async () => {
    supabase._registerRpc("bump_memory_access", () => null);
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Same fact", type: "fact", similarity: 0.90 },
    ]);

    const classification = {
      type: "decision",
      topics: ["deployment"],
      people: [],
      action_items: ["Deploy to staging"],
      is_memorable: true,
      actionability_score: 8,
      summary: "Same fact",
    };

    await autoRemember(supabase, "Same fact again", classification);

    const memory = supabase._getTable("memory");
    // Only the goal from action_items should be created, not the fact
    expect(memory.length).toBe(1);
    expect(memory[0].type).toBe("goal");
    expect(memory[0].content).toBe("Deploy to staging");
  });
});

// ── promoteWorkingMemory (S36-08) ───────────────────────────────

describe("promoteWorkingMemory", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    // No search handler → resolveMemoryConflict returns "insert"
    supabase._registerFunction("search", () => []);
  });

  it("promotes decisions to permanent memories", async () => {
    const wm: WorkingMemoryData = {
      decisions: [
        { agent: "architect", decision: "Use microservices", reasoning: "Better scalability" },
      ],
      discoveries: [],
      blockers: [],
      context_updates: [],
    };

    const count = await promoteWorkingMemory(supabase, wm, "session-1");

    expect(count).toBe(1);
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].type).toBe("fact");
    expect(memory[0].content).toContain("Use microservices");
    expect(memory[0].content).toContain("Better scalability");
    expect(memory[0].metadata.source).toBe("working_memory_promotion");
    expect(memory[0].metadata.pipeline_session_id).toBe("session-1");
  });

  it("promotes discoveries to permanent memories", async () => {
    const wm: WorkingMemoryData = {
      decisions: [],
      discoveries: [
        { agent: "qa", fact: "Coverage is 85%", source: "test run" },
      ],
      blockers: [],
      context_updates: [],
    };

    const count = await promoteWorkingMemory(supabase, wm, "session-2");

    expect(count).toBe(1);
    const memory = supabase._getTable("memory");
    expect(memory[0].content).toBe("Coverage is 85%");
    expect(memory[0].metadata.agent).toBe("qa");
  });

  it("skips duplicate items during promotion", async () => {
    supabase._registerRpc("bump_memory_access", () => null);
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Same fact exists", type: "fact", similarity: 0.90 },
    ]);

    const wm: WorkingMemoryData = {
      decisions: [
        { agent: "dev", decision: "Same fact exists", reasoning: "Already known" },
      ],
    };

    const count = await promoteWorkingMemory(supabase, wm, "session-3");

    expect(count).toBe(0);
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(0);
  });

  it("handles multiple items", async () => {
    const wm: WorkingMemoryData = {
      decisions: [
        { agent: "architect", decision: "Use REST", reasoning: "Simpler" },
        { agent: "dev", decision: "Use TypeScript", reasoning: "Type safety" },
      ],
      discoveries: [
        { agent: "qa", fact: "No regressions found", source: "tests" },
      ],
    };

    const count = await promoteWorkingMemory(supabase, wm, "session-4");

    expect(count).toBe(3);
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(3);
  });

  it("returns 0 for null supabase", async () => {
    const wm: WorkingMemoryData = {
      decisions: [{ agent: "dev", decision: "Something", reasoning: "Because" }],
    };

    const count = await promoteWorkingMemory(null, wm, "session");
    expect(count).toBe(0);
  });

  it("returns 0 for null workingMemory", async () => {
    const count = await promoteWorkingMemory(supabase, null, "session");
    expect(count).toBe(0);
  });

  it("returns 0 for empty working memory", async () => {
    const wm: WorkingMemoryData = {
      decisions: [],
      discoveries: [],
      blockers: [],
      context_updates: [],
    };

    const count = await promoteWorkingMemory(supabase, wm, "session");
    expect(count).toBe(0);
  });

  it("ignores blockers and context_updates (not promoted)", async () => {
    const wm: WorkingMemoryData = {
      decisions: [],
      discoveries: [],
      blockers: [{ agent: "dev", issue: "API down", status: "resolved" }],
      context_updates: [{ agent: "pm", key: "priority", value: "high" }],
    };

    const count = await promoteWorkingMemory(supabase, wm, "session");
    expect(count).toBe(0);
  });
});
