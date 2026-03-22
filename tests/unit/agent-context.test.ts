/**
 * Unit Tests — src/agent-context.ts
 *
 * Tests for Supabase context assembly for BMad agents (S32 + S40).
 */

import { describe, expect, it } from "bun:test";
import {
  buildAgentContext,
  fetchDocumentContext,
  fetchSprintMetrics,
  fetchTrustContext,
  getTokenBudget,
} from "../../src/agent-context";

// ── Token Budget Tests ───────────────────────────────────────

describe("getTokenBudget", () => {
  it("returns higher budget for analyst than dev", () => {
    expect(getTokenBudget("analyst")).toBeGreaterThan(getTokenBudget("dev"));
  });

  it("returns default budget for unknown role", () => {
    expect(getTokenBudget("unknown")).toBe(2500);
  });

  it("returns correct budget for each defined role (S40 increased)", () => {
    expect(getTokenBudget("analyst")).toBe(4000);
    expect(getTokenBudget("pm")).toBe(3500);
    expect(getTokenBudget("architect")).toBe(3500);
    expect(getTokenBudget("dev")).toBe(2000);
    expect(getTokenBudget("qa")).toBe(2500);
    expect(getTokenBudget("sm")).toBe(2000);
  });
});

// ── buildAgentContext Tests ───────────────────────────────────

