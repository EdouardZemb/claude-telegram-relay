import { spawnSync } from "bun";
import { getConfig } from "./config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("github-sync");

// ============================================================
// TYPES
// ============================================================

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EntityMapEntry {
  id?: string;
  run_id: string;
  pipeline_type: "maturation" | "v3";
  entity_type: "run_issue" | "phase_issue";
  phase: string | null;
  issue_number: number;
  issue_url: string;
  project_item_id: string | null;
  created_at?: string;
}

// ============================================================
// TEST HOOKS
// ============================================================

let _ghExecHook: ((args: string[]) => GhResult) | undefined;

export function _setGhExecHookForTests(hook: ((args: string[]) => GhResult) | undefined): void {
  _ghExecHook = hook;
}

// ============================================================
// GH CLI WRAPPER
// ============================================================

function ghExec(args: string[]): GhResult {
  if (_ghExecHook) return _ghExecHook(args);

  const { githubRepo, projectDir } = getConfig();
  if (!githubRepo) {
    log.warn("GITHUB_REPO not configured, skipping gh command", { args: args.slice(0, 2) });
    return { stdout: "", stderr: "GITHUB_REPO not configured", exitCode: 1 };
  }

  const result = spawnSync(["gh", ...args], {
    cwd: projectDir || process.cwd(),
    timeout: 30_000,
  });

  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
    exitCode: result.exitCode ?? 1,
  };
}

/** Exposed for tests only — production code uses ghExec internally. */
export function _ghExecForTests(args: string[]): GhResult {
  return ghExec(args);
}

// ============================================================
// ISSUE OPERATIONS
// ============================================================

export function createIssue(
  title: string,
  body: string,
  labels: string[],
): { number: number; url: string } | null {
  const { githubRepo } = getConfig();
  const args = ["issue", "create", "--repo", githubRepo, "--title", title, "--body", body];
  for (const label of labels) {
    args.push("--label", label);
  }

  const result = ghExec(args);
  if (result.exitCode !== 0) {
    log.error("Failed to create issue", { title, stderr: result.stderr.slice(0, 300) });
    return null;
  }

  const url = result.stdout;
  const match = url.match(/\/issues\/(\d+)/);
  if (!match) {
    log.error("Could not parse issue number from gh output", { stdout: url });
    return null;
  }

  return { number: parseInt(match[1], 10), url };
}

export function commentOnIssue(issueNumber: number, body: string): boolean {
  const { githubRepo } = getConfig();
  const result = ghExec([
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    githubRepo,
    "--body",
    body,
  ]);
  if (result.exitCode !== 0) {
    log.error("Failed to comment on issue", { issueNumber, stderr: result.stderr.slice(0, 300) });
    return false;
  }
  return true;
}

export function closeIssue(issueNumber: number): boolean {
  const { githubRepo } = getConfig();
  const result = ghExec(["issue", "close", String(issueNumber), "--repo", githubRepo]);
  if (result.exitCode !== 0) {
    log.error("Failed to close issue", { issueNumber, stderr: result.stderr.slice(0, 300) });
    return false;
  }
  return true;
}
