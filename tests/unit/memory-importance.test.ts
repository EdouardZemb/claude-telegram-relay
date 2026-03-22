/**
 * Unit Tests — Memory Importance Scoring & Decay (S23-02/03/04)
 *
 * Tests for calculateEffectiveImportance, bumpMemoryAccess,
 * ranked getMemoryContext, and contradiction detection.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  bumpMemoryAccess,
  calculateEffectiveImportance,
  detectAndLogContradiction,
  findContradiction,
  getMemoryContext,
} from "../../src/memory";
import { createMockSupabase } from "../fixtures/mock-supabase";

// ── calculateEffectiveImportance (S23-02) ────────────────────

describe("calculateEffectiveImportance", () => {
  const now = new Date("2026-03-15T12:00:00Z");

  it("returns base score for brand new memory", () => {
    const score = calculateEffectiveImportance(50, now.toISOString(), null, 0, now);
    expect(score).toBeCloseTo(50, 0);
  });

  it("decays by half after one half-life (70 days)", () => {
    const seventyDaysAgo = new Date(now.getTime() - 70 * 24 * 60 * 60 * 1000);
    const score = calculateEffectiveImportance(50, seventyDaysAgo.toISOString(), null, 0, now);
    // Should be approximately 25 (50 * 0.5)
    expect(score).toBeGreaterThan(20);
    expect(score).toBeLessThan(30);
  });

  it("decays further after two half-lives (140 days)", () => {
    const oneFortyDaysAgo = new Date(now.getTime() - 140 * 24 * 60 * 60 * 1000);
    const score = calculateEffectiveImportance(50, oneFortyDaysAgo.toISOString(), null, 0, now);
    // Should be approximately 12.5 (50 * 0.25)
    expect(score).toBeGreaterThan(10);
    expect(score).toBeLessThan(16);
  });

  it("boosts score with access count", () => {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const noAccess = calculateEffectiveImportance(50, thirtyDaysAgo.toISOString(), null, 0, now);
    const withAccess = calculateEffectiveImportance(50, thirtyDaysAgo.toISOString(), null, 5, now);
    expect(withAccess).toBeGreaterThan(noAccess);
  });

  it("caps access boost at 50% of base score", () => {
    const score = calculateEffectiveImportance(50, now.toISOString(), null, 100, now);
    // Access boost capped at 25 (50 * 0.5), so max ~75
    expect(score).toBeLessThanOrEqual(100);
  });

  it("gives recency boost for recently accessed memories", () => {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const notRecent = calculateEffectiveImportance(50, thirtyDaysAgo.toISOString(), null, 0, now);
    const recentAccess = calculateEffectiveImportance(
      50,
      thirtyDaysAgo.toISOString(),
      yesterday.toISOString(),
      0,
      now,
    );
    expect(recentAccess).toBeGreaterThan(notRecent);
  });

  it("no recency boost for old access", () => {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    const noAccess = calculateEffectiveImportance(50, thirtyDaysAgo.toISOString(), null, 0, now);
    const oldAccess = calculateEffectiveImportance(
      50,
      thirtyDaysAgo.toISOString(),
      tenDaysAgo.toISOString(),
      0,
      now,
    );
    // Old access (>7 days) should give no recency boost
    expect(oldAccess).toBeCloseTo(noAccess, 0);
  });

  it("clamps score between 0 and 100", () => {
    const veryOld = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const score = calculateEffectiveImportance(10, veryOld.toISOString(), null, 0, now);
    expect(score).toBeGreaterThanOrEqual(0);

    const high = calculateEffectiveImportance(100, now.toISOString(), now.toISOString(), 50, now);
    expect(high).toBeLessThanOrEqual(100);
  });

  it("handles score of 0", () => {
    const score = calculateEffectiveImportance(0, now.toISOString(), null, 0, now);
    expect(score).toBe(0);
  });

  it("handles score of 100", () => {
    const score = calculateEffectiveImportance(100, now.toISOString(), null, 0, now);
    expect(score).toBe(100);
  });
});

// ── bumpMemoryAccess ─────────────────────────────────────────

describe("bumpMemoryAccess", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("calls bump_memory_access RPC with IDs", async () => {
    let calledWith: any = null;
    supabase._registerRpc("bump_memory_access", (params: any) => {
      calledWith = params;
      return null;
    });

    await bumpMemoryAccess(supabase, ["id1", "id2", "id3"]);

    expect(calledWith).not.toBeNull();
    expect(calledWith.memory_ids).toEqual(["id1", "id2", "id3"]);
  });

  it("handles null supabase gracefully", async () => {
    await bumpMemoryAccess(null, ["id1"]);
    // Should not throw
  });

  it("handles empty array", async () => {
    let called = false;
    supabase._registerRpc("bump_memory_access", () => {
      called = true;
      return null;
    });

    await bumpMemoryAccess(supabase, []);
    expect(called).toBe(false);
  });
});

// ── getMemoryContext ranked (S23-03) ─────────────────────────

describe("getMemoryContext ranked", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns top facts limited to MAX_FACTS_IN_CONTEXT", async () => {
    // Generate 30 facts to exceed the limit of 20
    const facts = Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`,
      content: `Fact number ${i}`,
      importance_score: 50 - i,
      access_count: 0,
    }));

    supabase._registerRpc("get_facts", () => facts);
    supabase._registerRpc("get_active_goals", () => []);
    supabase._registerRpc("bump_memory_access", () => null);

    const context = await getMemoryContext(supabase);

    // Should contain first 20 facts only
    expect(context).toContain("Fact number 0");
    expect(context).toContain("Fact number 19");
    expect(context).not.toContain("Fact number 20");
  });

  it("returns top goals limited to MAX_GOALS_IN_CONTEXT", async () => {
    const goals = Array.from({ length: 15 }, (_, i) => ({
      id: `g${i}`,
      content: `Goal number ${i}`,
      deadline: null,
      importance_score: 50 - i,
    }));

    supabase._registerRpc("get_facts", () => []);
    supabase._registerRpc("get_active_goals", () => goals);
    supabase._registerRpc("bump_memory_access", () => null);

    const context = await getMemoryContext(supabase);

    expect(context).toContain("Goal number 0");
    expect(context).toContain("Goal number 9");
    expect(context).not.toContain("Goal number 10");
  });

  it("bumps access for served memories", async () => {
    let bumpedIds: string[] = [];
    supabase._registerRpc("get_facts", () => [
      { id: "f1", content: "Fact 1", importance_score: 50, access_count: 0 },
    ]);
    supabase._registerRpc("get_active_goals", () => [
      { id: "g1", content: "Goal 1", deadline: null, importance_score: 50 },
    ]);
    supabase._registerRpc("bump_memory_access", (params: any) => {
      bumpedIds = params.memory_ids;
      return null;
    });

    await getMemoryContext(supabase);

    // Wait for async bump
    await new Promise((r) => setTimeout(r, 50));
    expect(bumpedIds).toContain("f1");
    expect(bumpedIds).toContain("g1");
  });
});

// ── findContradiction (S23-04) ───────────────────────────────

describe("findContradiction", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns matching fact when similar content found", async () => {
    supabase._registerFunction("search", () => [
      { id: "m1", content: "Le projet utilise PostgreSQL", type: "fact", similarity: 0.85 },
    ]);

    const result = await findContradiction(supabase, "Le projet utilise MySQL");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Le projet utilise PostgreSQL");
    expect(result!.similarity).toBe(0.85);
  });

  it("returns null when no similar fact exists", async () => {
    supabase._registerFunction("search", () => []);

    const result = await findContradiction(supabase, "Something totally new");
    expect(result).toBeNull();
  });

  it("ignores non-fact matches", async () => {
    supabase._registerFunction("search", () => [
      { id: "m1", content: "Similar goal", type: "goal", similarity: 0.9 },
    ]);

    const result = await findContradiction(supabase, "Something");
    expect(result).toBeNull();
  });

  it("only returns matches above threshold", async () => {
    supabase._registerFunction("search", () => [
      { id: "m1", content: "Low similarity", type: "fact", similarity: 0.75 },
    ]);

    const result = await findContradiction(supabase, "Something");
    expect(result).toBeNull();
  });

  it("returns null for null supabase", async () => {
    const result = await findContradiction(null, "test");
    expect(result).toBeNull();
  });

  it("returns null for empty content", async () => {
    const result = await findContradiction(supabase, "");
    expect(result).toBeNull();
  });

  it("handles search failure gracefully", async () => {
    supabase._registerFunction("search", () => {
      throw new Error("Network");
    });
    const result = await findContradiction(supabase, "test");
    expect(result).toBeNull();
  });
});

describe("detectAndLogContradiction", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns contradiction info when found", async () => {
    supabase._registerFunction("search", () => [
      { id: "m1", content: "Edouard utilise macOS", type: "fact", similarity: 0.88 },
    ]);

    const result = await detectAndLogContradiction(supabase, "Edouard utilise Linux");
    expect(result).not.toBeNull();
    expect(result!.existingContent).toBe("Edouard utilise macOS");
    expect(result!.similarity).toBe(0.88);
  });

  it("returns null when no contradiction", async () => {
    supabase._registerFunction("search", () => []);
    const result = await detectAndLogContradiction(supabase, "Something new");
    expect(result).toBeNull();
  });

  it("returns null for null supabase", async () => {
    const result = await detectAndLogContradiction(null, "test");
    expect(result).toBeNull();
  });
});
