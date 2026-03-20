/**
 * Dashboard /api/audit endpoint — Unit Tests
 */

import { describe, it, expect } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import { handleAudit } from "../../dashboard/server";

// Helper: parse JSON response
async function parseResponse(res: Response) {
  return { status: res.status, body: await res.json() };
}

// Sample audit rows
function makeAudit(overrides: Record<string, any> = {}) {
  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    score: 85,
    gaps: [],
    axis_scores: { structure: 90, tests: 80 },
    ...overrides,
  };
}

describe("handleAudit", () => {
  // AC-1: latest audit returned with scores and findings
  describe("AC-1 — default call returns latest audit", () => {
    it("returns the latest audit when no params", async () => {
      const older = makeAudit({ created_at: "2026-03-01T00:00:00Z", score: 70 });
      const newer = makeAudit({ created_at: "2026-03-10T00:00:00Z", score: 90 });
      const sb = createMockSupabase({ audit_results: [older, newer] });

      const res = await handleAudit(null, undefined, sb);
      const { status, body } = await parseResponse(res);

      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].score).toBe(90); // newest first
    });

    it("returns audit with scores and findings fields", async () => {
      const audit = makeAudit({
        score: 75,
        gaps: [{ type: "missing_module", item: "foo.ts", detail: "not in CLAUDE.md" }],
        axis_scores: { structure: 80, tests: 70 },
      });
      const sb = createMockSupabase({ audit_results: [audit] });

      const res = await handleAudit(null, undefined, sb);
      const { body } = await parseResponse(res);

      expect(body[0].score).toBe(75);
      expect(body[0].gaps).toHaveLength(1);
      expect(body[0].axis_scores.structure).toBe(80);
    });
  });

  // AC-2: ?limit=N returns N audits ordered by date DESC
  describe("AC-2 — limit parameter", () => {
    it("returns 5 audits when ?limit=5", async () => {
      const audits = Array.from({ length: 10 }, (_, i) =>
        makeAudit({ created_at: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`, score: 50 + i })
      );
      const sb = createMockSupabase({ audit_results: audits });

      const res = await handleAudit("5", undefined, sb);
      const { status, body } = await parseResponse(res);

      expect(status).toBe(200);
      expect(body).toHaveLength(5);
    });

    it("returns audits ordered by date descending", async () => {
      const a1 = makeAudit({ created_at: "2026-03-01T00:00:00Z", score: 60 });
      const a2 = makeAudit({ created_at: "2026-03-05T00:00:00Z", score: 70 });
      const a3 = makeAudit({ created_at: "2026-03-10T00:00:00Z", score: 80 });
      const sb = createMockSupabase({ audit_results: [a1, a2, a3] });

      const res = await handleAudit("3", undefined, sb);
      const { body } = await parseResponse(res);

      expect(body[0].score).toBe(80); // newest
      expect(body[1].score).toBe(70);
      expect(body[2].score).toBe(60); // oldest
    });

    it("clamps limit to max 50", async () => {
      const audits = Array.from({ length: 55 }, (_, i) =>
        makeAudit({ created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(i).padStart(2, "0")}:00:00Z` })
      );
      const sb = createMockSupabase({ audit_results: audits });

      const res = await handleAudit("100", undefined, sb);
      const { body } = await parseResponse(res);

      expect(body.length).toBeLessThanOrEqual(50);
    });

    it("clamps limit to min 1", async () => {
      const audit = makeAudit();
      const sb = createMockSupabase({ audit_results: [audit] });

      const res = await handleAudit("0", undefined, sb);
      const { body } = await parseResponse(res);

      expect(body).toHaveLength(1);
    });

    it("defaults to 1 for non-numeric limit", async () => {
      const audits = [makeAudit(), makeAudit()];
      const sb = createMockSupabase({ audit_results: audits });

      const res = await handleAudit("abc", undefined, sb);
      const { body } = await parseResponse(res);

      expect(body).toHaveLength(1);
    });
  });

  // AC-3: empty results
  describe("AC-3 — no audit in database", () => {
    it("returns empty array with 200 when no audits", async () => {
      const sb = createMockSupabase({ audit_results: [] });

      const res = await handleAudit(null, undefined, sb);
      const { status, body } = await parseResponse(res);

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });

    it("returns empty array when supabase not configured", async () => {
      const res = await handleAudit(null, undefined, null as any);
      const { status, body } = await parseResponse(res);

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  // Axis filtering
  describe("axis filtering", () => {
    it("filters by axis when ?axis=structure", async () => {
      const withStructure = makeAudit({ axis_scores: { structure: 90, tests: 80 } });
      const withoutStructure = makeAudit({ axis_scores: { tests: 70 } });
      const sb = createMockSupabase({ audit_results: [withStructure, withoutStructure] });

      const res = await handleAudit("10", "structure", sb);
      const { body } = await parseResponse(res);

      expect(body).toHaveLength(1);
      expect(body[0].axis_scores.structure).toBe(90);
    });

    it("returns empty when no audits match axis", async () => {
      const audit = makeAudit({ axis_scores: { tests: 80 } });
      const sb = createMockSupabase({ audit_results: [audit] });

      const res = await handleAudit("10", "nonexistent", sb);
      const { body } = await parseResponse(res);

      expect(body).toEqual([]);
    });

    it("skips rows with null axis_scores", async () => {
      const withScores = makeAudit({ axis_scores: { structure: 90 } });
      const noScores = makeAudit({ axis_scores: null });
      const sb = createMockSupabase({ audit_results: [withScores, noScores] });

      const res = await handleAudit("10", "structure", sb);
      const { body } = await parseResponse(res);

      expect(body).toHaveLength(1);
    });
  });

  // Content-Type header
  it("returns application/json Content-Type", async () => {
    const sb = createMockSupabase({ audit_results: [] });
    const res = await handleAudit(null, undefined, sb);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});
