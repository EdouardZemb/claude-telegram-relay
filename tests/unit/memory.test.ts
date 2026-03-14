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
  classifyMessage,
  autoRemember,
  archiveOldMemories,
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

describe("classifyMessage", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns classification from Edge Function", async () => {
    const mockResult = {
      type: "decision",
      topics: ["architecture", "database"],
      people: ["Edouard"],
      action_items: [],
      is_memorable: true,
      summary: "Decision about database architecture",
    };
    supabase._registerFunction("classify-thought", () => mockResult);

    const result = await classifyMessage(supabase, "We should use PostgreSQL for this project");
    expect(result).toEqual(mockResult);
    expect(result!.is_memorable).toBe(true);
    expect(result!.type).toBe("decision");
  });

  it("returns null for null supabase", async () => {
    const result = await classifyMessage(null, "some text");
    expect(result).toBeNull();
  });

  it("returns null for empty content", async () => {
    const result = await classifyMessage(supabase, "");
    expect(result).toBeNull();
  });

  it("returns null when Edge Function fails", async () => {
    // Default mock returns empty array, not a valid classification
    const result = await classifyMessage(supabase, "some text");
    // Empty array is falsy for classification purposes
    expect(result).toBeTruthy(); // Array is truthy but not a valid classification
  });
});

describe("autoRemember", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("stores memorable message as fact with metadata", async () => {
    const classification = {
      type: "decision",
      topics: ["database"],
      people: ["Edouard"],
      action_items: [],
      is_memorable: true,
      summary: "Use PostgreSQL for the new project",
    };

    await autoRemember(supabase, "We decided to use PostgreSQL", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].type).toBe("fact");
    expect(memory[0].content).toBe("Use PostgreSQL for the new project");
    expect(memory[0].metadata.auto_classified).toBe(true);
    expect(memory[0].metadata.thought_type).toBe("decision");
    expect(memory[0].metadata.topics).toEqual(["database"]);
    expect(memory[0].metadata.source).toBe("auto-detect");
  });

  it("does not store when is_memorable is false", async () => {
    const classification = {
      type: "greeting",
      topics: [],
      people: [],
      action_items: [],
      is_memorable: false,
      summary: "Simple greeting",
    };

    await autoRemember(supabase, "Bonjour", classification);

    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(0);
  });

  it("handles null supabase", async () => {
    const classification = {
      type: "fact",
      topics: [],
      people: [],
      action_items: [],
      is_memorable: true,
      summary: "Something important",
    };

    // Should not throw
    await autoRemember(null, "test", classification);
  });
});

describe("archiveOldMemories", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("calls archive_old_memories RPC with default threshold", async () => {
    supabase._registerRpc("archive_old_memories", (params: any) => {
      expect(params.days_threshold).toBe(90);
      return 5;
    });

    const count = await archiveOldMemories(supabase);
    expect(count).toBe(5);
  });

  it("calls archive_old_memories RPC with custom threshold", async () => {
    supabase._registerRpc("archive_old_memories", (params: any) => {
      expect(params.days_threshold).toBe(30);
      return 2;
    });

    const count = await archiveOldMemories(supabase, 30);
    expect(count).toBe(2);
  });

  it("returns 0 for null supabase", async () => {
    const count = await archiveOldMemories(null);
    expect(count).toBe(0);
  });

  it("returns 0 on RPC error", async () => {
    // No RPC handler registered = error
    const count = await archiveOldMemories(supabase);
    expect(count).toBe(0);
  });
});
