import { describe, expect, test } from "bun:test";
import {
  formatScanResult,
  isDuplicate,
  runAllScanners,
  type ScanResult,
  scanMissingTests,
  scanStaleBacklog,
  scanStuckTasks,
  scanTodoMarkers,
} from "../../src/autonomy-scanner.ts";

// ── Mock Supabase ────────────────────────────────────────────

function mockSupabase(responses: Record<string, any> = {}) {
  const defaultResponse = { data: [], error: null };

  // Build a chainable mock that resolves to the right response
  function chainable(table: string, suffix = ""): any {
    const key = suffix ? `${table}_${suffix}` : table;
    const response = responses[key] ?? defaultResponse;
    const self: any = {
      select: () => self,
      eq: () => self,
      lt: () => self,
      neq: () => self,
      not: () => self,
      contains: () => self,
      limit: () => Promise.resolve(response),
      order: () => self,
      then: (resolve: any, reject?: any) => Promise.resolve(response).then(resolve, reject),
    };
    return self;
  }

  return {
    from: (table: string) => ({
      select: (_cols?: string) => {
        // Route dedup queries (contains → auto-generated) to separate key
        const base = chainable(table);
        return {
          ...base,
          contains: () => chainable(table, "dedup"),
        };
      },
    }),
  } as any;
}

// ── scanMissingTests ────────────────────────────────────────

describe("scanMissingTests", () => {
  test("detects modules without tests", async () => {
    const projectRoot = process.cwd();
    const results = await scanMissingTests(projectRoot);

    // Should find some modules without tests (code-review, prd, etc.)
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("missing_tests");
    expect(results[0].dedup_key).toMatch(/^missing_tests:/);
  });

  test("does not flag relay or alert-cron", async () => {
    const projectRoot = process.cwd();
    const results = await scanMissingTests(projectRoot);

    const modules = results.map((r) => r.dedup_key);
    expect(modules).not.toContain("missing_tests:relay");
    expect(modules).not.toContain("missing_tests:alert-cron");
  });

  test("returns empty for invalid path", async () => {
    const results = await scanMissingTests("/nonexistent/path");
    expect(results).toEqual([]);
  });

  test("has priority 3 for missing tests", async () => {
    const projectRoot = process.cwd();
    const results = await scanMissingTests(projectRoot);
    for (const r of results) {
      expect(r.priority).toBe(3);
    }
  });
});

// ── scanTodoMarkers ─────────────────────────────────────────

describe("scanTodoMarkers", () => {
  test("returns array of opportunities", async () => {
    const projectRoot = process.cwd();
    const results = await scanTodoMarkers(projectRoot);

    // Result should be an array (may or may not have findings)
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(r.type).toBe("todo_marker");
      expect(r.dedup_key).toMatch(/^(todo|fixme):/);
    }
  });

  test("FIXME has priority 2, TODO has priority 3", async () => {
    const projectRoot = process.cwd();
    const results = await scanTodoMarkers(projectRoot);

    for (const r of results) {
      if (r.dedup_key.startsWith("fixme:")) {
        expect(r.priority).toBe(2);
      } else {
        expect(r.priority).toBe(3);
      }
    }
  });

  test("returns empty for invalid path", async () => {
    const results = await scanTodoMarkers("/nonexistent/path");
    expect(results).toEqual([]);
  });
});

// ── scanStuckTasks ──────────────────────────────────────────

describe("scanStuckTasks", () => {
  test("detects tasks stuck > 48h", async () => {
    const oldDate = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const supabase = mockSupabase({
      tasks: {
        data: [{ id: "abc-123", title: "Stuck task", updated_at: oldDate }],
        error: null,
      },
    });

    const results = await scanStuckTasks(supabase);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("stuck_task");
    expect(results[0].dedup_key).toBe("stuck:abc-123");
    expect(results[0].priority).toBe(2);
  });

  test("returns empty when no stuck tasks", async () => {
    const supabase = mockSupabase({ tasks: { data: [], error: null } });
    const results = await scanStuckTasks(supabase);
    expect(results).toEqual([]);
  });

  test("handles supabase error gracefully", async () => {
    const supabase = mockSupabase({ tasks: { data: null, error: "fail" } });
    const results = await scanStuckTasks(supabase);
    expect(results).toEqual([]);
  });
});

