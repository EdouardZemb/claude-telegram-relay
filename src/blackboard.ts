/**
 * @module blackboard
 * @description Shared structured workspace: versioned JSONB sections, optimistic locking,
 * role authorization, traceability reports, concurrent write retry.
 */

/**
 * Blackboard — S24 Gated Blackboard & SDD
 *
 * Shared structured workspace for multi-agent pipelines.
 * Each pipeline run gets a blackboard row with versioned JSONB sections.
 * Agents read/write specific sections. Optimistic locking via version number.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "./logger.ts";

const log = createLogger("blackboard");
// ── Types ────────────────────────────────────────────────────

export type SectionName =
  | "spec"
  | "plan"
  | "tasks"
  | "implementation"
  | "verification"
  | "working_memory"
  | "messages";

/** Working memory structure for transient pipeline discoveries (S36-07) */
export interface WorkingMemory {
  decisions: Array<{ agent: string; decision: string; reasoning: string }>;
  discoveries: Array<{ agent: string; fact: string; source: string }>;
  blockers: Array<{ agent: string; issue: string; status: string }>;
  context_updates: Array<{ agent: string; key: string; value: string }>;
}

export interface BlackboardSections {
  spec: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  tasks: Record<string, unknown> | null;
  implementation: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  working_memory: WorkingMemory | null;
  messages: Record<string, unknown> | null;
}

export interface BlackboardRow {
  id: string;
  created_at: string;
  updated_at: string;
  task_id: string | null;
  session_id: string;
  version: number;
  sections: BlackboardSections;
  history: Array<{ version: number; section: SectionName; timestamp: string; role: string }>;
  status: "active" | "completed" | "failed";
  pipeline_type: string | null;
  project_id: string | null;
}

/** Which roles can write to which sections */
const ROLE_WRITE_MAP: Record<string, SectionName[]> = {
  analyst: ["spec", "working_memory", "messages"],
  pm: ["tasks", "working_memory", "messages"],
  architect: ["plan", "working_memory", "messages"],
  dev: ["implementation", "working_memory", "messages"],
  qa: ["verification", "working_memory", "messages"],
  sm: ["verification", "working_memory", "messages"],
  verifier: ["verification", "working_memory", "messages"],
  evaluator: ["verification", "working_memory", "messages"],
  // system can write anywhere (used for initialization)
  system: ["spec", "plan", "tasks", "implementation", "verification", "working_memory", "messages"],
};

/**
 * Get the allowed sections for a role, including dynamic dev-sub-N roles (S25).
 */
function getAllowedSections(role: string): SectionName[] | undefined {
  if (ROLE_WRITE_MAP[role]) return ROLE_WRITE_MAP[role];
  // S25: dev-sub-N roles get same permissions as dev
  if (/^dev-sub-\d+$/.test(role)) return ROLE_WRITE_MAP.dev;
  return undefined;
}

/** Max section size in bytes before truncation */
const MAX_SECTION_SIZE = 50 * 1024; // 50KB

/** Max version before alerting */
const MAX_VERSION = 100;

// ── Core API ─────────────────────────────────────────────────

/**
 * Create a new blackboard for a pipeline run.
 * Returns the created row or null on error.
 */
export async function createBlackboard(
  supabase: SupabaseClient,
  taskId: string | null,
  sessionId: string,
  pipelineType?: string,
  projectId?: string,
): Promise<BlackboardRow | null> {
  const emptySections: BlackboardSections = {
    spec: null,
    plan: null,
    tasks: null,
    implementation: null,
    verification: null,
    working_memory: null,
    messages: null,
  };

  const { data, error } = await supabase
    .from("blackboard")
    .insert({
      task_id: taskId,
      session_id: sessionId,
      version: 1,
      sections: emptySections,
      history: [],
      status: "active",
      pipeline_type: pipelineType || null,
      project_id: projectId || null,
    })
    .select()
    .single();

  if (error) {
    log.error("createBlackboard error", { error: String(error) });
    return null;
  }

  return data as BlackboardRow;
}

/**
 * Read a single section from the blackboard.
 * Returns null if the section hasn't been written yet (EC-001).
 */
export async function readSection(
  supabase: SupabaseClient,
  sessionId: string,
  section: SectionName,
): Promise<Record<string, unknown> | WorkingMemory | null> {
  const { data, error } = await supabase
    .from("blackboard")
    .select("sections")
    .eq("session_id", sessionId)
    .single();

  if (error || !data) {
    log.error("readSection error", { error: String(error) });
    return null;
  }

  return (data.sections as BlackboardSections)?.[section] ?? null;
}

/**
 * Write data to a blackboard section with optimistic locking.
 *
 * - Checks role authorization (AC-005)
 * - Increments version atomically (AC-002)
 * - Fails on version conflict (AC-003)
 * - Truncates large data with overflow (EC-002)
 * - Alerts on version overflow (EC-007)
 */
