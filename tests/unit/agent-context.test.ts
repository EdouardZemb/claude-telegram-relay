/**
 * Unit Tests — src/agent-context.ts
 *
 * Tests for Supabase context assembly for BMad agents (S32).
 */

import { describe, it, expect, mock } from "bun:test";
import { buildAgentContext, getTokenBudget, type AgentContextOptions } from "../../src/agent-context";

// ── Token Budget Tests ───────────────────────────────────────

describe("getTokenBudget", () => {
  it("returns higher budget for analyst than dev", () => {
    expect(getTokenBudget("analyst")).toBeGreaterThan(getTokenBudget("dev"));
  });

  it("returns default budget for unknown role", () => {
    expect(getTokenBudget("unknown")).toBe(2000);
  });

  it("returns correct budget for each defined role", () => {
    expect(getTokenBudget("analyst")).toBe(3000);
    expect(getTokenBudget("pm")).toBe(2500);
    expect(getTokenBudget("architect")).toBe(2500);
    expect(getTokenBudget("dev")).toBe(1500);
    expect(getTokenBudget("qa")).toBe(2000);
    expect(getTokenBudget("sm")).toBe(1500);
  });
});

// ── buildAgentContext Tests ───────────────────────────────────

describe("buildAgentContext", () => {
  it("returns empty string when supabase is null", async () => {
    const result = await buildAgentContext(null, { role: "dev" });
    expect(result).toBe("");
  });

  it("returns context with at least profile when Supabase fetches fail", async () => {
    // Profile is loaded from filesystem, so it succeeds even when DB fails
    const mockSupabase = {
      rpc: () => Promise.resolve({ data: null, error: { message: "rpc failed" } }),
      from: () => ({
        select: () => ({
          neq: () => ({
            order: () => ({
              limit: () => ({
                single: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
          not: () => ({
            neq: () => ({
              neq: () => ({
                order: () => ({
                  limit: () => ({
                    single: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const result = await buildAgentContext(mockSupabase as any, { role: "dev" });
    // Should still contain profile data loaded from config/profile.md
    expect(result).toContain("PROFIL UTILISATEUR");
  });

  it("returns context with memory facts when available", async () => {
    const mockSupabase = {
      rpc: (fn: string) => {
        if (fn === "get_facts") {
          return Promise.resolve({
            data: [{ content: "Le projet utilise Bun" }, { content: "Supabase pour la DB" }],
            error: null,
          });
        }
        if (fn === "get_active_goals") {
          return Promise.resolve({
            data: [{ content: "Livrer S32", deadline: null }],
            error: null,
          });
        }
        if (fn === "get_sprint_summary") {
          return Promise.resolve({
            data: { total: 5, done: 2, in_progress: 1, review: 1, backlog: 1 },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: () => ({
        select: () => ({
          neq: (col: string, val: string) => ({
            neq: () => ({
              order: () => ({
                limit: () => ({
                  single: () => Promise.resolve({ data: { sprint: "S32" }, error: null }),
                }),
              }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [{ title: "Task 1", status: "in_progress", priority: 2, sprint: "S32" }], error: null }),
            }),
          }),
          not: () => ({
            neq: () => ({
              neq: () => ({
                order: () => ({
                  limit: () => ({
                    single: () => Promise.resolve({ data: { sprint: "S32" }, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const result = await buildAgentContext(mockSupabase as any, { role: "analyst" });

    expect(result).toContain("CONTEXTE PROJET (Supabase)");
    expect(result).toContain("Le projet utilise Bun");
    expect(result).toContain("Livrer S32");
  });

  it("respects token budget - does not exceed char limit", async () => {
    const longFacts = Array.from({ length: 50 }, (_, i) => ({
      content: `Fait numero ${i}: ${" Lorem ipsum dolor sit amet, consectetur adipiscing elit.".repeat(5)}`,
    }));

    const mockSupabase = {
      rpc: (fn: string) => {
        if (fn === "get_facts") return Promise.resolve({ data: longFacts, error: null });
        if (fn === "get_active_goals") return Promise.resolve({ data: [], error: null });
        if (fn === "get_sprint_summary") return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      from: () => ({
        select: () => ({
          neq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
          not: () => ({
            neq: () => ({
              neq: () => ({
                order: () => ({
                  limit: () => ({
                    single: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const result = await buildAgentContext(mockSupabase as any, { role: "sm" });

    // SM budget = 1500 tokens * 4 chars = 6000 chars max
    expect(result.length).toBeLessThanOrEqual(6000);
  });

  it("includes sprint context when sprintId is provided", async () => {
    const mockSupabase = {
      rpc: (fn: string, params: any) => {
        if (fn === "get_facts") return Promise.resolve({ data: [], error: null });
        if (fn === "get_active_goals") return Promise.resolve({ data: [], error: null });
        if (fn === "get_sprint_summary") {
          return Promise.resolve({
            data: { total: 7, done: 3, in_progress: 2, review: 1, backlog: 1 },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: () => ({
        select: () => ({
          neq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
          not: () => ({
            neq: () => ({
              neq: () => ({
                order: () => ({
                  limit: () => ({
                    single: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const result = await buildAgentContext(mockSupabase as any, {
      role: "dev",
      sprintId: "S32",
    });

    expect(result).toContain("SPRINT ACTUEL");
    expect(result).toContain("S32");
    expect(result).toContain("3/7");
  });

  it("includes recent tasks in context", async () => {
    const mockSupabase = {
      rpc: (fn: string) => {
        if (fn === "get_facts") return Promise.resolve({ data: [], error: null });
        if (fn === "get_active_goals") return Promise.resolve({ data: [], error: null });
        return Promise.resolve({ data: null, error: null });
      },
      from: () => ({
        select: () => ({
          neq: () => ({
            order: () => ({
              limit: () => Promise.resolve({
                data: [
                  { title: "Build context module", status: "in_progress", priority: 1, sprint: "S32" },
                  { title: "Write tests", status: "backlog", priority: 2, sprint: "S32" },
                ],
                error: null,
              }),
            }),
          }),
          not: () => ({
            neq: () => ({
              neq: () => ({
                order: () => ({
                  limit: () => ({
                    single: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const result = await buildAgentContext(mockSupabase as any, { role: "pm" });

    expect(result).toContain("TACHES RECENTES");
    expect(result).toContain("Build context module");
    expect(result).toContain("[>]"); // in_progress icon
  });
});
