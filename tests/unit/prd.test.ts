/**
 * Unit Tests — src/prd.ts
 *
 * Tests for PRD management: CRUD operations, formatting, and generatePRD.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  savePRD,
  getPRD,
  getPRDs,
  updatePRDStatus,
  formatPRDList,
  formatPRDDetail,
  type PRD,
} from "../../src/prd";

// ── Fixtures ────────────────────────────────────────────────

function makePRD(overrides: Partial<PRD> = {}): PRD {
  return {
    id: "aaaabbbb-1111-2222-3333-444455556666",
    created_at: "2026-03-01T10:00:00Z",
    updated_at: "2026-03-01T10:00:00Z",
    title: "PRD Test Feature",
    summary: "A test PRD for unit tests",
    content: "# PRD: Test Feature\n\n## Objectif\nTesting.",
    project: "telegram-relay",
    status: "draft",
    version: 1,
    tags: [],
    requested_by: null,
    metadata: {},
    ...overrides,
  };
}

const PRD_DRAFT = makePRD();
const PRD_APPROVED = makePRD({
  id: "ccccdddd-5555-6666-7777-888899990000",
  title: "Approved Feature",
  summary: "Already approved",
  status: "approved",
  created_at: "2026-02-15T08:00:00Z",
  project: "telegram-relay",
});
const PRD_REJECTED = makePRD({
  id: "eeeeffff-aaaa-bbbb-cccc-ddddeeee1111",
  title: "Rejected Feature",
  summary: null,
  status: "rejected",
  created_at: "2026-02-10T12:00:00Z",
  project: "other-project",
});

// ── savePRD ─────────────────────────────────────────────────

describe("savePRD", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("inserts a PRD with default project", async () => {
    const result = await savePRD(supabase, {
      title: "New Feature",
      summary: "A new feature PRD",
      content: "# PRD content here",
    });

    expect(result).not.toBeNull();
    expect(result!.title).toBe("New Feature");
    expect(result!.summary).toBe("A new feature PRD");
    expect(result!.content).toBe("# PRD content here");
    expect(result!.project).toBe("telegram-relay");
    expect(result!.id).toBeDefined();
    expect(result!.created_at).toBeDefined();
  });

  it("inserts with custom project and tags", async () => {
    const result = await savePRD(
      supabase,
      { title: "Custom PRD", summary: "Summary", content: "Content" },
      { project: "other-project", tags: ["urgent", "backend"], requested_by: "edouard" }
    );

    expect(result).not.toBeNull();
    expect(result!.project).toBe("other-project");
    expect(result!.tags).toEqual(["urgent", "backend"]);
    expect(result!.requested_by).toBe("edouard");
  });

  it("uses defaults when opts is undefined", async () => {
    const result = await savePRD(supabase, {
      title: "No Opts",
      summary: "",
      content: "Content",
    });

    expect(result).not.toBeNull();
    expect(result!.project).toBe("telegram-relay");
    expect(result!.tags).toEqual([]);
    expect(result!.requested_by).toBeNull();
  });

  it("stores the PRD in the prds table", async () => {
    await savePRD(supabase, {
      title: "Stored PRD",
      summary: "Check store",
      content: "Content",
    });

    const rows = supabase._getTable("prds");
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("Stored PRD");
  });
});

// ── getPRD ──────────────────────────────────────────────────

describe("getPRD", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      prds: [PRD_DRAFT, PRD_APPROVED, PRD_REJECTED],
    });
  });

  it("finds a PRD by id prefix", async () => {
    const result = await getPRD(supabase, "aaaabbbb");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("PRD Test Feature");
  });

  it("finds a PRD with a shorter prefix", async () => {
    const result = await getPRD(supabase, "cccc");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Approved Feature");
  });

  it("returns null for non-matching prefix", async () => {
    const result = await getPRD(supabase, "zzzznotfound");
    expect(result).toBeNull();
  });

  it("returns null when no PRDs exist", async () => {
    const emptySupa = createMockSupabase({ prds: [] });
    const result = await getPRD(emptySupa, "anything");
    expect(result).toBeNull();
  });

  it("returns first match when prefix matches multiple", async () => {
    // Both PRD_DRAFT and PRD_APPROVED exist, only one starts with "aaaa"
    const result = await getPRD(supabase, "aaaa");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(PRD_DRAFT.id);
  });
});

// ── getPRDs ─────────────────────────────────────────────────

describe("getPRDs", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      prds: [PRD_DRAFT, PRD_APPROVED, PRD_REJECTED],
    });
  });

  it("returns all PRDs when no filters", async () => {
    const results = await getPRDs(supabase);
    expect(results.length).toBe(3);
  });

  it("filters by project", async () => {
    const results = await getPRDs(supabase, { project: "other-project" });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Rejected Feature");
  });

  it("filters by status", async () => {
    const results = await getPRDs(supabase, { status: "approved" });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Approved Feature");
  });

  it("filters by both project and status", async () => {
    const results = await getPRDs(supabase, { project: "telegram-relay", status: "draft" });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("PRD Test Feature");
  });

  it("returns empty array when no matches", async () => {
    const results = await getPRDs(supabase, { status: "superseded" });
    expect(results.length).toBe(0);
  });

  it("returns empty array with empty store", async () => {
    const emptySupa = createMockSupabase({ prds: [] });
    const results = await getPRDs(emptySupa);
    expect(results.length).toBe(0);
  });

  it("orders by created_at descending (newest first)", async () => {
    const results = await getPRDs(supabase);
    // PRD_DRAFT (2026-03-01) > PRD_APPROVED (2026-02-15) > PRD_REJECTED (2026-02-10)
    expect(results[0].title).toBe("PRD Test Feature");
    expect(results[results.length - 1].title).toBe("Rejected Feature");
  });
});

// ── updatePRDStatus ─────────────────────────────────────────

describe("updatePRDStatus", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase({
      prds: [PRD_DRAFT, PRD_APPROVED],
    });
  });

  it("approves a draft PRD", async () => {
    const result = await updatePRDStatus(supabase, PRD_DRAFT.id, "approved");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("approved");
  });

  it("rejects a draft PRD", async () => {
    const result = await updatePRDStatus(supabase, PRD_DRAFT.id, "rejected");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rejected");
  });

  it("supersedes an approved PRD", async () => {
    const result = await updatePRDStatus(supabase, PRD_APPROVED.id, "superseded");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("superseded");
  });

  it("returns null when PRD id does not exist", async () => {
    const result = await updatePRDStatus(supabase, "nonexistent-id", "approved");
    expect(result).toBeNull();
  });

  it("persists the status change in store", async () => {
    await updatePRDStatus(supabase, PRD_DRAFT.id, "approved");
    const rows = supabase._getTable("prds");
    const updated = rows.find((r: any) => r.id === PRD_DRAFT.id);
    expect(updated.status).toBe("approved");
  });
});

// ── formatPRDList ───────────────────────────────────────────

describe("formatPRDList", () => {
  it("returns empty message when no PRDs", () => {
    const result = formatPRDList([]);
    expect(result).toContain("Aucun PRD");
    expect(result).toContain("/prd");
  });

  it("formats a single PRD", () => {
    const result = formatPRDList([PRD_DRAFT]);
    expect(result).toContain("PRDs");
    expect(result).toContain("BROUILLON");
    expect(result).toContain("PRD Test Feature");
    expect(result).toContain("aaaabbbb");
    expect(result).toContain("telegram-relay");
    expect(result).toContain("v1");
  });

  it("includes summary when present", () => {
    const result = formatPRDList([PRD_DRAFT]);
    expect(result).toContain("A test PRD for unit tests");
  });

  it("skips summary when null", () => {
    const result = formatPRDList([PRD_REJECTED]);
    // Should not have an indented summary line after the title line
    const lines = result.split("\n");
    const titleIdx = lines.findIndex((l: string) => l.includes("Rejected Feature"));
    // Next line should be the date/project line, not a summary
    expect(lines[titleIdx + 1]).toMatch(/^\s+\d/); // starts with spaces then a date digit
  });

  it("uses correct status labels", () => {
    const prds = [
      makePRD({ status: "draft" }),
      makePRD({ id: "bbbb0000-0000-0000-0000-000000000001", status: "approved" }),
      makePRD({ id: "bbbb0000-0000-0000-0000-000000000002", status: "rejected" }),
      makePRD({ id: "bbbb0000-0000-0000-0000-000000000003", status: "superseded" }),
    ];
    const result = formatPRDList(prds);
    expect(result).toContain("BROUILLON");
    expect(result).toContain("APPROUVE");
    expect(result).toContain("REJETE");
    expect(result).toContain("REMPLACE");
  });

  it("formats multiple PRDs", () => {
    const result = formatPRDList([PRD_DRAFT, PRD_APPROVED, PRD_REJECTED]);
    expect(result).toContain("PRD Test Feature");
    expect(result).toContain("Approved Feature");
    expect(result).toContain("Rejected Feature");
  });

  it("shows truncated id (8 chars)", () => {
    const result = formatPRDList([PRD_DRAFT]);
    expect(result).toContain("[aaaabbbb]");
    // Should not contain the full UUID
    expect(result).not.toContain("aaaabbbb-1111");
  });

  it("formats date in French locale", () => {
    const result = formatPRDList([PRD_DRAFT]);
    // Date should be in dd/mm/yyyy or similar French format
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });
});

// ── formatPRDDetail ─────────────────────────────────────────

describe("formatPRDDetail", () => {
  it("shows title, status, project, and version", () => {
    const result = formatPRDDetail(PRD_DRAFT);
    expect(result).toContain("PRD: PRD Test Feature");
    expect(result).toContain("BROUILLON");
    expect(result).toContain("telegram-relay");
    expect(result).toContain("v1");
  });

  it("shows truncated id", () => {
    const result = formatPRDDetail(PRD_DRAFT);
    expect(result).toContain("aaaabbbb");
    expect(result).not.toContain("aaaabbbb-1111-2222");
  });

  it("includes the full content", () => {
    const result = formatPRDDetail(PRD_DRAFT);
    expect(result).toContain("# PRD: Test Feature");
    expect(result).toContain("## Objectif");
    expect(result).toContain("Testing.");
  });

  it("shows approved status label", () => {
    const result = formatPRDDetail(PRD_APPROVED);
    expect(result).toContain("APPROUVE");
  });

  it("shows rejected status label", () => {
    const result = formatPRDDetail(PRD_REJECTED);
    expect(result).toContain("REJETE");
  });

  it("shows superseded status label", () => {
    const prd = makePRD({ status: "superseded" });
    const result = formatPRDDetail(prd);
    expect(result).toContain("REMPLACE");
  });

  it("formats creation date in French locale", () => {
    const result = formatPRDDetail(PRD_DRAFT);
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("header is followed by content", () => {
    const result = formatPRDDetail(PRD_DRAFT);
    // Header lines: title, status, id, empty — then content is appended directly
    expect(result).toContain("ID: aaaabbbb");
    // Content follows after the header block
    expect(result).toContain("# PRD: Test Feature");
    expect(result).toContain("## Objectif");
    // Verify ordering: header appears before content
    const idPos = result.indexOf("ID: aaaabbbb");
    const contentPos = result.indexOf("# PRD: Test Feature");
    expect(contentPos).toBeGreaterThan(idPos);
  });
});

// ── generatePRD ─────────────────────────────────────────────

describe("generatePRD", () => {
  it("is exported as a function", async () => {
    const { generatePRD } = await import("../../src/prd");
    expect(typeof generatePRD).toBe("function");
  });
});

// ── Error handling ──────────────────────────────────────────

describe("error handling", () => {
  it("savePRD logs and returns null on supabase error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    // Create a mock that returns an error from insert
    const brokenSupabase = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: () => ({ data: null, error: { message: "insert failed" } }),
          }),
        }),
      }),
    };

    const result = await savePRD(brokenSupabase as any, {
      title: "Fail",
      summary: "",
      content: "Content",
    });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("getPRD logs and returns null on supabase error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const brokenSupabase = {
      from: () => ({
        select: () => Promise.resolve({ data: null, error: { message: "select failed" } }),
      }),
    };

    const result = await getPRD(brokenSupabase as any, "anything");
    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("getPRDs logs and returns empty array on supabase error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const brokenSupabase = {
      from: () => ({
        select: () => ({
          order: () => Promise.resolve({ data: null, error: { message: "query failed" } }),
        }),
      }),
    };

    const result = await getPRDs(brokenSupabase as any);
    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("updatePRDStatus logs and returns null on supabase error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const brokenSupabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            select: () => ({
              single: () => ({ data: null, error: { message: "update failed" } }),
            }),
          }),
        }),
      }),
    };

    const result = await updatePRDStatus(brokenSupabase as any, "some-id", "approved");
    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