export async function writeSection(
  supabase: SupabaseClient,
  sessionId: string,
  section: SectionName,
  data: Record<string, unknown>,
  role: string,
  expectedVersion: number,
): Promise<{ success: boolean; newVersion: number; error?: string }> {
  // Check role authorization (S25: supports dev-sub-N roles)
  const allowedSections = getAllowedSections(role);
  if (!allowedSections || !allowedSections.includes(section)) {
    return {
      success: false,
      newVersion: expectedVersion,
      error: `Role "${role}" is not authorized to write to section "${section}"`,
    };
  }

  // Handle large data (EC-002)
  let sectionData: Record<string, unknown> = data;
  let overflow: Record<string, unknown> | null = null;
  const serialized = JSON.stringify(data);
  if (serialized.length > MAX_SECTION_SIZE) {
    log.warn(
      `writeSection: data for ${section} exceeds ${MAX_SECTION_SIZE} bytes (${serialized.length}). Truncating.`,
    );
    // Keep structured fields, move full data to overflow
    overflow = data;
    sectionData = {
      _truncated: true,
      _original_size: serialized.length,
      ...Object.fromEntries(
        Object.entries(data)
          .filter(([_, v]) => typeof v !== "string" || (v as string).length < 2000)
          .slice(0, 20),
      ),
    };
  }

  const newVersion = expectedVersion + 1;

  // Version overflow check (EC-007)
  if (newVersion > MAX_VERSION) {
    log.error(
      `writeSection: version overflow for session ${sessionId} (version ${newVersion} > ${MAX_VERSION})`,
    );
    return {
      success: false,
      newVersion: expectedVersion,
      error: `Version overflow: ${newVersion} exceeds maximum ${MAX_VERSION}`,
    };
  }

  // Atomic update with optimistic locking
  // Use RPC-style approach: update WHERE version = expectedVersion
  const { data: current, error: readError } = await supabase
    .from("blackboard")
    .select("sections, history")
    .eq("session_id", sessionId)
    .eq("version", expectedVersion)
    .single();

  if (readError || !current) {
    return {
      success: false,
      newVersion: expectedVersion,
      error: `Version conflict: expected version ${expectedVersion} not found (optimistic locking)`,
    };
  }

  const currentSections = (current.sections || {}) as BlackboardSections;
  const currentHistory = (current.history || []) as Array<{
    version: number;
    section: SectionName;
    timestamp: string;
    role: string;
  }>;

  // Update the section
  const updatedSections = {
    ...currentSections,
    [section]: sectionData,
  };

  // Add overflow if needed
  if (overflow) {
    updatedSections.verification = {
      ...(updatedSections.verification || {}),
      [`${section}_overflow`]: overflow,
    };
  }

  // Add to history
  const historyEntry = {
    version: newVersion,
    section,
    timestamp: new Date().toISOString(),
    role,
  };

  const { data: updated, error: updateError } = await supabase
    .from("blackboard")
    .update({
      sections: updatedSections,
      version: newVersion,
      history: [...currentHistory, historyEntry],
    })
    .eq("session_id", sessionId)
    .eq("version", expectedVersion)
    .select("version")
    .single();

  if (updateError || !updated) {
    return {
      success: false,
      newVersion: expectedVersion,
      error: `Version conflict during update (optimistic locking)`,
    };
  }

  return { success: true, newVersion };
}

/**
 * Get the full blackboard document (AC-006).
 */
