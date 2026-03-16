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

  it("calls link_memory RPC with correct default params", async () => {
    let calledWith: any = null;
    supabase._registerRpc("link_memory", (params: any) => {
      calledWith = params;
      return 4;
    });

    const result = await linkMemories(supabase, "mem-123");

    expect(calledWith).toEqual({
      p_memory_id: "mem-123",
      p_threshold: 0.65,
      p_max_links: 5,
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

describe("memory_links schema contract", () => {
  it("schema.sql defines memory_links table with required columns", async () => {
    const schemaFile = Bun.file("db/schema.sql");
    const schema = await schemaFile.text();

    // Table exists
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS memory_links");

    // Required columns
    expect(schema).toContain("source_id UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE");
    expect(schema).toContain("target_id UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE");
    expect(schema).toContain("similarity FLOAT NOT NULL");
    expect(schema).toContain("link_type TEXT NOT NULL DEFAULT 'semantic'");
    expect(schema).toContain("created_at TIMESTAMPTZ DEFAULT NOW()");

    // Constraints
    expect(schema).toContain("UNIQUE (source_id, target_id)");
    expect(schema).toContain("CHECK (source_id != target_id)");

    // Indexes
    expect(schema).toContain("idx_memory_links_source");
    expect(schema).toContain("idx_memory_links_target");
  });

  it("schema.sql defines link_memory RPC with default params", async () => {
    const schemaFile = Bun.file("db/schema.sql");
    const schema = await schemaFile.text();

    expect(schema).toContain("CREATE OR REPLACE FUNCTION link_memory(");
    expect(schema).toContain("p_memory_id UUID");
    expect(schema).toContain("p_threshold FLOAT DEFAULT 0.65");
    expect(schema).toContain("p_max_links INT DEFAULT 5");
    expect(schema).toContain("RETURNS INTEGER");
  });

  it("schema.sql defines auto_link_memory trigger on embedding update", async () => {
    const schemaFile = Bun.file("db/schema.sql");
    const schema = await schemaFile.text();

    expect(schema).toContain("CREATE OR REPLACE FUNCTION auto_link_memory()");
    expect(schema).toContain("CREATE TRIGGER memory_auto_link");
    expect(schema).toContain("AFTER UPDATE OF embedding ON memory");
    expect(schema).toContain("OLD.embedding IS NULL AND NEW.embedding IS NOT NULL");
  });

  it("schema.sql defines RLS policy for memory_links", async () => {
    const schemaFile = Bun.file("db/schema.sql");
    const schema = await schemaFile.text();

    expect(schema).toContain("ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY");
    expect(schema).toMatch(/CREATE POLICY .+ ON memory_links/);
  });

  it("link_memory RPC uses ON CONFLICT DO NOTHING for idempotence", async () => {
    const schemaFile = Bun.file("db/schema.sql");
    const schema = await schemaFile.text();

    expect(schema).toContain("ON CONFLICT (source_id, target_id) DO NOTHING");
  });

  it("link_memory RPC filters self-links (m.id != p_memory_id)", async () => {
    const schemaFile = Bun.file("db/schema.sql");
    const schema = await schemaFile.text();

    expect(schema).toContain("m.id != p_memory_id");
  });

  it("link_memory RPC checks target max before reverse insert", async () => {
    const schemaFile = Bun.file("db/schema.sql");
    const schema = await schemaFile.text();

    // The RPC should count existing links for the target before inserting reverse
    expect(schema).toContain("v_target_count < p_max_links");
  });

  it("link_memory RPC has exception handler", async () => {
    const schemaFile = Bun.file("db/schema.sql");
    const schema = await schemaFile.text();

    expect(schema).toContain("EXCEPTION WHEN OTHERS");
  });
});