// ── scanStaleBacklog ────────────────────────────────────────

describe("scanStaleBacklog", () => {
  test("triggers when >= 5 stale items", async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const staleTasks = Array.from({ length: 6 }, (_, i) => ({
      id: `task-${i}`,
      title: `Old task ${i}`,
      created_at: oldDate,
      sprint: "S20",
    }));

    const supabase = mockSupabase({
      tasks: { data: staleTasks, error: null },
    });

    const results = await scanStaleBacklog(supabase);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("stale_backlog");
    expect(results[0].priority).toBe(4);
  });

  test("does not trigger with < 5 items", async () => {
    const supabase = mockSupabase({
      tasks: { data: [{ id: "1", title: "t", created_at: "", sprint: null }], error: null },
    });

    const results = await scanStaleBacklog(supabase);
    expect(results).toEqual([]);
  });
});

// ── isDuplicate ─────────────────────────────────────────────

describe("isDuplicate", () => {
  test("returns true when task exists", async () => {
    const supabase = mockSupabase({
      tasks_dedup: { data: [{ id: "existing" }], error: null },
    });

    const result = await isDuplicate(supabase, "missing_tests:prd");
    expect(result).toBe(true);
  });

  test("returns false when no match", async () => {
    const supabase = mockSupabase({
      tasks_dedup: { data: [], error: null },
    });

    const result = await isDuplicate(supabase, "missing_tests:prd");
    expect(result).toBe(false);
  });
});

// ── formatScanResult ────────────────────────────────────────

describe("formatScanResult", () => {
  test("formats empty result", () => {
    const result: ScanResult = {
      opportunities: [],
      scannedAt: new Date().toISOString(),
      summary: "Aucune opportunite detectee. Projet en bon etat.",
    };

    const text = formatScanResult(result);
    expect(text).toContain("[Scan Autonome]");
    expect(text).toContain("Aucune opportunite");
  });

  test("formats result with opportunities", () => {
    const result: ScanResult = {
      opportunities: [
        {
          type: "missing_tests",
          title: "Ajouter des tests pour prd",
          description: "desc",
          priority: 3,
          dedup_key: "missing_tests:prd",
        },
      ],
      scannedAt: new Date().toISOString(),
      summary: "1 opportunite(s)",
    };

    const text = formatScanResult(result);
    expect(text).toContain("[P3]");
    expect(text).toContain("prd");
  });

  test("truncates after 8 items", () => {
    const opportunities = Array.from({ length: 12 }, (_, i) => ({
      type: "missing_tests" as const,
      title: `Test ${i}`,
      description: "d",
      priority: 3,
      dedup_key: `t:${i}`,
    }));

    const result: ScanResult = {
      opportunities,
      scannedAt: new Date().toISOString(),
      summary: "12 opportunite(s)",
    };

    const text = formatScanResult(result);
    expect(text).toContain("... +4 autres");
  });
});

// ── runAllScanners ──────────────────────────────────────────

describe("runAllScanners", () => {
  test("combines all scanner results", async () => {
    const supabase = mockSupabase({
      tasks: { data: [], error: null },
    });

    const result = await runAllScanners(process.cwd(), supabase);
    expect(result.scannedAt).toBeTruthy();
    expect(Array.isArray(result.opportunities)).toBe(true);
    expect(typeof result.summary).toBe("string");
  });

  test("sorts by priority", async () => {
    const supabase = mockSupabase({
      tasks: { data: [], error: null },
    });

    const result = await runAllScanners(process.cwd(), supabase);
    for (let i = 1; i < result.opportunities.length; i++) {
      expect(result.opportunities[i].priority).toBeGreaterThanOrEqual(
        result.opportunities[i - 1].priority,
      );
    }
  });
});
