/**
 * @module agent-context
 * @description Builds enriched context from Supabase data for injection into SDD agent prompts.
 * Fetches memory, sprint, tasks, and agent-specific memories in parallel with timeout.
 * Format: compact text block <1500 tokens (~6000 chars) injected via --append-system-prompt.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled as _isFeatureEnabledDefault } from "./feature-flags.ts";
import { createLogger } from "./logger.ts";
import {
  getAgentMemories as _getAgentMemoriesDefault,
  type AgentMemoryRecord,
} from "./memory/agent-memory.ts";
import { getMemoryContext as _getMemoryContextDefault } from "./memory/core.ts";
import {
  getBacklog as _getBacklogDefault,
  getCurrentSprint as _getCurrentSprintDefault,
  getSprintSummary as _getSprintSummaryDefault,
  type Task,
} from "./tasks.ts";

const log = createLogger("agent-context");

// ── Constants ────────────────────────────────────────────────

/** Maximum output size in characters (~1500 tokens) */
const MAX_CONTEXT_CHARS = 6000;

/** Default timeout per fetch in milliseconds */
const DEFAULT_TIMEOUT_MS = 3000;

/** Max tasks to include in context */
const MAX_TASKS_IN_CONTEXT = 8;

/** Max agent memories to request */
const MAX_AGENT_MEMORIES = 5;

// ── Types ────────────────────────────────────────────────────

export interface AgentContextOptions {
  /** Timeout per fetch in milliseconds (default: 3000) */
  timeoutMs?: number;
}

/** Phases that need sprint data */
const PHASES_WITH_SPRINT = new Set(["spec", "implement", "review", "challenge", "doc"]);

/** Phases that need task data */
const PHASES_WITH_TASKS = new Set(["explore", "spec", "implement", "review", "challenge", "doc"]);

/** Phases that need memory data */
const PHASES_WITH_MEMORY = new Set(["explore", "spec", "review", "challenge", "doc"]);

// ── Injectable Hooks (for testing) ──────────────────────────

type MemoryContextHook = (supabase: SupabaseClient) => Promise<string>;
type CurrentSprintHook = (supabase: SupabaseClient) => Promise<string | null>;
type SprintSummaryHook = (
  supabase: SupabaseClient,
  sprint: string,
) => Promise<{ total: number; backlog: number; in_progress: number; review: number; done: number }>;
type BacklogHook = (
  supabase: SupabaseClient,
  opts?: { sprint?: string; status?: string },
) => Promise<Task[]>;
type AgentMemoriesHook = (
  supabase: SupabaseClient | null,
  role: string,
  limit?: number,
) => Promise<AgentMemoryRecord[]>;
type FeatureCheckHook = (flag: string) => boolean;

let _memoryContextHook: MemoryContextHook | undefined;
let _currentSprintHook: CurrentSprintHook | undefined;
let _sprintSummaryHook: SprintSummaryHook | undefined;
let _backlogHook: BacklogHook | undefined;
let _agentMemoriesHook: AgentMemoriesHook | undefined;
let _featureCheckHook: FeatureCheckHook | undefined;

/** @internal — for tests only */
export function setMemoryContextHook(fn: MemoryContextHook | undefined): void {
  _memoryContextHook = fn;
}

/** @internal — for tests only */
export function setCurrentSprintHook(fn: CurrentSprintHook | undefined): void {
  _currentSprintHook = fn;
}

/** @internal — for tests only */
export function setSprintSummaryHook(fn: SprintSummaryHook | undefined): void {
  _sprintSummaryHook = fn;
}

/** @internal — for tests only */
export function setBacklogHook(fn: BacklogHook | undefined): void {
  _backlogHook = fn;
}

/** @internal — for tests only */
export function setAgentMemoriesHook(fn: AgentMemoriesHook | undefined): void {
  _agentMemoriesHook = fn;
}

/** @internal — for tests only */
export function setFeatureCheckHook(fn: FeatureCheckHook | undefined): void {
  _featureCheckHook = fn;
}

// ── Internal wrappers ───────────────────────────────────────

function getMemoryContext(supabase: SupabaseClient): Promise<string> {
  if (_memoryContextHook) return _memoryContextHook(supabase);
  return _getMemoryContextDefault(supabase);
}

function getCurrentSprint(supabase: SupabaseClient): Promise<string | null> {
  if (_currentSprintHook) return _currentSprintHook(supabase);
  return _getCurrentSprintDefault(supabase);
}

function getSprintSummary(
  supabase: SupabaseClient,
  sprint: string,
): Promise<{ total: number; backlog: number; in_progress: number; review: number; done: number }> {
  if (_sprintSummaryHook) return _sprintSummaryHook(supabase, sprint);
  return _getSprintSummaryDefault(supabase, sprint);
}

function getBacklog(
  supabase: SupabaseClient,
  opts?: { sprint?: string; status?: string },
): Promise<Task[]> {
  if (_backlogHook) return _backlogHook(supabase, opts);
  return _getBacklogDefault(supabase, opts);
}

function getAgentMemories(
  supabase: SupabaseClient | null,
  role: string,
  limit?: number,
): Promise<AgentMemoryRecord[]> {
  if (_agentMemoriesHook) return _agentMemoriesHook(supabase, role, limit);
  return _getAgentMemoriesDefault(supabase, role, limit);
}

function checkFeatureEnabled(flag: string): boolean {
  if (_featureCheckHook) return _featureCheckHook(flag);
  return _isFeatureEnabledDefault(flag);
}

