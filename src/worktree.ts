/**
 * Worktree Manager — S25 T3
 *
 * Git worktree lifecycle for parallel Dev agents.
 * Each parallel agent gets its own worktree with a unique branch.
 */

import { spawnSync } from "child_process";

const WORKTREE_BASE = process.env.WORKTREE_BASE || "/tmp/claude-worktrees";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

export interface WorktreeInfo {
  path: string;
  branch: string;
  taskId: string;
  subtaskIndex: number;
  createdAt: number;
}

export interface MergeResult {
  merged: string[];
  conflicts: string[];
  success: boolean;
}

/**
 * Create a git worktree for a parallel agent.
 * Branch: feature/{taskId}-sub-{n}-{timestamp}
 * Path: /tmp/claude-worktrees/{taskId}-sub-{n}-{timestamp}
 */
export async function createWorktree(
  taskId: string,
  subtaskIndex: number,
  baseBranch?: string
): Promise<WorktreeInfo> {
  const ts = Date.now();
  const safeName = taskId.substring(0, 8).replace(/[^a-zA-Z0-9-]/g, "");
  const branch = `feature/${safeName}-sub-${subtaskIndex}-${ts}`;
  const path = `${WORKTREE_BASE}/${safeName}-sub-${subtaskIndex}-${ts}`;

  // Ensure base dir exists
  const mkdirResult = spawnSync("mkdir", ["-p", WORKTREE_BASE], { encoding: "utf-8" });
  if (mkdirResult.status !== 0) {
    throw new Error(`Failed to create worktree base: ${mkdirResult.stderr}`);
  }

  // Create worktree
  const args = ["worktree", "add", "-b", branch, path];
  if (baseBranch) args.push(baseBranch);

  const result = spawnSync("git", args, {
    cwd: PROJECT_DIR,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr || "";
    // EC-003: disk full fallback
    if (stderr.includes("No space") || stderr.includes("ENOSPC") || stderr.includes("cannot create")) {
      throw new Error(`DISK_FULL: ${stderr}`);
    }
    throw new Error(`Failed to create worktree: ${stderr}`);
  }

  return {
    path,
    branch,
    taskId,
    subtaskIndex,
    createdAt: ts,
  };
}

/**
 * Push a worktree branch to origin.
 */
export async function pushWorktree(info: WorktreeInfo): Promise<boolean> {
  const result = spawnSync("git", ["push", "-u", "origin", info.branch], {
    cwd: info.path,
    encoding: "utf-8",
  });
  return result.status === 0;
}

/**
 * Merge multiple worktree branches into a target branch.
 * Returns merged and conflicting branches.
 */
export async function mergeWorktrees(
  worktrees: WorktreeInfo[],
  targetBranch: string
): Promise<MergeResult> {
  const merged: string[] = [];
  const conflicts: string[] = [];

  for (const wt of worktrees) {
    const result = spawnSync("git", ["merge", "--no-ff", wt.branch, "-m", `Merge ${wt.branch}`], {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
    });

    if (result.status === 0) {
      merged.push(wt.branch);
    } else {
      // Abort failed merge
      spawnSync("git", ["merge", "--abort"], { cwd: PROJECT_DIR, encoding: "utf-8" });
      conflicts.push(wt.branch);
    }
  }

  return {
    merged,
    conflicts,
    success: conflicts.length === 0,
  };
}

/**
 * Cleanup a single worktree.
 */
export async function cleanupWorktree(info: WorktreeInfo): Promise<void> {
  // Remove worktree
  spawnSync("git", ["worktree", "remove", "--force", info.path], {
    cwd: PROJECT_DIR,
    encoding: "utf-8",
  });

  // Delete branch (local only)
  spawnSync("git", ["branch", "-D", info.branch], {
    cwd: PROJECT_DIR,
    encoding: "utf-8",
  });
}

/**
 * Cleanup all stale worktrees in the base directory.
 */
export async function cleanupAllWorktrees(): Promise<number> {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: PROJECT_DIR,
    encoding: "utf-8",
  });

  if (result.status !== 0) return 0;

  let cleaned = 0;
  const lines = result.stdout.split("\n");
  for (const line of lines) {
    if (line.startsWith("worktree ") && line.includes(WORKTREE_BASE)) {
      const path = line.replace("worktree ", "").trim();
      spawnSync("git", ["worktree", "remove", "--force", path], {
        cwd: PROJECT_DIR,
        encoding: "utf-8",
      });
      cleaned++;
    }
  }

  // Prune stale entries
  spawnSync("git", ["worktree", "prune"], { cwd: PROJECT_DIR, encoding: "utf-8" });

  return cleaned;
}

/**
 * Check if files overlap between worktree subtasks (EC-001 pre-check).
 */
export function detectFileOverlap(
  subtaskFiles: string[][]
): { overlapping: boolean; conflicts: string[] } {
  const seen = new Map<string, number>();
  const conflicts: string[] = [];

  for (let i = 0; i < subtaskFiles.length; i++) {
    for (const file of subtaskFiles[i]) {
      if (seen.has(file)) {
        conflicts.push(file);
      } else {
        seen.set(file, i);
      }
    }
  }

  return {
    overlapping: conflicts.length > 0,
    conflicts: [...new Set(conflicts)],
  };
}
