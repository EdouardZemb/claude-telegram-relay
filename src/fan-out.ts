/**
 * Fan-Out / Fan-In — S25 T6
 *
 * Handles subtask parallelism for Dev agents.
 * After PM produces subtasks, fan-out creates N Dev agents (each in its own worktree).
 * Fan-in collects results, merges branches and blackboard sections.
 */

import type { AgentRole, AgentStepResult } from "./orchestrator.ts";
import type { Task } from "./tasks.ts";
import type { StructuredAgentOutput, AgentMessage } from "./agent-schemas.ts";
import { Semaphore } from "./semaphore.ts";
import {
  createWorktree,
  cleanupWorktree,
  mergeWorktrees,
  detectFileOverlap,
  type WorktreeInfo,
} from "./worktree.ts";

// ── Types ────────────────────────────────────────────────────

export interface Subtask {
  title: string;
  description?: string;
  files?: string[];
}

export interface FanOutResult {
  results: AgentStepResult[];
  worktrees: WorktreeInfo[];
  conflicts: string[];
  sequential_fallback: boolean;
}

export type RunDevAgentFn = (
  subtask: Subtask,
  worktreePath: string | null,
  subtaskIndex: number
) => Promise<AgentStepResult>;

// ── Fan-Out ──────────────────────────────────────────────────

/**
 * Parse PM structured output to extract subtasks.
 */
export function parseSubtasks(pmOutput: StructuredAgentOutput | null): Subtask[] {
  if (!pmOutput) return [];

  const subtasks: Subtask[] = [];
  const data = pmOutput as any;

  // Look for subtasks in common structured output patterns
  const items = data.subtasks || data.items || data.tasks || [];
  if (!Array.isArray(items)) return [];

  for (const item of items) {
    if (typeof item === "string") {
      subtasks.push({ title: item });
    } else if (item.title) {
      subtasks.push({
        title: item.title,
        description: item.description,
        files: item.files || item.files_to_modify || [],
      });
    }
  }

  return subtasks;
}

/**
 * Determine if fan-out should be used.
 * Requires parallel=true and PM produced 2+ subtasks.
 */
export function shouldFanOut(
  subtasks: Subtask[],
  parallel: boolean
): boolean {
  return parallel && subtasks.length >= 2;
}

/**
 * Fan-out N dev agents, each in its own worktree.
 *
 * Pre-checks for overlapping files (EC-001).
 * Falls back to sequential if worktree creation fails (EC-003).
 */
export async function fanOut(
  subtasks: Subtask[],
  taskId: string,
  runDevAgent: RunDevAgentFn,
  options: {
    maxConcurrency?: number;
    baseBranch?: string;
    onProgress?: (msg: string) => Promise<void>;
  } = {}
): Promise<FanOutResult> {
  const semaphore = new Semaphore(options.maxConcurrency ?? 3);
  const results: AgentStepResult[] = [];
  const worktrees: WorktreeInfo[] = [];
  let sequentialFallback = false;

  // Pre-check for file overlap (EC-001)
  const fileGroups = subtasks.map((st) => st.files || []);
  const overlap = detectFileOverlap(fileGroups);
  if (overlap.overlapping) {
    options.onProgress?.(
      `Fan-out: file overlap detected (${overlap.conflicts.join(", ")}), using sequential fallback`
    );
    sequentialFallback = true;
  }

  if (sequentialFallback) {
    // Sequential execution (no worktrees)
    for (let i = 0; i < subtasks.length; i++) {
      const result = await runDevAgent(subtasks[i], null, i);
      results.push(result);
    }
    return { results, worktrees: [], conflicts: overlap.conflicts, sequential_fallback: true };
  }

  // Create worktrees and launch agents in parallel
  const promises = subtasks.map(async (subtask, i) => {
    await semaphore.acquire();
    let wt: WorktreeInfo | null = null;
    try {
      wt = await createWorktree(taskId, i, options.baseBranch);
      worktrees.push(wt);

      options.onProgress?.(`Fan-out: Dev agent ${i + 1}/${subtasks.length} — ${subtask.title}`);

      const result = await runDevAgent(subtask, wt.path, i);
      results.push(result);
      return result;
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("DISK_FULL")) {
        // EC-003: fallback to sequential for remaining
        options.onProgress?.("Fan-out: disk full, falling back to sequential");
        sequentialFallback = true;
      }
      results.push({
        agentId: "dev" as AgentRole,
        agentName: `Dev-sub-${i}`,
        success: false,
        output: "",
        structured: null,
        error: errMsg,
        durationMs: 0,
      });
    } finally {
      semaphore.release();
    }
  });

  await Promise.allSettled(promises);

  return {
    results,
    worktrees,
    conflicts: [],
    sequential_fallback: sequentialFallback,
  };
}

/**
 * Fan-in: merge worktree branches into target.
 * Cleans up all worktrees after merge.
 */
export async function fanIn(
  worktrees: WorktreeInfo[],
  targetBranch: string,
  onProgress?: (msg: string) => Promise<void>
): Promise<{ merged: string[]; conflicts: string[] }> {
  if (worktrees.length === 0) return { merged: [], conflicts: [] };

  onProgress?.(`Fan-in: merging ${worktrees.length} branches into ${targetBranch}`);

  const mergeResult = await mergeWorktrees(worktrees, targetBranch);

  // Cleanup all worktrees
  for (const wt of worktrees) {
    try {
      await cleanupWorktree(wt);
    } catch {
      // Best-effort cleanup
    }
  }

  if (mergeResult.conflicts.length > 0) {
    onProgress?.(`Fan-in: ${mergeResult.conflicts.length} conflict(s) detected`);
  } else {
    onProgress?.(`Fan-in: ${mergeResult.merged.length} branches merged successfully`);
  }

  return {
    merged: mergeResult.merged,
    conflicts: mergeResult.conflicts,
  };
}