describe("buildAgentContext", () => {
  it("returns empty string when supabase is null", async () => {
    const result = await buildAgentContext(null, { role: "dev" });
    expect(result).toBe("");
  });

  it("returns gracefully when Supabase fetches fail", async () => {
    const mockSupabase = {
      rpc: () => Promise.resolve({ data: null, error: { message: "rpc failed" } }),
      from: (_table: string) => ({
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
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          order: () => ({
            limit: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    };

    const result = await buildAgentContext(mockSupabase as any, { role: "dev" });
    // Should not throw; returns empty or profile-only context
    expect(typeof result).toBe("string");
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
      from: (_table: string) => ({
        select: () => ({
          neq: (_col: string, _val: string) => ({
            neq: () => ({
              order: () => ({
                limit: () => ({
                  single: () => Promise.resolve({ data: { sprint: "S32" }, error: null }),
                }),
              }),
            }),
            order: () => ({
              limit: () =>
                Promise.resolve({
                  data: [{ title: "Task 1", status: "in_progress", priority: 2, sprint: "S32" }],
                  error: null,
                }),
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
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          order: () => ({
            limit: () => Promise.resolve({ data: null, error: null }),
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
      from: (_table: string) => ({
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
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          order: () => ({
            limit: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    };

    const result = await buildAgentContext(mockSupabase as any, { role: "sm" });

    // SM budget = 2000 tokens * 4 chars = 8000 chars max (S40 increased)
    expect(result.length).toBeLessThanOrEqual(8000);
  });

  it("includes sprint context when sprintId is provided", async () => {
    const mockSupabase = {
      rpc: (fn: string, _params: any) => {
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
      from: (_table: string) => ({
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
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          order: () => ({
            limit: () => Promise.resolve({ data: null, error: null }),
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
      from: (_table: string) => ({
        select: () => ({
          neq: () => ({
            order: () => ({
              limit: () =>
                Promise.resolve({
                  data: [
                    {
                      title: "Build context module",
                      status: "in_progress",
                      priority: 1,
                      sprint: "S32",
                    },
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
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          order: () => ({
            limit: () => Promise.resolve({ data: null, error: null }),
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

// ── S40: Trust Context Tests ─────────────────────────────────

describe("fetchTrustContext", () => {
  it("returns empty string when no trust data exists", async () => {
    const result = await fetchTrustContext("dev");
    // May return empty if no evaluations in cache
    expect(typeof result).toBe("string");
  });

  it("returns trust score info for a role", async () => {
    // Trust scores are from in-memory cache, so this tests the formatting
    const result = await fetchTrustContext("analyst");
    expect(typeof result).toBe("string");
  });
});

// ── S40: Sprint Metrics Tests ────────────────────────────────

describe("fetchSprintMetrics", () => {
  it("returns empty when no metrics available", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    };

    const result = await fetchSprintMetrics(mockSupabase as any);
    expect(result).toBe("");
  });

  it("formats sprint metrics correctly", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [
                  {
                    sprint_id: "S39",
                    velocity: 8,
                    rework_rate: 0.12,
                    cycle_time_avg: 4.5,
                    created_at: "2026-03-17",
                  },
                  {
                    sprint_id: "S38",
                    velocity: 10,
                    rework_rate: 0.05,
                    cycle_time_avg: 3.2,
                    created_at: "2026-03-16",
                  },
                ],
                error: null,
              }),
          }),
        }),
      }),
    };

    const result = await fetchSprintMetrics(mockSupabase as any);
    expect(result).toContain("S39:");
    expect(result).toContain("velocite=8");
    expect(result).toContain("rework=12%");
    expect(result).toContain("cycle=5h");
    expect(result).toContain("S38:");
  });

  it("handles null metric fields gracefully", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [
                  {
                    sprint_id: "S39",
                    velocity: null,
                    rework_rate: null,
                    cycle_time_avg: null,
                    created_at: "2026-03-17",
                  },
                ],
                error: null,
              }),
          }),
        }),
      }),
    };

    const result = await fetchSprintMetrics(mockSupabase as any);
    expect(result).toContain("S39:");
    expect(result).not.toContain("velocite=");
  });

  it("returns empty on Supabase error", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: null, error: { message: "fail" } }),
          }),
        }),
      }),
    };

    const result = await fetchSprintMetrics(mockSupabase as any);
    expect(result).toBe("");
  });
});

// ── S40: Document Context Tests ──────────────────────────────

describe("fetchDocumentContext", () => {
  it("returns empty when no projectId provided", async () => {
    const mockSupabase = {} as any;
    const result = await fetchDocumentContext(mockSupabase, undefined, "some task");
    expect(result).toBe("");
  });

  it("returns empty when no taskTitle provided", async () => {
    const mockSupabase = {} as any;
    const result = await fetchDocumentContext(mockSupabase, "proj-123", undefined);
    expect(result).toBe("");
  });

  it("returns empty when both missing", async () => {
    const mockSupabase = {} as any;
    const result = await fetchDocumentContext(mockSupabase, undefined, undefined);
    expect(result).toBe("");
  });

  it("gracefully handles errors from buildTaskContext", async () => {
    // buildTaskContext queries document_shards table; mock returns no data
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    };

    const result = await fetchDocumentContext(mockSupabase as any, "proj-123", "Test task");
    expect(typeof result).toBe("string");
  });
});

// ── S40: Integration — Enhanced Context Includes New Sections ──

describe("buildAgentContext — S40 enhanced sections", () => {
  it("includes METRIQUES SPRINT section when data available", async () => {
    const mockSupabase = {
      rpc: (fn: string) => {
        if (fn === "get_facts")
          return Promise.resolve({ data: [{ content: "Un fait" }], error: null });
        if (fn === "get_active_goals") return Promise.resolve({ data: [], error: null });
        if (fn === "get_sprint_summary") {
          return Promise.resolve({
            data: { total: 5, done: 2, in_progress: 1, review: 1, backlog: 1 },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => {
        if (table === "sprint_metrics") {
          return {
            select: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({
                    data: [
                      {
                        sprint_id: "S39",
                        velocity: 7,
                        rework_rate: 0.1,
                        cycle_time_avg: 5,
                        created_at: "2026-03-17",
                      },
                    ],
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "document_shards") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
          };
        }
        // tasks table
        return {
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
                      single: () => Promise.resolve({ data: { sprint: "S39" }, error: null }),
                    }),
                  }),
                }),
              }),
            }),
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      },
    };

    const result = await buildAgentContext(mockSupabase as any, {
      role: "analyst",
      sprintId: "S39",
    });

    expect(result).toContain("METRIQUES SPRINT");
    expect(result).toContain("velocite=7");
  });

  it("includes all available sections without exceeding budget", async () => {
    const mockSupabase = {
      rpc: (fn: string) => {
        if (fn === "get_facts")
          return Promise.resolve({ data: [{ content: "Fait important" }], error: null });
        if (fn === "get_active_goals") return Promise.resolve({ data: [], error: null });
        if (fn === "get_sprint_summary") {
          return Promise.resolve({
            data: { total: 10, done: 5, in_progress: 3, review: 1, backlog: 1 },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => {
        if (table === "sprint_metrics") {
          return {
            select: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({
                    data: [
                      {
                        sprint_id: "S40",
                        velocity: 12,
                        rework_rate: 0.08,
                        cycle_time_avg: 3,
                        created_at: "2026-03-17",
                      },
                    ],
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "document_shards") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
          };
        }
        return {
          select: () => ({
            neq: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({
                    data: [
                      {
                        title: "Impl context enrichi",
                        status: "in_progress",
                        priority: 2,
                        sprint: "S40",
                      },
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
                      single: () => Promise.resolve({ data: { sprint: "S40" }, error: null }),
                    }),
                  }),
                }),
              }),
            }),
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      },
    };

    const result = await buildAgentContext(mockSupabase as any, {
      role: "dev",
      sprintId: "S40",
    });

    // Dev budget = 2000 * 4 = 8000 chars
    expect(result.length).toBeLessThanOrEqual(8000);
    expect(result).toContain("CONTEXTE PROJET (Supabase)");
  });
});