export async function getFullBlackboard(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<BlackboardRow | null> {
  const { data, error } = await supabase
    .from("blackboard")
    .select("*")
    .eq("session_id", sessionId)
    .single();

  if (error || !data) {
    log.error("getFullBlackboard error", { error: String(error) });
    return null;
  }

  return data as BlackboardRow;
}

/**
 * Update blackboard status (active -> completed/failed).
 */
export async function updateBlackboardStatus(
  supabase: SupabaseClient,
  sessionId: string,
  status: "completed" | "failed",
): Promise<boolean> {
  const { error } = await supabase
    .from("blackboard")
    .update({ status })
    .eq("session_id", sessionId);

  if (error) {
    log.error("updateBlackboardStatus error", { error: String(error) });
    return false;
  }
  return true;
}

// ── Traceability (T6 — FR-007) ──────────────────────────────

export interface TraceabilityItem {
  fr_id: string;
  tasks: string[];
  tests: string[];
  files: string[];
  status: "covered" | "partially_covered" | "missing";
}

export interface TraceabilityReport {
  covered_fr: string[];
  partially_covered_fr: string[];
  missing_fr: string[];
  coverage_percentage: number;
  items: TraceabilityItem[];
}

/**
 * Generate a traceability report from the blackboard (AC-020, AC-021, AC-022).
 * Pure mapping — no LLM calls. Crosses spec.requirements, tasks.items,
 * verification.tests, and implementation.files.
 */
export function generateTraceabilityReport(sections: BlackboardSections): TraceabilityReport {
  // Extract FR identifiers from spec
  const frIds: string[] = [];
  const spec = sections.spec;
  if (spec?.requirements && Array.isArray(spec.requirements)) {
    for (const req of spec.requirements) {
      if (req.id) frIds.push(req.id);
    }
  }
  // Fallback: extract FR-XXX patterns from spec text
  if (frIds.length === 0 && spec) {
    const specStr = typeof spec === "string" ? spec : JSON.stringify(spec);
    const matches = specStr.match(/FR-\d+/g);
    if (matches) {
      frIds.push(...[...new Set(matches)]);
    }
  }

  if (frIds.length === 0) {
    return {
      covered_fr: [],
      partially_covered_fr: [],
      missing_fr: [],
      coverage_percentage: 0,
      items: [],
    };
  }

  // Extract task->FR mappings
  const tasksByFr: Record<string, string[]> = {};
  const tasksSection = sections.tasks;
  if (tasksSection?.items && Array.isArray(tasksSection.items)) {
    for (const task of tasksSection.items) {
      const tracesTo = task.traces_to || task.tracesTo || [];
      const refs = Array.isArray(tracesTo) ? tracesTo : [tracesTo];
      for (const ref of refs) {
        if (!tasksByFr[ref]) tasksByFr[ref] = [];
        tasksByFr[ref].push(task.title || task.id || "unknown");
      }
    }
  }

  // Extract test->AC mappings
  const testsByFr: Record<string, string[]> = {};
  const verification = sections.verification;
  if (verification?.tests && Array.isArray(verification.tests)) {
    for (const test of verification.tests) {
      const validates = test.validates || [];
      const refs = Array.isArray(validates) ? validates : [validates];
      for (const ref of refs) {
        // Map AC-XXX back to FR-XXX (convention: AC-001..003 -> FR-001, etc.)
        // Also accept direct FR references
        const frRef = ref.startsWith("FR-") ? ref : null;
        if (frRef) {
          if (!testsByFr[frRef]) testsByFr[frRef] = [];
          testsByFr[frRef].push(test.name || test.description || "unknown");
        }
      }
    }
  }

  // Extract file changes
  const filesByFr: Record<string, string[]> = {};
  const impl = sections.implementation;
  if (impl?.files && Array.isArray(impl.files)) {
    for (const file of impl.files) {
      const tracesTo = file.traces_to || file.tracesTo || [];
      const refs = Array.isArray(tracesTo) ? tracesTo : [tracesTo];
      for (const ref of refs) {
        if (!filesByFr[ref]) filesByFr[ref] = [];
        filesByFr[ref].push(file.path || file.name || "unknown");
      }
    }
  }

  // Build report
  const items: TraceabilityItem[] = [];
  const covered: string[] = [];
  const partial: string[] = [];
  const missing: string[] = [];

  for (const frId of frIds) {
    const tasks = tasksByFr[frId] || [];
    const tests = testsByFr[frId] || [];
    const files = filesByFr[frId] || [];

    let status: TraceabilityItem["status"];
    if (tasks.length > 0 && (tests.length > 0 || files.length > 0)) {
      status = "covered";
      covered.push(frId);
    } else if (tasks.length > 0 || tests.length > 0 || files.length > 0) {
      status = "partially_covered";
      partial.push(frId);
    } else {
      status = "missing";
      missing.push(frId);
    }

    items.push({ fr_id: frId, tasks, tests, files, status });
  }

  const total = frIds.length;
  const coveragePercentage = total > 0 ? Math.round((covered.length / total) * 100) : 0;

  return {
    covered_fr: covered,
    partially_covered_fr: partial,
    missing_fr: missing,
    coverage_percentage: coveragePercentage,
    items,
  };
}

/**
 * Format traceability report for Telegram display.
 */
export function formatTraceabilityReport(report: TraceabilityReport): string {
  const lines: string[] = ["TRACEABILITY REPORT", `Coverage: ${report.coverage_percentage}%`, ""];

  if (report.covered_fr.length > 0) {
    lines.push(`Covered (${report.covered_fr.length}): ${report.covered_fr.join(", ")}`);
  }
  if (report.partially_covered_fr.length > 0) {
    lines.push(
      `Partial (${report.partially_covered_fr.length}): ${report.partially_covered_fr.join(", ")}`,
    );
  }
  if (report.missing_fr.length > 0) {
    lines.push(`Missing (${report.missing_fr.length}): ${report.missing_fr.join(", ")}`);
  }

  return lines.join("\n");
}

// ── In-Memory Fallback (EC-008) ──────────────────────────────

/**
 * In-memory blackboard fallback when Supabase is unavailable.
 */
export class InMemoryBlackboard {
  private sessions: Map<string, BlackboardRow> = new Map();

  create(taskId: string | null, sessionId: string, pipelineType?: string): BlackboardRow {
    const row: BlackboardRow = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      task_id: taskId,
      session_id: sessionId,
      version: 1,
      sections: {
        spec: null,
        plan: null,
        tasks: null,
        implementation: null,
        verification: null,
        working_memory: null,
        messages: null,
      },
      history: [],
      status: "active",
      pipeline_type: pipelineType || null,
      project_id: null,
    };
    this.sessions.set(sessionId, row);
    return row;
  }

  read(sessionId: string, section: SectionName): Record<string, unknown> | WorkingMemory | null {
    const row = this.sessions.get(sessionId);
    if (!row) return null;
    return row.sections[section] ?? null;
  }

  write(
    sessionId: string,
    section: SectionName,
    data: Record<string, unknown>,
    role: string,
    expectedVersion: number,
  ): { success: boolean; newVersion: number; error?: string } {
    const row = this.sessions.get(sessionId);
    if (!row) return { success: false, newVersion: expectedVersion, error: "Session not found" };

    const allowedSections = getAllowedSections(role);
    if (!allowedSections || !allowedSections.includes(section)) {
      return {
        success: false,
        newVersion: expectedVersion,
        error: `Role "${role}" not authorized`,
      };
    }

    if (row.version !== expectedVersion) {
      return { success: false, newVersion: row.version, error: "Version conflict" };
    }

    (row.sections as unknown as Record<string, unknown>)[section] = data;
    row.version = expectedVersion + 1;
    row.updated_at = new Date().toISOString();
    row.history.push({
      version: row.version,
      section,
      timestamp: row.updated_at,
      role,
    });
    return { success: true, newVersion: row.version };
  }

  get(sessionId: string): BlackboardRow | null {
    return this.sessions.get(sessionId) || null;
  }
}

