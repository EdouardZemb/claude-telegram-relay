/**
 * Unit Tests — mcp/memory-server.ts (S44 business logic tools)
 *
 * Tests for the MCP business tools: task_create, task_update, prd_create,
 * prd_list, prd_get, prd_approve, prd_reject.
 * Structural tests verifying tool definitions, parameter schemas,
 * notification bridge, and error handling.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const MCP_SERVER_PATH = join(import.meta.dir, "../../mcp/memory-server.ts");
const serverCode = readFileSync(MCP_SERVER_PATH, "utf-8");

const NOTIF_QUEUE_PATH = join(import.meta.dir, "../../src/notification-queue.ts");
const notifCode = readFileSync(NOTIF_QUEUE_PATH, "utf-8");

describe("MCP Business Server — S44 Task Tools", () => {
  // ── AC-MCP-001: task_create ──────────────────────────────────

  it("registers task_create tool", () => {
    expect(serverCode).toContain('"task_create"');
    expect(serverCode).toContain("Create a new task in the project backlog");
  });

  it("task_create accepts title, description, priority, sprint, project, tags", () => {
    expect(serverCode).toContain('title: z.string().describe("Task title (required)")');
    expect(serverCode).toContain("description: z.string().optional()");
    expect(serverCode).toContain("priority: z.number().min(1).max(5).optional()");
    expect(serverCode).toContain("sprint: z.string().optional()");
    expect(serverCode).toContain("project: z.string().optional()");
    expect(serverCode).toContain("tags: z.array(z.string()).optional()");
  });

  it("task_create calls addTask from src/tasks.ts", () => {
    expect(serverCode).toContain("addTask(supabase, title,");
    expect(serverCode).toContain('from "../src/tasks.ts"');
  });

  it("task_create enqueues notification on success", () => {
    expect(serverCode).toContain("Tache creee:");
    expect(serverCode).toContain("enqueueMcpNotification");
  });

  it("task_create returns error message on failure (EC-000)", () => {
    expect(serverCode).toContain("Error: failed to create task in Supabase");
  });

  // ── AC-MCP-002: task_update ──────────────────────────────────

  it("registers task_update tool", () => {
    expect(serverCode).toContain('"task_update"');
    expect(serverCode).toContain("Update a task's status");
  });

  it("task_update accepts task_id and status enum", () => {
    expect(serverCode).toContain("task_id: z.string().describe(");
    expect(serverCode).toContain(
      '.enum(["backlog", "in_progress", "review", "done", "cancelled"])',
    );
    expect(serverCode).toContain('.describe("New status")');
  });

  it("task_update calls updateTaskStatus from src/tasks.ts", () => {
    expect(serverCode).toContain("updateTaskStatus(supabase, resolvedId, status)");
  });

  it("task_update supports ID prefix matching (EC-007)", () => {
    expect(serverCode).toContain("task_id.length < 36");
    expect(serverCode).toContain("t.id.startsWith(task_id)");
    expect(serverCode).toContain("no task found with ID prefix");
  });

  it("task_update enqueues notification with French status labels", () => {
    expect(serverCode).toContain("demarree");
    expect(serverCode).toContain("terminee");
    expect(serverCode).toContain("en review");
    expect(serverCode).toContain("remise au backlog");
    expect(serverCode).toContain("annulee");
  });

  it("task_update returns error on failure", () => {
    expect(serverCode).toContain("Error: failed to update task");
  });

  // ── AC-MCP-008: Notifications ────────────────────────────────

  it("defines enqueueMcpNotification helper", () => {
    expect(serverCode).toContain("async function enqueueMcpNotification");
    expect(serverCode).toContain("MCP_PENDING_FILE");
  });

  it("notification bridge writes to mcp-pending-notifications.json", () => {
    expect(serverCode).toContain("mcp-pending-notifications.json");
  });

  it("notification bridge uses atomic write (tmp + rename)", () => {
    expect(serverCode).toContain('MCP_PENDING_FILE + ".tmp"');
    expect(serverCode).toContain("fsRename(tmp, MCP_PENDING_FILE)");
  });

  it("notification bridge handles file not existing gracefully", () => {
    expect(serverCode).toContain("// File doesn't exist yet");
  });

  // ── AC-MCP-009: Supabase connectivity ────────────────────────

  it("creates Supabase client from env vars", () => {
    expect(serverCode).toContain("createClient(SUPABASE_URL, SUPABASE_ANON_KEY)");
    expect(serverCode).toContain('import { createClient } from "@supabase/supabase-js"');
  });

  // ── AC-MCP-010: Existing tools preserved ─────────────────────

  it("preserves all original memory tools", () => {
    expect(serverCode).toContain('"search_thoughts"');
    expect(serverCode).toContain('"list_thoughts"');
    expect(serverCode).toContain('"capture_thought"');
    expect(serverCode).toContain('"thought_stats"');
  });

  it("preserves all S32 project tools", () => {
    expect(serverCode).toContain('"get_tasks"');
    expect(serverCode).toContain('"get_sprint_summary"');
    expect(serverCode).toContain('"get_project_context"');
    expect(serverCode).toContain('"read_blackboard"');
    expect(serverCode).toContain('"write_blackboard"');
  });

  // S39 code graph tools removed (ARCHITECTURE-V2 Phase 4)

  // ── Error handling ───────────────────────────────────────────

  it("task_create catches exceptions and returns error text", () => {
    // The try/catch wraps the entire handler
    const createMatch = serverCode.match(
      /server\.tool\(\s*"task_create"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/,
    );
    expect(createMatch).not.toBeNull();
  });

  it("task_update catches exceptions and returns error text", () => {
    const updateMatch = serverCode.match(
      /server\.tool\(\s*"task_update"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/,
    );
    expect(updateMatch).not.toBeNull();
  });
});


describe("MCP Background Job Launcher", () => {
  it("defines launchMcpBackgroundJob function", () => {
    expect(serverCode).toContain("function launchMcpBackgroundJob(");
  });

  it("generates a short job ID via randomUUID", () => {
    expect(serverCode).toContain("randomUUID().slice(0, 8)");
  });

  it("sends notification on success with job ID", () => {
    expect(serverCode).toContain("[Job ${jobId}]");
    expect(serverCode).toContain("termine");
  });

  it("sends critical notification on failure", () => {
    expect(serverCode).toContain("echoue:");
    expect(serverCode).toContain('severity: "critical"');
  });

  it("imports randomUUID from crypto", () => {
    expect(serverCode).toContain('import { randomUUID } from "crypto"');
  });
});

describe("Notification Queue — MCP Bridge (S44)", () => {
  it("defines MCP_PENDING_FILE constant", () => {
    expect(notifCode).toContain("MCP_PENDING_FILE");
    expect(notifCode).toContain("mcp-pending-notifications.json");
  });

  it("exports consumeMcpPending function", () => {
    expect(notifCode).toContain("export async function consumeMcpPending");
  });

  it("consumeMcpPending reads from MCP_PENDING_FILE", () => {
    expect(notifCode).toContain("readFile(MCP_PENDING_FILE");
  });

  it("consumeMcpPending checks isTypeEnabled before adding to queue", () => {
    expect(notifCode).toContain("isTypeEnabled(item.type)");
  });

  it("consumeMcpPending clears pending file after consuming", () => {
    // After consuming items, writes empty array to clear the file
    expect(notifCode).toContain('writeFile(MCP_PENDING_FILE, "[]")');
  });

  it("consumeMcpPending assigns unique IDs to consumed items", () => {
    expect(notifCode).toContain("crypto.randomUUID()");
  });

  it("timer calls consumeMcpPending before flush check", () => {
    // The setInterval callback should call consumeMcpPending
    expect(notifCode).toContain("await consumeMcpPending()");
  });

  it("consumeMcpPending handles missing file gracefully", () => {
    // The catch block handles file-not-found without throwing
    const fnMatch = notifCode.match(/async function consumeMcpPending[\s\S]*?catch\s*\{/);
    expect(fnMatch).not.toBeNull();
  });
});
