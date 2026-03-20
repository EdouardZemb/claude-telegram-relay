/**
 * Unit Tests — mcp/memory-server.ts (audit_codebase MCP tool)
 *
 * Tests for the audit_codebase MCP tool: tool registration, parameter schema,
 * description metadata (Preconditions/Suggested next), response structure,
 * axis filtering, empty result handling, and error handling.
 * Structural tests verifying tool definition in the MCP server source.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const MCP_SERVER_PATH = join(import.meta.dir, "../../mcp/memory-server.ts");
const serverCode = readFileSync(MCP_SERVER_PATH, "utf-8");

describe("MCP Audit Tool — audit_codebase", () => {
  // ── AC-1: Tool registration and full audit ──────────────────

  it("registers audit_codebase tool", () => {
    expect(serverCode).toContain('"audit_codebase"');
  });

  it("queries audit_results table via callSupabaseRest", () => {
    expect(serverCode).toContain("audit_results?select=id,score,axis_scores,gaps,created_at&order=created_at.desc&limit=1");
  });

  it("returns score, axis_scores, gaps, and created_at from latest row", () => {
    const toolSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 3000
    );
    expect(toolSection).toContain("score: row.score");
    expect(toolSection).toContain("axis_scores: row.axis_scores");
    expect(toolSection).toContain("gaps: row.gaps");
    expect(toolSection).toContain("created_at: row.created_at");
  });

  it("handles empty results gracefully when no audit has been run", () => {
    expect(serverCode).toContain("No audit results found. The audit engine has not run yet.");
    expect(serverCode).toContain("rows.length === 0");
  });

  it("returns empty result object when no rows found", () => {
    expect(serverCode).toContain("score: null,");
    expect(serverCode).toContain("axis_scores: {},");
    expect(serverCode).toContain("gaps: [],");
  });

  // ── AC-2: Axis filtering ────────────────────────────────────

  it("accepts optional axis parameter", () => {
    const toolSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 800
    );
    expect(toolSection).toContain("axis: z.string().optional()");
  });

  it("filters axis_scores by axis key when axis is provided", () => {
    const toolSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 2000
    );
    expect(toolSection).toContain("axisScores[axis]");
  });

  it("filters gaps by axis match or type substring", () => {
    const toolSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 2000
    );
    expect(toolSection).toContain("g.axis === axis");
    expect(toolSection).toContain("g.type.includes(axis)");
  });

  it("returns axis-specific result with globalScore when axis is provided", () => {
    const toolSection = serverCode.slice(
      serverCode.indexOf('"audit_codebase"'),
      serverCode.indexOf('"audit_codebase"') + 2000
    );
    expect(toolSection).toContain("globalScore: row.score");
    expect(toolSection).toContain("score: axisScore");
  });

  // ── AC-3: Description pattern with Preconditions and Suggested next ──

  it("includes Preconditions in description", () => {
    expect(serverCode).toContain("Preconditions: none (reads stored audit results)");
  });

  it("includes Suggested next in description", () => {
    expect(serverCode).toContain("Suggested next: get_alerts (check anomalies), analyze_backlog (act on findings)");
  });

  it("description mentions audit engine and heartbeat", () => {
    const descStart = serverCode.indexOf('"audit_codebase"');
    const descSection = serverCode.slice(descStart, descStart + 500);
    expect(descSection).toContain("audit engine runs periodically via heartbeat");
  });

  // ── Error handling and placement ────────────────────────────

  it("wraps handler in try/catch with standard error format", () => {
    const toolStart = serverCode.indexOf('"audit_codebase"');
    const toolSection = serverCode.slice(toolStart, toolStart + 2500);
    expect(toolSection).toContain("try {");
    expect(toolSection).toContain("catch (error)");
    expect(toolSection).toContain("error instanceof Error ? error.message : String(error)");
  });

  it("is placed after analyze_backlog and before orchestrate_task", () => {
    const analyzePos = serverCode.indexOf('"analyze_backlog"');
    const auditPos = serverCode.indexOf('"audit_codebase"');
    const orchestratePos = serverCode.indexOf('"orchestrate_task"');
    expect(analyzePos).toBeLessThan(auditPos);
    expect(auditPos).toBeLessThan(orchestratePos);
  });
});