// ── Concurrent Blackboard Extensions (S25 T5) ───────────────

/**
 * Write to a blackboard section with auto-retry on version conflict.
 * Re-reads the latest version on conflict and retries (max 3 by default).
 */
export async function writeSectionWithRetry(
  supabase: SupabaseClient,
  sessionId: string,
  section: SectionName,
  data: Record<string, unknown>,
  role: string,
  expectedVersion: number,
  maxRetries: number = 3,
): Promise<{ success: boolean; newVersion: number; error?: string }> {
  let currentVersion = expectedVersion;

  for (let i = 0; i <= maxRetries; i++) {
    const result = await writeSection(supabase, sessionId, section, data, role, currentVersion);
    if (result.success) return result;

    if (result.error?.includes("Version conflict") && i < maxRetries) {
      // Re-read latest version and retry
      const latest = await getFullBlackboard(supabase, sessionId);
      if (latest) {
        currentVersion = latest.version;
      }
      continue;
    }

    return result; // non-retryable error or max retries exhausted
  }

  return { success: false, newVersion: currentVersion, error: "Max retries exceeded" };
}

/**
 * Merge multiple agent implementation results into the blackboard (fan-in).
 * Concatenates arrays (files, tests, summaries) instead of overwriting.
 */
export async function mergeImplementationSection(
  supabase: SupabaseClient,
  sessionId: string,
  agentResults: Array<{ structured?: Record<string, unknown>; output?: string }>,
  expectedVersion: number,
): Promise<{ success: boolean; newVersion: number; error?: string }> {
  const existingRaw = (await readSection(supabase, sessionId, "implementation")) || {};
  const existing = existingRaw as Record<string, unknown>;

  const merged = {
    files_modified: [...(Array.isArray(existing.files_modified) ? existing.files_modified : [])],
    tests_added: [...(Array.isArray(existing.tests_added) ? existing.tests_added : [])],
    summaries: [...(Array.isArray(existing.summaries) ? existing.summaries : [])],
  };

  for (const result of agentResults) {
    const data = result.structured || {};
    const filesModified = Array.isArray(data.files_modified)
      ? data.files_modified
      : Array.isArray(data.files)
        ? data.files
        : [];
    const testsAdded = Array.isArray(data.tests_added)
      ? data.tests_added
      : Array.isArray(data.tests)
        ? data.tests
        : [];
    const summary =
      typeof data.summary === "string" ? data.summary : (result.output || "").substring(0, 1000);
    merged.files_modified.push(...filesModified);
    merged.tests_added.push(...testsAdded);
    merged.summaries.push(summary);
  }

  return writeSectionWithRetry(
    supabase,
    sessionId,
    "implementation",
    merged,
    "system",
    expectedVersion,
  );
}
