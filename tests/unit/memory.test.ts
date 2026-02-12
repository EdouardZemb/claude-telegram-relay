/**
 * Unit Tests — src/memory.ts
 *
 * Tests for memory intent parsing (REMEMBER, GOAL, DONE),
 * context retrieval, and recent messages.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  processMemoryIntents,
  getMemoryContext,
  getRecentMessages,
} from "../../src/memory";

describe("processMemoryIntents", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("parses REMEMBER tag and saves fact", async () => {
    const input = "Hello! [REMEMBER: Edouard prefere le francais] Au revoir.";
    const result = await processMemoryIntents(supabase, input);

    expect(result).toBe("Hello!  Au revoir.");
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].type).toBe("fact");
    expect(memory[0].content).toBe("Edouard prefere le francais");
  });

  it("parses multiple REMEMBER tags", async () => {
    const input = "[REMEMBER: Fact 1] text [REMEMBER: Fact 2]";
    const result = await processMemoryIntents(supabase, input);

    expect(result).toBe("text");
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(2);
  });

  it("parses GOAL tag without deadline", async () => {
    const input = "Working on it. [GOAL: Deploy v2 to production]";
    const result = await processMemoryIntents(supabase, input);

    expect(result).toBe("Working on it.");
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].type).toBe("goal");
    expect(memory[0].content).toBe("Deploy v2 to production");
    expect(memory[0].deadline).toBeNull();
  });

  it("parses GOAL tag with deadline", async () => {
    const input = "[GOAL: Finish S12 | DEADLINE: 2026-02-20]";
    const result = await processMemoryIntents(supabase, input);

    expect(result).toBe("");
    const memory = supabase._getTable("memory");
    expect(memory[0].type).toBe("goal");
    expect(memory[0].content).toBe("Finish S12");
    expect(memory[0].deadline).toBe("2026-02-20");
  });

  it("parses DONE tag and marks goal as completed", async () => {
    // First create a goal
    supabase._store.memory = [
      { id: "g1", type: "goal", content: "Deploy v2 to production" },
    ];

    const input = "Done! [DONE: Deploy v2]";
    const result = await processMemoryIntents(supabase, input);

    expect(result).toBe("Done!");
    const memory = supabase._getTable("memory");
    expect(memory[0].type).toBe("completed_goal");
    expect(memory[0].completed_at).toBeDefined();
  });

  it("handles mixed tags", async () => {
    const input =
      "[REMEMBER: User likes tests] [GOAL: Add CI | DEADLINE: 2026-03-01] Response text.";
    const result = await processMemoryIntents(supabase, input);

    expect(result).toBe("Response text.");
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(2);
    expect(memory.some((m: any) => m.type === "fact")).toBe(true);
    expect(memory.some((m: any) => m.type === "goal")).toBe(true);
  });

  it("returns response unchanged when no tags", async () => {
    const input = "Just a normal response without any tags.";
    const result = await processMemoryIntents(supabase, input);
    expect(result).toBe(input);
  });

  it("handles null supabase gracefully", async () => {
    const input = "[REMEMBER: something] text";
    const result = await processMemoryIntents(null, input);
    expect(result).toBe(input);
  });

  it("is case insensitive for tags", async () => {
    const input = "[remember: lowercase test]";
    const result = await processMemoryIntents(supabase, input);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].content).toBe("lowercase test");
  });
});

describe("getMemoryContext", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    supabase._registerRpc("get_facts", () => [
      { content: "Edouard is a developer" },
      { content: "Prefers French" },
    ]);
    supabase._registerRpc("get_active_goals", () => [
      { content: "Finish S12", deadline: "2026-02-20T00:00:00Z" },
      { content: "Add tests", deadline: null },
    ]);
  });

  it("returns formatted facts and goals", async () => {
    const context = await getMemoryContext(supabase);
    expect(context).toContain("FACTS:");
    expect(context).toContain("Edouard is a developer");
    expect(context).toContain("GOALS:");
    expect(context).toContain("Finish S12");
    expect(context).toContain("Add tests");
  });

  it("returns empty for null supabase", async () => {
    const context = await getMemoryContext(null);
    expect(context).toBe("");
  });

  it("handles empty facts", async () => {
    supabase._registerRpc("get_facts", () => []);
    const context = await getMemoryContext(supabase);
    expect(context).not.toContain("FACTS:");
    expect(context).toContain("GOALS:");
  });

  it("handles empty goals", async () => {
    supabase._registerRpc("get_active_goals", () => []);
    const context = await getMemoryContext(supabase);
    expect(context).toContain("FACTS:");
    expect(context).not.toContain("GOALS:");
  });
});

describe("getRecentMessages", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      messages: [
        { role: "user", content: "Hello", created_at: "2026-02-12T10:00:00Z" },
        { role: "assistant", content: "Hi there", created_at: "2026-02-12T10:01:00Z" },
        { role: "user", content: "How are you?", created_at: "2026-02-12T10:02:00Z" },
      ],
    });
  });

  it("returns recent messages formatted", async () => {
    const result = await getRecentMessages(supabase, 10);
    expect(result).toContain("RECENT CONVERSATION:");
    expect(result).toContain("[user]: Hello");
    expect(result).toContain("[assistant]: Hi there");
  });

  it("returns empty for null supabase", async () => {
    const result = await getRecentMessages(null);
    expect(result).toBe("");
  });

  it("returns empty when no messages", async () => {
    const empty = createMockSupabase({ messages: [] });
    const result = await getRecentMessages(empty);
    expect(result).toBe("");
  });
});
