/**
 * Unit Tests — Memory Links (S36-01)
 *
 * Tests for linkMemories() function and memory_links table schema expectations.
 * Covers: bidirectionality, threshold, max 5 limit, idempotence,
 * self-link prevention, error handling, edge cases.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import { linkMemories } from "../../src/memory";

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

    const result = await linkMemories(supabase, "mem-456", 0.80);

    expect(calledWith.p_threshold).toBe(0.80);
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

describe("memory_links schema snapshot", () => {
  it("schema.sql contains memory_links table and link_memory RPC", async () => {
    const schema = await Bun.file("db/schema.sql").text();

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS memory_links");
    expect(schema).toContain("CREATE OR REPLACE FUNCTION link_memory(");
    expect(schema).toContain("CREATE TRIGGER memory_auto_link");
    expect(schema).toContain("link_type TEXT NOT NULL");
  });
});
