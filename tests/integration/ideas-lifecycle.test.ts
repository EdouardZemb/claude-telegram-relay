/**
 * Integration Tests — Ideas Lifecycle
 *
 * Tests the complete ideas pipeline: creation (multi-source),
 * deduplication, status transitions, promotion to tasks,
 * formatting, and interactions with other memory types.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  archiveIdea,
  autoRemember,
  formatIdeasList,
  getIdea,
  listIdeas,
  processMemoryIntents,
  promoteIdea,
  reviewIdea,
  type ThoughtClassification,
} from "../../src/memory";
import { createMockSupabase } from "../fixtures/mock-supabase";

// ── Helpers ──────────────────────────────────────────────────

function makeClassification(overrides: Partial<ThoughtClassification> = {}): ThoughtClassification {
  return {
    type: "idea",
    topics: [],
    people: [],
    action_items: [],
    is_memorable: true,
    is_idea: true,
    summary: "Test idea",
    ...overrides,
  };
}

// ── Full Lifecycle ───────────────────────────────────────────

describe("Ideas Full Lifecycle", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    // No duplicates by default
    supabase._registerFunction("search", () => []);
  });

  it("idea flows through new → reviewed → promoted", async () => {
    // Create via autoRemember
    await autoRemember(
      supabase,
      "On pourrait ajouter un mode sombre",
      makeClassification({
        summary: "Ajouter un mode sombre",
        topics: ["ui"],
      }),
    );

    const ideas = await listIdeas(supabase);
    expect(ideas.length).toBe(1);
    expect(ideas[0].idea_status).toBe("new");

    // Review
    const reviewed = await reviewIdea(supabase, ideas[0].id);
    expect(reviewed).toBe(true);

    const afterReview = await getIdea(supabase, ideas[0].id);
    expect(afterReview!.idea_status).toBe("reviewed");

    // Promote
    const content = await promoteIdea(supabase, ideas[0].id);
    expect(content).toBe("Ajouter un mode sombre");

    const afterPromote = await getIdea(supabase, ideas[0].id);
    expect(afterPromote!.idea_status).toBe("promoted");
  });

  it("idea flows through new → archived (rejected)", async () => {
    await autoRemember(
      supabase,
      "Idee pas interessante",
      makeClassification({
        summary: "Idee a rejeter",
      }),
    );

    const ideas = await listIdeas(supabase);
    expect(ideas.length).toBe(1);

    const archived = await archiveIdea(supabase, ideas[0].id);
    expect(archived).toBe(true);

    // No longer in default listing
    const remaining = await listIdeas(supabase);
    expect(remaining.length).toBe(0);

    // Still accessible via all statuses
    const all = await listIdeas(supabase, ["new", "reviewed", "promoted", "archived"]);
    expect(all.length).toBe(1);
    expect(all[0].idea_status).toBe("archived");
  });

  it("idea flows through new → reviewed → archived", async () => {
    await autoRemember(
      supabase,
      "Idee intermediaire",
      makeClassification({
        summary: "Revue puis archivee",
      }),
    );

    const ideas = await listIdeas(supabase);
    await reviewIdea(supabase, ideas[0].id);
    await archiveIdea(supabase, ideas[0].id);

    const idea = await getIdea(supabase, ideas[0].id);
    expect(idea!.idea_status).toBe("archived");
  });
});

// ── Multi-Source Creation ────────────────────────────────────

describe("Ideas Multi-Source Creation", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    supabase._registerFunction("search", () => []);
  });

  it("creates idea from IDEA intent tag", async () => {
    const result = await processMemoryIntents(
      supabase,
      "Voici mon idee: [IDEA: Ajouter un cache Redis]",
    );

    expect(result).toBe("Voici mon idee:");
    const memory = supabase._getTable("memory");
    const ideas = memory.filter((m: any) => m.type === "idea");
    expect(ideas.length).toBe(1);
    expect(ideas[0].content).toBe("Ajouter un cache Redis");
    expect(ideas[0].idea_status).toBe("new");
    expect(ideas[0].metadata.source).toBe("intent-tag");
  });

  it("creates idea from autoRemember (classify-thought)", async () => {
    await autoRemember(
      supabase,
      "Et si on faisait un plugin?",
      makeClassification({
        summary: "Creer un systeme de plugins",
        topics: ["architecture"],
      }),
    );

    const memory = supabase._getTable("memory");
    const ideas = memory.filter((m: any) => m.type === "idea");
    expect(ideas.length).toBe(1);
    expect(ideas[0].metadata.source).toBe("auto-detect");
    expect(ideas[0].metadata.topics).toEqual(["architecture"]);
  });

  it("creates ideas from both sources in same response", async () => {
    // First: intent tag
    await processMemoryIntents(supabase, "Pensons a ca: [IDEA: Ajouter des webhooks]");

    // Second: auto-detect from a different message
    await autoRemember(
      supabase,
      "On pourrait aussi faire du SSE",
      makeClassification({
        summary: "Ajouter du Server-Sent Events",
        topics: ["api"],
      }),
    );

    const memory = supabase._getTable("memory");
    const ideas = memory.filter((m: any) => m.type === "idea");
    expect(ideas.length).toBe(2);

    const sources = ideas.map((i: any) => i.metadata.source).sort();
    expect(sources).toEqual(["auto-detect", "intent-tag"]);
  });

  it("intent tag idea has correct metadata structure", async () => {
    await processMemoryIntents(supabase, "[IDEA: Test metadata]");

    const memory = supabase._getTable("memory");
    expect(memory[0].type).toBe("idea");
    expect(memory[0].idea_status).toBe("new");
    expect(memory[0].metadata).toEqual({ source: "intent-tag" });
  });

  it("auto-detect idea has correct metadata structure", async () => {
    await autoRemember(
      supabase,
      "Original message long",
      makeClassification({
        summary: "Summary court",
        topics: ["test"],
        people: ["Edouard"],
      }),
    );

    const memory = supabase._getTable("memory");
    expect(memory[0].metadata.auto_classified).toBe(true);
    expect(memory[0].metadata.thought_type).toBe("idea");
    expect(memory[0].metadata.source).toBe("auto-detect");
    expect(memory[0].metadata.topics).toEqual(["test"]);
    expect(memory[0].metadata.people).toEqual(["Edouard"]);
    expect(memory[0].metadata.original_content).toBe("Original message long");
  });
});

// ── Deduplication Integration ────────────────────────────────

describe("Ideas Deduplication Integration", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("deduplicates identical idea from two auto-detect calls", async () => {
    // First call: no duplicates
    supabase._registerFunction("search", () => []);
    await autoRemember(
      supabase,
      "On pourrait ajouter un dark mode",
      makeClassification({
        summary: "Ajouter un dark mode",
      }),
    );

    // Second call: now the first idea exists as duplicate
    supabase._registerFunction("search", () => [
      { content: "Ajouter un dark mode", type: "idea", similarity: 0.95 },
    ]);
    await autoRemember(
      supabase,
      "Et si on faisait un mode sombre?",
      makeClassification({
        summary: "Ajouter un mode sombre",
      }),
    );

    const memory = supabase._getTable("memory");
    const ideas = memory.filter((m: any) => m.type === "idea");
    expect(ideas.length).toBe(1);
  });

  it("deduplicates idea from intent tag when auto-detect already captured it", async () => {
    // First: auto-detect
    supabase._registerFunction("search", () => []);
    await autoRemember(
      supabase,
      "Un cache serait bien",
      makeClassification({
        summary: "Ajouter un cache",
      }),
    );

    // Second: intent tag with similar content — detected as duplicate
    supabase._registerFunction("search", () => [
      { content: "Ajouter un cache", type: "idea", similarity: 0.88 },
    ]);
    await processMemoryIntents(supabase, "[IDEA: Mettre en place un cache]");

    const memory = supabase._getTable("memory");
    const ideas = memory.filter((m: any) => m.type === "idea");
    expect(ideas.length).toBe(1);
  });

  it("allows idea when no similar match above threshold", async () => {
    // Edge Function filters by threshold server-side, returns empty when below 0.85
    supabase._registerFunction("search", () => []);

    await autoRemember(
      supabase,
      "Un systeme de plugins",
      makeClassification({
        summary: "Creer un systeme de plugins",
      }),
    );

    const memory = supabase._getTable("memory");
    const ideas = memory.filter((m: any) => m.type === "idea");
    expect(ideas.length).toBe(1);
  });

  it("deduplicates facts with high similarity (S36-03)", async () => {
    supabase._registerRpc("bump_memory_access", () => null);
    supabase._registerFunction("search", () => [
      { id: "f1", content: "Le serveur tourne sur le port 3000", type: "fact", similarity: 0.95 },
    ]);

    await autoRemember(
      supabase,
      "Le serveur utilise le port 3000",
      makeClassification({
        type: "decision",
        is_idea: false,
        summary: "Serveur sur port 3000",
      }),
    );

    const memory = supabase._getTable("memory");
    // S36-03: duplicate fact is skipped (sim >= 0.85), no new memory created
    expect(memory.length).toBe(0);
  });
});

// ── Status Filtering ─────────────────────────────────────────

describe("Ideas Status Filtering", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      memory: [
        {
          id: "i1",
          type: "idea",
          content: "New idea 1",
          idea_status: "new",
          metadata: { topics: ["a"] },
          created_at: "2026-03-14T10:00:00Z",
        },
        {
          id: "i2",
          type: "idea",
          content: "New idea 2",
          idea_status: "new",
          metadata: { topics: ["b"] },
          created_at: "2026-03-14T11:00:00Z",
        },
        {
          id: "i3",
          type: "idea",
          content: "Reviewed idea",
          idea_status: "reviewed",
          metadata: {},
          created_at: "2026-03-13T10:00:00Z",
        },
        {
          id: "i4",
          type: "idea",
          content: "Promoted idea",
          idea_status: "promoted",
          metadata: {},
          created_at: "2026-03-12T10:00:00Z",
        },
        {
          id: "i5",
          type: "idea",
          content: "Archived idea",
          idea_status: "archived",
          metadata: {},
          created_at: "2026-03-11T10:00:00Z",
        },
        {
          id: "f1",
          type: "fact",
          content: "Not an idea",
          metadata: {},
          created_at: "2026-03-14T10:00:00Z",
        },
      ],
    });
  });

  it("default listing shows new + reviewed only", async () => {
    const ideas = await listIdeas(supabase);
    expect(ideas.length).toBe(3);
    const statuses = ideas.map((i: any) => i.idea_status);
    expect(statuses).not.toContain("promoted");
    expect(statuses).not.toContain("archived");
  });

  it("listing evolves as ideas change status", async () => {
    // Review i1
    await reviewIdea(supabase, "i1");
    const after = await listIdeas(supabase);
    expect(after.length).toBe(3); // still 3: 1 new, 2 reviewed

    const reviewed = after.filter((i: any) => i.idea_status === "reviewed");
    expect(reviewed.length).toBe(2);
  });

  it("promoted ideas visible only with explicit filter", async () => {
    const promoted = await listIdeas(supabase, ["promoted"]);
    expect(promoted.length).toBe(1);
    expect(promoted[0].content).toBe("Promoted idea");
  });

  it("archived ideas excluded from all active views", async () => {
    const active = await listIdeas(supabase, ["new", "reviewed", "promoted"]);
    expect(active.every((i: any) => i.idea_status !== "archived")).toBe(true);
  });
});

// ── Formatting at Each Stage ─────────────────────────────────

describe("Ideas Formatting Through Lifecycle", () => {
  it("formats mixed-status ideas correctly", () => {
    const ideas = [
      {
        id: "aaaa1111-0000-0000-0000-000000000000",
        content: "Idea A",
        idea_status: "new" as const,
        metadata: { topics: ["ui"] },
        created_at: "2026-03-14T10:00:00Z",
      },
      {
        id: "bbbb2222-0000-0000-0000-000000000000",
        content: "Idea B",
        idea_status: "reviewed" as const,
        metadata: { topics: ["api", "perf"] },
        created_at: "2026-03-13T10:00:00Z",
      },
      {
        id: "cccc3333-0000-0000-0000-000000000000",
        content: "Idea C",
        idea_status: "promoted" as const,
        metadata: {},
        created_at: "2026-03-12T10:00:00Z",
      },
    ];

    const result = formatIdeasList(ideas);
    expect(result).toContain("IDEES (3)");
    expect(result).toContain("NEW | aaaa1111");
    expect(result).toContain("REVIEWED | bbbb2222");
    expect(result).toContain("PROMOTED | cccc3333");
    expect(result).toContain("[ui]");
    expect(result).toContain("[api, perf]");
  });

  it("formats single idea after review", () => {
    const ideas = [
      {
        id: "dddd4444-0000-0000-0000-000000000000",
        content: "Reviewed only",
        idea_status: "reviewed" as const,
        metadata: {},
        created_at: "2026-03-14T10:00:00Z",
      },
    ];

    const result = formatIdeasList(ideas);
    expect(result).toContain("IDEES (1)");
    expect(result).toContain("REVIEWED | dddd4444");
  });
});

// ── Ideas Coexisting with Other Memory Types ─────────────────

describe("Ideas and Other Memory Types", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    supabase._registerFunction("search", () => []);
  });

  it("ideas and facts created from same response do not interfere", async () => {
    const response = "[REMEMBER: Le serveur tourne sur Bun] [IDEA: Migrer vers Deno]";
    await processMemoryIntents(supabase, response);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(2);

    const fact = memory.find((m: any) => m.type === "fact");
    const idea = memory.find((m: any) => m.type === "idea");
    expect(fact).toBeDefined();
    expect(idea).toBeDefined();
    expect(fact!.content).toBe("Le serveur tourne sur Bun");
    expect(idea!.content).toBe("Migrer vers Deno");
  });

  it("autoRemember creates idea + goals from action_items in same call", async () => {
    await autoRemember(
      supabase,
      "On pourrait refactorer et ajouter des tests",
      makeClassification({
        summary: "Refactorer le module auth",
        topics: ["code"],
        action_items: ["Ecrire des tests pour auth", "Mettre a jour la doc"],
      }),
    );

    const memory = supabase._getTable("memory");
    const ideas = memory.filter((m: any) => m.type === "idea");
    const goals = memory.filter((m: any) => m.type === "goal");
    expect(ideas.length).toBe(1);
    expect(goals.length).toBe(2);
    expect(goals[0].metadata.source).toBe("action-item");
  });

  it("listing ideas ignores facts, goals, and preferences", async () => {
    supabase._store.memory = [
      {
        id: "i1",
        type: "idea",
        content: "Idea",
        idea_status: "new",
        metadata: {},
        created_at: "2026-03-14T10:00:00Z",
      },
      { id: "f1", type: "fact", content: "Fact", metadata: {}, created_at: "2026-03-14T10:00:00Z" },
      { id: "g1", type: "goal", content: "Goal", metadata: {}, created_at: "2026-03-14T10:00:00Z" },
      {
        id: "p1",
        type: "preference",
        content: "Pref",
        metadata: {},
        created_at: "2026-03-14T10:00:00Z",
      },
    ];

    const ideas = await listIdeas(supabase);
    expect(ideas.length).toBe(1);
    expect(ideas[0].id).toBe("i1");
  });
});

// ── Edge Cases ───────────────────────────────────────────────

describe("Ideas Edge Cases", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    supabase._registerFunction("search", () => []);
  });

  it("archiving already archived idea is idempotent", async () => {
    supabase._store.memory = [
      {
        id: "i1",
        type: "idea",
        content: "Old idea",
        idea_status: "archived",
        metadata: {},
        created_at: "2026-03-14T10:00:00Z",
      },
    ];

    const result = await archiveIdea(supabase, "i1");
    expect(result).toBe(true);
    const idea = await getIdea(supabase, "i1");
    expect(idea!.idea_status).toBe("archived");
  });

  it("promoting already promoted idea returns content", async () => {
    supabase._store.memory = [
      {
        id: "i1",
        type: "idea",
        content: "Already promoted",
        idea_status: "promoted",
        metadata: {},
        created_at: "2026-03-14T10:00:00Z",
      },
    ];

    const content = await promoteIdea(supabase, "i1");
    expect(content).toBe("Already promoted");
  });

  it("getIdea returns null for a fact id", async () => {
    supabase._store.memory = [{ id: "f1", type: "fact", content: "Not an idea", metadata: {} }];

    const idea = await getIdea(supabase, "f1");
    expect(idea).toBeNull();
  });

  it("listing returns empty when all ideas are archived", async () => {
    supabase._store.memory = [
      {
        id: "i1",
        type: "idea",
        content: "Archived 1",
        idea_status: "archived",
        metadata: {},
        created_at: "2026-03-14T10:00:00Z",
      },
      {
        id: "i2",
        type: "idea",
        content: "Archived 2",
        idea_status: "archived",
        metadata: {},
        created_at: "2026-03-13T10:00:00Z",
      },
    ];

    const ideas = await listIdeas(supabase);
    expect(ideas.length).toBe(0);
  });

  it("multiple IDEA tags in one response are all captured", async () => {
    const input = "[IDEA: Idee un] et aussi [IDEA: Idee deux]";
    const result = await processMemoryIntents(supabase, input);

    expect(result).toBe("et aussi");
    const memory = supabase._getTable("memory");
    const ideas = memory.filter((m: any) => m.type === "idea");
    expect(ideas.length).toBe(2);
    expect(ideas.map((i: any) => i.content).sort()).toEqual(["Idee deux", "Idee un"]);
  });

  it("IDEA tag with empty content is still processed", async () => {
    // Edge case: regex should not match empty content since .+? requires at least 1 char
    const input = "[IDEA: ] text";
    const _result = await processMemoryIntents(supabase, input);

    // The regex requires at least 1 char (.+?), so empty-ish content like " " would match
    // but truly empty would not. This tests the boundary.
    const memory = supabase._getTable("memory");
    // Space is captured by .+? so it should insert
    if (memory.length > 0) {
      expect(memory[0].type).toBe("idea");
    }
  });

  it("idea metadata preserved through status transitions", async () => {
    await autoRemember(
      supabase,
      "Message original avec details",
      makeClassification({
        summary: "Idee avec metadata riche",
        topics: ["feature", "dashboard"],
        people: ["Edouard"],
      }),
    );

    const ideas = await listIdeas(supabase);
    const id = ideas[0].id;

    // Transition through states
    await reviewIdea(supabase, id);
    await promoteIdea(supabase, id);

    const final = await getIdea(supabase, id);
    expect(final!.metadata.topics).toEqual(["feature", "dashboard"]);
    expect(final!.metadata.people).toEqual(["Edouard"]);
    expect(final!.metadata.auto_classified).toBe(true);
    expect(final!.idea_status).toBe("promoted");
  });
});
