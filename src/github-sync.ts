import type { SupabaseClient } from "@supabase/supabase-js";
import { spawnSync } from "bun";
import { getConfig } from "./config.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
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
let _syncEnabledOverride: boolean | undefined;

export function _setGhExecHookForTests(hook: ((args: string[]) => GhResult) | undefined): void {
  _ghExecHook = hook;
}

export function _setSyncEnabledForTests(value: boolean | undefined): void {
  _syncEnabledOverride = value;
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

// ============================================================
// PROJECT BOARD OPERATIONS
// ============================================================

export function addToProject(issueUrl: string): string | null {
  const { githubProjectNumber } = getConfig();
  if (!githubProjectNumber) {
    log.debug("No GITHUB_PROJECT_NUMBER configured, skipping project board");
    return null;
  }

  const owner = getConfig().githubRepo.split("/")[0];
  const result = ghExec([
    "project",
    "item-add",
    String(githubProjectNumber),
    "--owner",
    owner,
    "--url",
    issueUrl,
    "--format",
    "json",
  ]);

  if (result.exitCode !== 0) {
    log.error("Failed to add issue to project", { issueUrl, stderr: result.stderr.slice(0, 300) });
    return null;
  }

  try {
    const data = JSON.parse(result.stdout);
    return data.id || result.stdout.trim();
  } catch {
    return result.stdout.trim() || null;
  }
}

// ============================================================
// ENTITY MAP CRUD (Supabase)
// ============================================================

const TABLE = "github_entity_map";

export async function saveEntity(
  supabase: SupabaseClient,
  entry: Omit<EntityMapEntry, "id" | "created_at">,
): Promise<void> {
  const { error } = await supabase.from(TABLE).upsert(entry);
  if (error) {
    log.error("Failed to save entity map entry", { run_id: entry.run_id, error: error.message });
  }
}

export async function getRunIssue(
  supabase: SupabaseClient,
  runId: string,
): Promise<EntityMapEntry | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select()
    .eq("run_id", runId)
    .eq("entity_type", "run_issue")
    .is("phase", null)
    .maybeSingle();
  if (error) {
    log.error("Failed to load run issue", { runId, error: error.message });
    return null;
  }
  return data;
}

export async function getPhaseIssue(
  supabase: SupabaseClient,
  runId: string,
  phase: string,
): Promise<EntityMapEntry | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select()
    .eq("run_id", runId)
    .eq("entity_type", "phase_issue")
    .eq("phase", phase)
    .maybeSingle();
  if (error) {
    log.error("Failed to load phase issue", { runId, phase, error: error.message });
    return null;
  }
  return data;
}

// ============================================================
// DOCUMENT OPERATIONS
// ============================================================

const MAX_COMMENT_LENGTH = 60000; // GitHub limit is 65536, leave margin

export function chunkDocument(content: string, maxLen: number = MAX_COMMENT_LENGTH): string[] {
  if (content.length <= maxLen) return [content];

  const lines = content.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    // If a single line exceeds maxLen, split it by character
    if (line.length > maxLen) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      let remaining = line;
      while (remaining.length > maxLen) {
        chunks.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
      }
      current = remaining;
      continue;
    }

    if (current.length + line.length + 1 > maxLen && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function postDocument(issueNumber: number, docType: string, content: string): boolean {
  const chunks = chunkDocument(content);
  let allOk = true;

  for (let i = 0; i < chunks.length; i++) {
    const header =
      chunks.length === 1 ? `## ${docType}\n\n` : `## ${docType} (${i + 1}/${chunks.length})\n\n`;
    const ok = commentOnIssue(issueNumber, header + chunks[i]);
    if (!ok) allOk = false;
  }

  return allOk;
}

// ============================================================
// HIGH-LEVEL SYNC API
// ============================================================

function isSyncEnabled(): boolean {
  if (_syncEnabledOverride !== undefined) return _syncEnabledOverride;
  return isFeatureEnabled("github_sync") && !!getConfig().githubRepo;
}

export async function syncRunStart(
  supabase: SupabaseClient,
  run: { id: string; name: string; rawInput: string },
  pipelineType: "maturation" | "v3",
): Promise<void> {
  if (!isSyncEnabled()) return;

  const existing = await getRunIssue(supabase, run.id);
  if (existing) {
    log.debug("Run issue already exists", { runId: run.id, issueNumber: existing.issue_number });
    return;
  }

  const title =
    pipelineType === "maturation" ? `[Maturation] ${run.name}` : `[Pipeline V3] ${run.name}`;

  const body = [
    `## ${pipelineType === "maturation" ? "Maturation" : "Pipeline V3"} Run`,
    "",
    `**Run ID:** \`${run.id.substring(0, 8)}\``,
    `**Input:** ${run.rawInput.substring(0, 500)}`,
    "",
    "### Phases",
    "_(Sub-issues will be created as phases complete)_",
  ].join("\n");

  const labels = [pipelineType, "pipeline-sync"];
  const result = createIssue(title, body, labels);
  if (!result) return;

  log.info("Created run issue", { runId: run.id, issueNumber: result.number });

  const projectItemId = addToProject(result.url);

  await saveEntity(supabase, {
    run_id: run.id,
    pipeline_type: pipelineType,
    entity_type: "run_issue",
    phase: null,
    issue_number: result.number,
    issue_url: result.url,
    project_item_id: projectItemId,
  });
}

export async function syncPhaseComplete(
  supabase: SupabaseClient,
  runId: string,
  phase: string,
  pipelineType: "maturation" | "v3",
  documentContents: string[],
  verdict?: string,
): Promise<void> {
  if (!isSyncEnabled()) return;

  const parentIssue = await getRunIssue(supabase, runId);
  if (!parentIssue) {
    log.warn("No parent issue found for run, skipping phase sync", { runId, phase });
    return;
  }

  const existingPhaseIssue = await getPhaseIssue(supabase, runId, phase);
  let phaseIssueNumber: number;

  if (existingPhaseIssue) {
    phaseIssueNumber = existingPhaseIssue.issue_number;
  } else {
    const title = `[${phase}] ${pipelineType === "maturation" ? "Maturation" : "V3"} — #${parentIssue.issue_number}`;
    const body = [
      `Phase: **${phase}**`,
      `Parent: #${parentIssue.issue_number}`,
      verdict ? `Verdict: ${verdict}` : "",
      "",
      `Part of ${parentIssue.issue_url}`,
    ]
      .filter(Boolean)
      .join("\n");

    const result = createIssue(title, body, [pipelineType, `phase:${phase}`]);
    if (!result) return;

    phaseIssueNumber = result.number;
    await saveEntity(supabase, {
      run_id: runId,
      pipeline_type: pipelineType,
      entity_type: "phase_issue",
      phase,
      issue_number: result.number,
      issue_url: result.url,
      project_item_id: null,
    });

    log.info("Created phase sub-issue", { runId, phase, issueNumber: result.number });
  }

  for (const content of documentContents) {
    if (content.trim()) {
      postDocument(phaseIssueNumber, phase.toUpperCase(), content);
    }
  }

  closeIssue(phaseIssueNumber);
}

export async function syncRunComplete(
  supabase: SupabaseClient,
  runId: string,
  finalStatus: string,
): Promise<void> {
  if (!isSyncEnabled()) return;

  const parentIssue = await getRunIssue(supabase, runId);
  if (!parentIssue) return;

  commentOnIssue(parentIssue.issue_number, `## Run Complete\n\n**Final status:** ${finalStatus}`);
  closeIssue(parentIssue.issue_number);
  log.info("Closed run issue", { runId, issueNumber: parentIssue.issue_number, finalStatus });
}