// ── Timeout helper ──────────────────────────────────────────

/**
 * Race a promise against a timeout. Returns fallback value on timeout.
 */
function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.catch((err) => {
      log.warn("Fetch error in agent context", { error: String(err) });
      return fallback;
    }),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ── Formatting helpers ──────────────────────────────────────

function formatMemorySection(memoryContext: string): string {
  if (!memoryContext) return "";
  // Truncate if too long (keep first 1500 chars of memory)
  const truncated =
    memoryContext.length > 1500 ? memoryContext.substring(0, 1500) + "..." : memoryContext;
  return `[MEMOIRE]\n${truncated}`;
}

function formatSprintSection(
  sprint: string | null,
  summary: {
    total: number;
    backlog: number;
    in_progress: number;
    review: number;
    done: number;
  } | null,
): string {
  if (!sprint) return "";
  const parts = [`[SPRINT] ${sprint}`];
  if (summary) {
    const pct = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
    parts.push(
      `Total: ${summary.total} | Backlog: ${summary.backlog} | En cours: ${summary.in_progress} | Review: ${summary.review} | Done: ${summary.done} (${pct}%)`,
    );
  }
  return parts.join("\n");
}

function formatTasksSection(tasks: Task[]): string {
  if (tasks.length === 0) return "";
  const lines = tasks.slice(0, MAX_TASKS_IN_CONTEXT).map((t) => {
    const status =
      t.status === "in_progress"
        ? "[>]"
        : t.status === "review"
          ? "[?]"
          : t.status === "done"
            ? "[x]"
            : "[ ]";
    const priority = `P${t.priority}`;
    return `${status} ${priority} ${t.title}`;
  });
  return `[TACHES ACTIVES]\n${lines.join("\n")}`;
}

function formatAgentMemoriesSection(memories: AgentMemoryRecord[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m.content}`);
  return `[APPRENTISSAGES AGENT]\n${lines.join("\n")}`;
}

// ── Main function ───────────────────────────────────────────

/**
 * Build enriched context from Supabase for injection into SDD agent prompts.
 *
 * Fetches in parallel: memory context, sprint info, active tasks, agent memories.
 * Each fetch has an independent timeout (default 3s) with graceful fallback.
 * Output is a compact text block capped at ~6000 chars (~1500 tokens).
 *
 * @param supabase - Supabase client (null returns "")
 * @param role - Agent role (e.g. "explorer", "spec-architect", "reviewer")
 * @param phase - SDD pipeline phase (e.g. "explore", "spec", "challenge", "implement", "review")
 * @param options - Optional configuration (timeoutMs)
 * @returns Formatted context string, or "" if disabled/unavailable
 */
export async function buildAgentContext(
  supabase: SupabaseClient | null,
  role: string,
  phase: string,
  options?: AgentContextOptions,
): Promise<string> {
  // V4: null supabase → empty
  if (!supabase) return "";

  // V9: feature flag gating
  if (!checkFeatureEnabled("agent_context_injection")) return "";

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    // Determine what to fetch based on phase (V7)
    const needsMemory = PHASES_WITH_MEMORY.has(phase);
    const needsSprint = PHASES_WITH_SPRINT.has(phase);
    const needsTasks = PHASES_WITH_TASKS.has(phase);

    // V2: Parallel fetching with independent timeouts (V3)
    const [memoryContext, sprint, tasks, agentMemories] = await Promise.all([
      needsMemory ? withTimeout(getMemoryContext(supabase), "", timeoutMs) : Promise.resolve(""),
      needsSprint
        ? withTimeout(getCurrentSprint(supabase), null, timeoutMs)
        : Promise.resolve(null),
      needsTasks
        ? withTimeout(
            getBacklog(supabase, { status: undefined }).then((all) =>
              all.filter((t) => t.status !== "done" && t.status !== "cancelled"),
            ),
            [] as Task[],
            timeoutMs,
          )
        : Promise.resolve([] as Task[]),
      withTimeout(getAgentMemories(supabase, role, MAX_AGENT_MEMORIES), [], timeoutMs),
    ]);

    // Fetch sprint summary if we have a sprint
    let sprintSummary: {
      total: number;
      backlog: number;
      in_progress: number;
      review: number;
      done: number;
    } | null = null;
    if (sprint && needsSprint) {
      sprintSummary = await withTimeout(getSprintSummary(supabase, sprint), null, timeoutMs);
    }

    // Format sections
    const sections: string[] = [];

    const memSection = formatMemorySection(memoryContext);
    if (memSection) sections.push(memSection);

    const sprintSection = formatSprintSection(sprint, sprintSummary);
    if (sprintSection) sections.push(sprintSection);

    const tasksSection = formatTasksSection(tasks);
    if (tasksSection) sections.push(tasksSection);

    const agentSection = formatAgentMemoriesSection(agentMemories);
    if (agentSection) sections.push(agentSection);

    // If no data was fetched, return empty
    if (sections.length === 0) return "";

    // Assemble with header
    let result = `--- CONTEXTE PROJET ---\n${sections.join("\n\n")}\n---`;

    // V5: Cap total size
    if (result.length > MAX_CONTEXT_CHARS) {
      result = result.substring(0, MAX_CONTEXT_CHARS - 3) + "...";
    }

    log.info("Agent context built", {
      role,
      phase,
      sections: sections.length,
      chars: result.length,
    });

    return result;
  } catch (error) {
    log.error("buildAgentContext failed", { role, phase, error: String(error) });
    return "";
  }
}
