/**
 * Unit Tests — mcp/memory-server.ts (audit_codebase tool)
 *
 * Structural tests verifying tool definition, parameter schema,
 * description pattern (Preconditions/Suggested next), axis filtering,
 * and error handling.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const MCP_SERVER_PATH = join(import.meta.dir, "../../mcp/memory-server.ts");
const serverCode = readFileSync(MCP_SERVER_PATH, "utf-8");

describe("MCP audit_codebase tool", () => {
  // ── AC-1: tool registered, all axes returned ──────────────────

  it("registers audit_codebase tool", () => {
    expect(serverCode).toContain('"audit_codebase"');
  });

  it("fetches from audit_results table via callSupabaseRest", () => {
    expect(serverCode).toContain("audit_results?select=");
    expect(serverCode).toContain("callSupabaseRest(url)");
  });

  it("orders by created_at desc and limits to 1 row", () => {
    expect(serverCode).toContain("order=created_at.desc&limit=1");
  });

  it("returns global_score, axis_scores, findings, created_at when no axis filter", () => {
    // The full-result return block
    const auditSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 3000
    );
    expect(auditSection).toContain("score: row.global_score");
    expect(auditSection).toContain("axis_scores: row.axis_scores");
    expect(auditSection).toContain("findings: row.findings");
    expect(auditSection).toContain("created_at: row.created_at");
  });

  it("returns empty result with message when no audit data exists", () => {
    expect(serverCode).toContain("No audit results found");
    expect(serverCode).toContain("The audit engine has not run yet");
  });

  // ── AC-2: axis filtering ──────────────────────────────────────

  it("accepts optional axis parameter", () => {
    expect(serverCode).toContain('axis: z.string().optional()');
  });

  it("filters by axis when axis parameter is provided", () => {
    const auditSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 3000
    );
    expect(auditSection).toContain("if (axis)");
    expect(auditSection).toContain("row.axis_scores?.[axis]");
  });

  it("returns axis-specific score and globalScore when filtering", () => {
    const auditSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 3000
    );
    expect(auditSection).toContain("score: axisScore");
    expect(auditSection).toContain("globalScore: row.global_score");
  });

  it("filters findings by axis when axis parameter is provided", () => {
    const auditSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 3000
    );
    expect(auditSection).toContain("g.axis === axis");
  });

  // ── AC-3: description pattern ─────────────────────────────────

  it("description includes Preconditions", () => {
    const auditSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 500
    );
    expect(auditSection).toContain("Preconditions:");
  });

  it("description includes Suggested next", () => {
    const auditSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 500
    );
    expect(auditSection).toContain("Suggested next:");
  });

  it("description suggests get_alerts and analyze_backlog as next", () => {
    const auditSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 500
    );
    expect(auditSection).toContain("get_alerts");
    expect(auditSection).toContain("analyze_backlog");
  });

  // ── Error handling ────────────────────────────────────────────

  it("wraps handler in try/catch with error return", () => {
    const match = serverCode.match(
      /server\.tool\(\s*"audit_codebase"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/
    );
    expect(match).not.toBeNull();
  });

  // ── Placement ─────────────────────────────────────────────────

  it("is placed after analyze_backlog and before orchestrate_task", () => {
    const analyzeIdx = serverCode.indexOf('"analyze_backlog"');
    const auditIdx = serverCode.indexOf('"audit_codebase"');
    const orchIdx = serverCode.indexOf('"orchestrate_task"');

    expect(analyzeIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(-1);
    expect(orchIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(analyzeIdx);
    expect(auditIdx).toBeLessThan(orchIdx);
  });
});
