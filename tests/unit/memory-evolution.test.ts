/**
 * Unit Tests — Memory Evolution (S36-03/04/05/06/08)
 *
 * Tests for duplicate detection, contradiction handling, complement merging,
 * actionability filtering, and working memory promotion.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { MemoryHealthStats } from "../../src/memory";
import {
  autoRemember,
  findSimilarFact,
  formatMemoryHealth,
  memoryHealthStats,
  processMemoryIntents,
  resolveMemoryConflict,
  updateMemoryWithRevision,
} from "../../src/memory";
import { createMockSupabase } from "../fixtures/mock-supabase";

// ── findSimilarFact (S36-03) ────────────────────────────────────

describe("findSimilarFact", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns matching fact when similarity above threshold", async () => {
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Edouard is a developer", type: "fact", similarity: 0.9 },
    ]);

    const result = await findSimilarFact(supabase, "Edouard works as a developer");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("f1");
    expect(result!.content).toBe("Edouard is a developer");
    expect(result!.similarity).toBe(0.9);
  });

  it("returns null when no match found", async () => {
    supabase._registerFunction("search", () => []);

    const result = await findSimilarFact(supabase, "Something completely new");
    expect(result).toBeNull();
  });

  it("ignores non-fact types", async () => {
    supabase._registerFunction("search", () => [
      { id: "g1", content: "Similar goal", type: "goal", similarity: 0.9 },
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
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    let searchBody: any = null;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    supabase._registerFunction("search", (opts: any) => {
      searchBody = opts?.body;
      return [];
    });

    await findSimilarFact(supabase, "test", 0.9);
    expect(searchBody.match_threshold).toBe(0.9);
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
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    expect((result as any).existingId).toBe("f1");
  });

  it("bumps access on duplicate detection", async () => {
    let bumpedIds: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
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
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    expect((result as any).existingId).toBe("f1");
  });

  it("returns 'merge' for complement (0.75 <= similarity < 0.80)", async () => {
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Base fact", type: "fact", similarity: 0.77 },
    ]);

    const result = await resolveMemoryConflict(supabase, "Additional detail about base fact");

    expect(result.action).toBe("merge");
    // biome-ignore lint/suspicious/noExplicitAny: test mock
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
      { id: "f1", content: "Fact", type: "fact", similarity: 0.8 },
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
      { id: "f1", content: "Same fact exists", type: "fact", similarity: 0.9 },
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
      { id: "f1", content: "Same fact", type: "fact", similarity: 0.9 },
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
    supabase._store.memory = [{ id: "f1", type: "fact", content: "Uses MySQL", metadata: {} }];
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
      { id: "f1", content: "Same fact", type: "fact", similarity: 0.9 },
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

// ── memoryHealthStats ──────────────────────────────────────────

describe("memoryHealthStats", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  // V9: Returns defaults when supabase is null
  it("[V9] returns empty stats when supabase is null", async () => {
    const stats = await memoryHealthStats(null);

    expect(stats.total).toBe(0);
    expect(stats.byType).toEqual({});
    expect(stats.embeddingCoverage).toBe(0);
    expect(stats.avgImportanceScore).toBe(0);
    expect(stats.avgAgeDays).toBe(0);
    expect(stats.recentPromotions).toBe(0);
    expect(stats.linksCount).toBe(0);
    expect(stats.archiveCount).toBe(0);
    expect(stats.topAccessed).toEqual([]);
  });

  // V16: Returns 0 for avgImportanceScore and avgAgeDays when total=0 (no NaN)
  it("[V16] returns 0 for averages when memory table is empty (no NaN)", async () => {
    // Empty store — no memories
    const stats = await memoryHealthStats(supabase);

    expect(stats.total).toBe(0);
    expect(stats.avgImportanceScore).toBe(0);
    expect(stats.avgAgeDays).toBe(0);
    expect(Number.isNaN(stats.avgImportanceScore)).toBe(false);
    expect(Number.isNaN(stats.avgAgeDays)).toBe(false);
  });

  // V6: Returns total by type
  it("[V6] returns correct totals by type", async () => {
    const now = new Date().toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 1,
        content: "Fact 1",
      },
      {
        id: "2",
        type: "fact",
        importance_score: 70,
        created_at: now,
        access_count: 0,
        content: "Fact 2",
      },
      {
        id: "3",
        type: "goal",
        importance_score: 80,
        created_at: now,
        access_count: 2,
        content: "Goal 1",
      },
      {
        id: "4",
        type: "idea",
        importance_score: 30,
        created_at: now,
        access_count: 0,
        content: "Idea 1",
      },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.total).toBe(4);
    expect(stats.byType.fact).toBe(2);
    expect(stats.byType.goal).toBe(1);
    expect(stats.byType.idea).toBe(1);
  });

  // V7: Embedding coverage ratio
  it("[V7] calculates embedding coverage ratio", async () => {
    const now = new Date().toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
        embedding: [0.1],
      },
      {
        id: "2",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "B",
        embedding: [0.2],
      },
      {
        id: "3",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "C",
        embedding: null,
      },
    ];

    const stats = await memoryHealthStats(supabase);

    // 2 out of 3 have embeddings
    expect(stats.embeddingCoverage).toBeCloseTo(2 / 3, 2);
  });

  // V14: Average importance score and age
  it("[V14] calculates average importance score and age in days", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 40,
        created_at: twoDaysAgo,
        access_count: 0,
        content: "A",
      },
      {
        id: "2",
        type: "fact",
        importance_score: 60,
        created_at: fourDaysAgo,
        access_count: 0,
        content: "B",
      },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.avgImportanceScore).toBe(50); // (40+60)/2
    expect(stats.avgAgeDays).toBeGreaterThan(2.5);
    expect(stats.avgAgeDays).toBeLessThan(3.5); // ~3 days avg
  });

  // V8: Recent promotions count (7 days, inserts only)
  it("[V8] counts recent promotions within 7 days", async () => {
    const now = new Date().toISOString();
    const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
        metadata: { source: "working_memory_promotion" },
      },
      {
        id: "2",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "B",
        metadata: { source: "working_memory_promotion" },
      },
      {
        id: "3",
        type: "fact",
        importance_score: 50,
        created_at: oldDate,
        access_count: 0,
        content: "C",
        metadata: { source: "working_memory_promotion" },
      },
      {
        id: "4",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "D",
        metadata: { source: "manual" },
      },
    ];

    const stats = await memoryHealthStats(supabase);

    // Only 2 recent promotions (within 7 days, source = working_memory_promotion)
    expect(stats.recentPromotions).toBe(2);
  });

  it("returns links and archive counts", async () => {
    const now = new Date().toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
      },
    ];
    supabase._store.memory_links = [
      { id: "l1", source_id: "1", target_id: "2" },
      { id: "l2", source_id: "2", target_id: "3" },
    ];
    supabase._store.memory_archive = [{ id: "a1", archived_at: now }];

    const stats = await memoryHealthStats(supabase);

    expect(stats.linksCount).toBe(2);
    expect(stats.archiveCount).toBe(1);
  });

  it("returns top accessed memories filtered by access_count > 0", async () => {
    const now = new Date().toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 10,
        content: "Most accessed",
      },
      {
        id: "2",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 5,
        content: "Second",
      },
      {
        id: "3",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "Never accessed",
      },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.topAccessed.length).toBe(2); // access_count > 0 only
    expect(stats.topAccessed[0].content).toBe("Most accessed");
    expect(stats.topAccessed[0].accessCount).toBe(10);
  });
});

// ── formatMemoryHealth ──────────────────────────────────────────

describe("formatMemoryHealth", () => {
  // V10: Produces readable plain text (no markdown)
  it("[V10] formats stats as plain text without markdown", () => {
    const stats: MemoryHealthStats = {
      total: 142,
      byType: { fact: 98, goal: 12, idea: 23, preference: 9 },
      embeddingCoverage: 0.92,
      avgImportanceScore: 47.3,
      avgAgeDays: 18.2,
      recentPromotions: 5,
      linksCount: 87,
      archiveCount: 34,
      topAccessed: [
        { content: "Bun runtime is the default", accessCount: 14 },
        { content: "Supabase schema uses memory table", accessCount: 11 },
      ],
    };

    const text = formatMemoryHealth(stats);

    expect(text).toContain("SANTE MEMOIRE");
    expect(text).toContain("Total: 142 memoires actives");
    expect(text).toContain("fact: 98");
    expect(text).toContain("goal: 12");
    expect(text).toContain("Embeddings: 131/142 (92%)");
    expect(text).toContain("Importance moyenne: 47.3");
    expect(text).toContain("Age moyen: 18.2 jours");
    expect(text).toContain("Liens semantiques: 87");
    expect(text).toContain("Archive: 34");
    expect(text).toContain("Promotions recentes (7j): 5");
    expect(text).toContain("Top acces:");
    expect(text).toContain("14x");
    // No markdown chars
    expect(text).not.toContain("**");
    expect(text).not.toContain("##");
    expect(text).not.toContain("```");
  });

  it("handles empty stats (total=0)", () => {
    const stats: MemoryHealthStats = {
      total: 0,
      byType: {},
      embeddingCoverage: 0,
      avgImportanceScore: 0,
      avgAgeDays: 0,
      recentPromotions: 0,
      linksCount: 0,
      archiveCount: 0,
      topAccessed: [],
    };

    const text = formatMemoryHealth(stats);

    expect(text).toContain("SANTE MEMOIRE");
    expect(text).toContain("Total: 0 memoires actives");
    expect(text).not.toContain("Top acces:");
  });

  it("truncates long content in topAccessed display", () => {
    const stats: MemoryHealthStats = {
      total: 10,
      byType: { fact: 10 },
      embeddingCoverage: 1,
      avgImportanceScore: 50,
      avgAgeDays: 5,
      recentPromotions: 0,
      linksCount: 0,
      archiveCount: 0,
      topAccessed: [{ content: "A".repeat(100), accessCount: 5 }],
    };

    const text = formatMemoryHealth(stats);

    expect(text).toContain("...");
    // The displayed content should be truncated
    expect(text).toContain("5x");
  });
});
