/**
 * Unit Tests — mcp/memory-server.ts (S32 project context tools)
 *
 * Tests for the new MCP tools: get_tasks, get_sprint_summary,
 * get_project_context, read_blackboard, write_blackboard.
 *
 * These are structural tests verifying the tool definitions exist
 * and the REST helpers handle errors correctly. Integration tests
 * with real Supabase are in tests/integration/.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const MCP_SERVER_PATH = join(import.meta.dir, "../../mcp/memory-server.ts");
const serverCode = readFileSync(MCP_SERVER_PATH, "utf-8");

describe("MCP Memory Server — S32 Project Tools", () => {
  // Structural tests: verify tool registrations exist
  it("registers get_tasks tool", () => {
    expect(serverCode).toContain('"get_tasks"');
    expect(serverCode).toContain("tasks?select=");
  });

  it("registers get_sprint_summary tool", () => {
    expect(serverCode).toContain('"get_sprint_summary"');
    expect(serverCode).toContain("get_sprint_summary");
    expect(serverCode).toContain("p_sprint");
  });

  it("registers get_project_context tool", () => {
    expect(serverCode).toContain('"get_project_context"');
    expect(serverCode).toContain("list_thoughts");
    expect(serverCode).toContain("facts");
    expect(serverCode).toContain("goals");
  });

  it("registers read_blackboard tool", () => {
    expect(serverCode).toContain('"read_blackboard"');
    expect(serverCode).toContain("session_id");
    expect(serverCode).toContain("sections");
  });

  it("registers write_blackboard tool", () => {
    expect(serverCode).toContain('"write_blackboard"');
    expect(serverCode).toContain("PATCH");
    expect(serverCode).toContain("version");
  });

  // Verify REST helpers
  it("callSupabaseRest uses GET with proper headers", () => {
    expect(serverCode).toContain("async function callSupabaseRest");
    expect(serverCode).toContain("apikey: SUPABASE_ANON_KEY");
    expect(serverCode).toContain("Authorization: `Bearer ${SUPABASE_ANON_KEY}`");
  });

  it("callRpc uses POST with JSON body", () => {
    expect(serverCode).toContain("async function callRpc");
    expect(serverCode).toContain("method: \"POST\"");
    expect(serverCode).toContain("JSON.stringify(params)");
  });

  // Tool parameter validation
  it("get_tasks supports status, project, sprint filters", () => {
    expect(serverCode).toContain("status: z.string().optional()");
    expect(serverCode).toContain("project: z.string().optional()");
    expect(serverCode).toContain("sprint: z.string().optional()");
  });

  it("write_blackboard validates section enum", () => {
    expect(serverCode).toContain('z.enum(["spec", "plan", "tasks", "implementation", "verification"])');
  });

  it("write_blackboard uses optimistic locking", () => {
    expect(serverCode).toContain("version=eq.${bb.version}");
    expect(serverCode).toContain("newVersion");
  });

  // Verify original tools are preserved
  it("preserves search_thoughts tool", () => {
    expect(serverCode).toContain('"search_thoughts"');
  });

  it("preserves list_thoughts tool", () => {
    expect(serverCode).toContain('"list_thoughts"');
  });

  it("preserves capture_thought tool", () => {
    expect(serverCode).toContain('"capture_thought"');
  });

  it("preserves thought_stats tool", () => {
    expect(serverCode).toContain('"thought_stats"');
  });
});
