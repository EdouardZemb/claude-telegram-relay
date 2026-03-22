/**
 * Unit Tests — Memory Links (S36-01 + S36-02)
 *
 * Tests for linkMemories(), getLinkedMemories(), getLinkedMemoriesBatch(),
 * enriched getMemoryContext(), and memory_links table schema.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  getLinkedMemories,
  getLinkedMemoriesBatch,
  getMemoryContext,
  linkMemories,
} from "../../src/memory";
import { createMockSupabase } from "../fixtures/mock-supabase";

describe("linkMemories", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("calls link_memory RPC with only memoryId when no optional params", async () => {
    let calledWith: any = null;
    supabase._registerRpc("link_memory", (params: any) => {
      calledWith = params;
      return 4;
    });

    const result = await linkMemories(supabase, "mem-123");

    expect(calledWith).toEqual({
      p_memory_id: "mem-123",
    });
    expect(result).toBe(4);
  });

  it("passes custom threshold to RPC", async () => {
    let calledWith: any = null;
    supabase._registerRpc("link_memory", (params: any) => {
      calledWith = params;
      return 2;
    });

    const result = await linkMemories(supabase, "mem-456", 0.8);

    expect(calledWith.p_threshold).toBe(0.8);
    expect(result).toBe(2);
  });

  it("passes custom max_links to RPC", async () => {
    let calledWith: any = null;
    supabase._registerRpc("link_memory", (params: any) => {
      calledWith = params;
      return 3;
    });

    const result = await linkMemories(supabase, "mem-789", 0.65, 3);

    expect(calledWith.p_max_links).toBe(3);
    expect(result).toBe(3);
  });

  it("returns the link count from RPC", async () => {
    supabase._registerRpc("link_memory", () => 6);

    const result = await linkMemories(supabase, "mem-100");
    expect(result).toBe(6);
  });

  it("returns 0 when RPC returns 0 (no matches above threshold)", async () => {
    supabase._registerRpc("link_memory", () => 0);

    const result = await linkMemories(supabase, "mem-200");
    expect(result).toBe(0);
  });

  it("returns 0 for null supabase", async () => {
    const result = await linkMemories(null, "mem-123");
    expect(result).toBe(0);
  });

  it("returns 0 for empty memoryId", async () => {
    supabase._registerRpc("link_memory", () => 5);

    const result = await linkMemories(supabase, "");
    expect(result).toBe(0);
  });

  it("returns 0 on RPC error", async () => {
    // No handler registered => mock returns error
    const result = await linkMemories(supabase, "mem-123");
    expect(result).toBe(0);
  });

  it("handles RPC returning null gracefully", async () => {
    supabase._registerRpc("link_memory", () => null);

    const result = await linkMemories(supabase, "mem-123");
    expect(result).toBe(0);
  });

  it("supports threshold at boundary value 0", async () => {
    let calledWith: any = null;
    supabase._registerRpc("link_memory", (params: any) => {
      calledWith = params;
      return 5;
    });

    await linkMemories(supabase, "mem-300", 0);
    expect(calledWith.p_threshold).toBe(0);
  });

  it("supports threshold at boundary value 1", async () => {
    let calledWith: any = null;
    supabase._registerRpc("link_memory", (params: any) => {
      calledWith = params;
      return 0;
    });

    await linkMemories(supabase, "mem-400", 1);
    expect(calledWith.p_threshold).toBe(1);
  });
});

describe("linkMemories behavioral tests", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("respects maxLinks=1 by passing it to RPC", async () => {
    let calledWith: any = null;
    supabase._registerRpc("link_memory", (params: any) => {
      calledWith = params;
      return 1;
    });

    const result = await linkMemories(supabase, "mem-100", 0.65, 1);

    expect(calledWith.p_max_links).toBe(1);
    expect(result).toBe(1);
  });

  it("high threshold filters more aggressively", async () => {
    let calledWith: any = null;
    supabase._registerRpc("link_memory", (params: any) => {
      calledWith = params;
      return 0; // no matches above 0.95
    });

    const result = await linkMemories(supabase, "mem-200", 0.95);

    expect(calledWith.p_threshold).toBe(0.95);
    expect(result).toBe(0);
  });

  it("returns link count reflecting bidirectional creation", async () => {
    // RPC returns 6 = 3 forward + 3 reverse links
    supabase._registerRpc("link_memory", () => 6);

    const result = await linkMemories(supabase, "mem-300");
    expect(result).toBe(6);
  });

  it("does not call RPC when memoryId is empty", async () => {
    let rpcCalled = false;
    supabase._registerRpc("link_memory", () => {
      rpcCalled = true;
      return 5;
    });

    await linkMemories(supabase, "");
    expect(rpcCalled).toBe(false);
  });

  it("handles RPC exception gracefully", async () => {
    supabase._registerRpc("link_memory", () => {
      throw new Error("database connection lost");
    });

    const result = await linkMemories(supabase, "mem-400");
    expect(result).toBe(0);
  });
});

// ── getLinkedMemories (S36-02) ─────────────────────────────────

describe("getLinkedMemories", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("calls get_linked_memories RPC with single ID", async () => {
    let calledWith: any = null;
    supabase._registerRpc("get_linked_memories", (params: any) => {
      calledWith = params;
      return [
        {
          origin_id: "mem-1",
          linked_id: "mem-2",
          linked_content: "Fact B",
          linked_type: "fact",
          similarity: 0.82,
          link_type: "extends",
        },
      ];
    });

    const result = await getLinkedMemories(supabase, "mem-1");

    expect(calledWith).toEqual({ p_memory_ids: ["mem-1"] });
    expect(result).toHaveLength(1);
    expect(result[0].linked_content).toBe("Fact B");
    expect(result[0].similarity).toBe(0.82);
    expect(result[0].link_type).toBe("extends");
  });

  it("returns empty array for null supabase", async () => {
    const result = await getLinkedMemories(null, "mem-1");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty memoryId", async () => {
    supabase._registerRpc("get_linked_memories", () => []);
    const result = await getLinkedMemories(supabase, "");
    expect(result).toEqual([]);
  });

  it("returns empty array on RPC error", async () => {
    // No handler registered = error
    const result = await getLinkedMemories(supabase, "mem-1");
    expect(result).toEqual([]);
  });

  it("returns multiple links sorted by similarity", async () => {
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "mem-1",
        linked_id: "mem-2",
        linked_content: "High sim",
        linked_type: "fact",
        similarity: 0.9,
        link_type: "extends",
      },
      {
        origin_id: "mem-1",
        linked_id: "mem-3",
        linked_content: "Mid sim",
        linked_type: "goal",
        similarity: 0.72,
        link_type: "related",
      },
      {
        origin_id: "mem-1",
        linked_id: "mem-4",
        linked_content: "Low sim",
        linked_type: "fact",
        similarity: 0.66,
        link_type: "related",
      },
    ]);

    const result = await getLinkedMemories(supabase, "mem-1");

    expect(result).toHaveLength(3);
    expect(result[0].similarity).toBe(0.9);
    expect(result[1].similarity).toBe(0.72);
    expect(result[2].similarity).toBe(0.66);
  });

  it("returns empty array when no links exist", async () => {
    supabase._registerRpc("get_linked_memories", () => []);

    const result = await getLinkedMemories(supabase, "mem-orphan");
    expect(result).toEqual([]);
  });

  it("handles RPC exception gracefully", async () => {
    supabase._registerRpc("get_linked_memories", () => {
      throw new Error("connection lost");
    });

    const result = await getLinkedMemories(supabase, "mem-1");
    expect(result).toEqual([]);
  });

  it("returns all link types from RPC", async () => {
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "m1",
        linked_id: "m2",
        linked_content: "A",
        linked_type: "fact",
        similarity: 0.8,
        link_type: "extends",
      },
      {
        origin_id: "m1",
        linked_id: "m3",
        linked_content: "B",
        linked_type: "goal",
        similarity: 0.7,
        link_type: "related",
      },
    ]);

    const result = await getLinkedMemories(supabase, "m1");
    expect(result.map((l) => l.link_type)).toEqual(["extends", "related"]);
  });
});

// ── getLinkedMemoriesBatch (S36-02) ────────────────────────────

describe("getLinkedMemoriesBatch", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns grouped results by origin_id", async () => {
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "f1",
        linked_id: "f2",
        linked_content: "Linked to F1",
        linked_type: "fact",
        similarity: 0.85,
        link_type: "extends",
      },
      {
        origin_id: "f1",
        linked_id: "f3",
        linked_content: "Also linked to F1",
        linked_type: "fact",
        similarity: 0.7,
        link_type: "related",
      },
      {
        origin_id: "g1",
        linked_id: "f4",
        linked_content: "Linked to G1",
        linked_type: "fact",
        similarity: 0.75,
        link_type: "related",
      },
    ]);

    const result = await getLinkedMemoriesBatch(supabase, ["f1", "g1"]);

    expect(result.get("f1")).toHaveLength(2);
    expect(result.get("g1")).toHaveLength(1);
    expect(result.get("f1")![0].linked_content).toBe("Linked to F1");
  });

  it("caps at 3 links per origin", async () => {
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "m1",
        linked_id: "a",
        linked_content: "A",
        linked_type: "fact",
        similarity: 0.9,
        link_type: "extends",
      },
      {
        origin_id: "m1",
        linked_id: "b",
        linked_content: "B",
        linked_type: "fact",
        similarity: 0.85,
        link_type: "extends",
      },
      {
        origin_id: "m1",
        linked_id: "c",
        linked_content: "C",
        linked_type: "fact",
        similarity: 0.8,
        link_type: "extends",
      },
      {
        origin_id: "m1",
        linked_id: "d",
        linked_content: "D",
        linked_type: "fact",
        similarity: 0.75,
        link_type: "related",
      },
      {
        origin_id: "m1",
        linked_id: "e",
        linked_content: "E",
        linked_type: "fact",
        similarity: 0.7,
        link_type: "related",
      },
    ]);

    const result = await getLinkedMemoriesBatch(supabase, ["m1"]);

    expect(result.get("m1")).toHaveLength(3);
    // Should keep the first 3 (highest similarity since RPC returns sorted)
    expect(result.get("m1")!.map((l) => l.linked_content)).toEqual(["A", "B", "C"]);
  });

  it("returns empty map for null supabase", async () => {
    const result = await getLinkedMemoriesBatch(null, ["m1"]);
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty memoryIds", async () => {
    const result = await getLinkedMemoriesBatch(supabase, []);
    expect(result.size).toBe(0);
  });

  it("returns empty map on RPC error", async () => {
    // No handler registered = error
    const result = await getLinkedMemoriesBatch(supabase, ["m1"]);
    expect(result.size).toBe(0);
  });

  it("handles RPC exception gracefully", async () => {
    supabase._registerRpc("get_linked_memories", () => {
      throw new Error("timeout");
    });

    const result = await getLinkedMemoriesBatch(supabase, ["m1"]);
    expect(result.size).toBe(0);
  });

  it("handles RPC returning null data", async () => {
    supabase._registerRpc("get_linked_memories", () => null);

    const result = await getLinkedMemoriesBatch(supabase, ["m1"]);
    expect(result.size).toBe(0);
  });

  it("passes all IDs in single RPC call", async () => {
    let calledWith: any = null;
    supabase._registerRpc("get_linked_memories", (params: any) => {
      calledWith = params;
      return [];
    });

    await getLinkedMemoriesBatch(supabase, ["a", "b", "c"]);

    expect(calledWith.p_memory_ids).toEqual(["a", "b", "c"]);
  });
});

// ── getMemoryContext with linked memories (S36-02) ─────────────

describe("getMemoryContext with links", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    supabase._registerRpc("get_facts", () => [
      { id: "f1", content: "Edouard is a developer" },
      { id: "f2", content: "Prefers French" },
    ]);
    supabase._registerRpc("get_active_goals", () => [
      { id: "g1", content: "Finish S36", deadline: null },
    ]);
    supabase._registerRpc("bump_memory_access", () => null);
  });

  it("includes linked memories in FACTS section", async () => {
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "f1",
        linked_id: "f3",
        linked_content: "Works in Paris",
        linked_type: "fact",
        similarity: 0.78,
        link_type: "extends",
      },
    ]);

    const context = await getMemoryContext(supabase);

    expect(context).toContain("FACTS:");
    expect(context).toContain("Edouard is a developer");
    expect(context).toContain("  -> extends: Works in Paris");
  });

  it("includes linked memories in GOALS section", async () => {
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "g1",
        linked_id: "f5",
        linked_content: "S36 spec ready",
        linked_type: "fact",
        similarity: 0.72,
        link_type: "related",
      },
    ]);

    const context = await getMemoryContext(supabase);

    expect(context).toContain("GOALS:");
    expect(context).toContain("Finish S36");
    expect(context).toContain("  -> related: S36 spec ready");
  });

  it("still works when no links exist", async () => {
    supabase._registerRpc("get_linked_memories", () => []);

    const context = await getMemoryContext(supabase);

    expect(context).toContain("FACTS:");
    expect(context).toContain("Edouard is a developer");
    expect(context).not.toContain("  ->");
  });

  it("still works when get_linked_memories RPC fails", async () => {
    // No handler = error, but getMemoryContext should still return facts/goals
    const context = await getMemoryContext(supabase);

    expect(context).toContain("FACTS:");
    expect(context).toContain("Edouard is a developer");
  });

  it("shows multiple links per fact", async () => {
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "f1",
        linked_id: "x1",
        linked_content: "Link A",
        linked_type: "fact",
        similarity: 0.9,
        link_type: "extends",
      },
      {
        origin_id: "f1",
        linked_id: "x2",
        linked_content: "Link B",
        linked_type: "fact",
        similarity: 0.8,
        link_type: "related",
      },
    ]);

    const context = await getMemoryContext(supabase);

    expect(context).toContain("  -> extends: Link A");
    expect(context).toContain("  -> related: Link B");
  });

  it("does not show links for facts without matching origin_id", async () => {
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "unknown-id",
        linked_id: "x1",
        linked_content: "Orphan link",
        linked_type: "fact",
        similarity: 0.85,
        link_type: "extends",
      },
    ]);

    const context = await getMemoryContext(supabase);

    expect(context).not.toContain("Orphan link");
  });
});

// ── Schema snapshot ────────────────────────────────────────────

describe("memory_links schema snapshot", () => {
  it("schema.sql contains memory_links table, RPCs and triggers", async () => {
    const schema = await Bun.file("db/schema.sql").text();

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS memory_links");
    expect(schema).toContain("CREATE OR REPLACE FUNCTION link_memory(");
    expect(schema).toContain("CREATE OR REPLACE FUNCTION get_linked_memories(");
    expect(schema).toContain("CREATE TRIGGER memory_auto_link");
    expect(schema).toContain("link_type TEXT NOT NULL");
  });
});
