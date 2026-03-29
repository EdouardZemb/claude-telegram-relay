import type { SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "bun";
import { getConfig } from "./config.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import { createLogger } from "./logger.ts";
import { Semaphore } from "./semaphore.ts";

const log = createLogger("github-sync");
const _syncSemaphore = new Semaphore(2);

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

async function ghExec(args: string[]): Promise<GhResult> {
  if (_ghExecHook) return _ghExecHook(args);

  const { githubRepo, projectDir } = getConfig();
  if (!githubRepo) {
    log.warn("GITHUB_REPO not configured, skipping gh command", { args: args.slice(0, 2) });
    return { stdout: "", stderr: "GITHUB_REPO not configured", exitCode: 1 };
  }

  const proc = spawn(["gh", ...args], {
    cwd: projectDir || process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<GhResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve({ stdout: "", stderr: "gh command timed out after 30s", exitCode: 1 });
    }, 30_000);
  });

  const execPromise = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode: exitCode ?? 1,
  }));

  const result = await Promise.race([execPromise, timeoutPromise]);
  clearTimeout(timeoutHandle);
  return result;
}

/** Exposed for tests only — production code uses ghExec internally. */
export async function _ghExecForTests(args: string[]): Promise<GhResult> {
  return ghExec(args);
}

// ============================================================
// LABEL MANAGEMENT
// ============================================================

const _ensuredLabels = new Set<string>();

export function _resetEnsuredLabelsForTests(): void {
  _ensuredLabels.clear();
}

async function ensureLabel(label: string): Promise<void> {
  if (_ensuredLabels.has(label)) return;

  const { githubRepo } = getConfig();
  const result = await ghExec(["label", "create", label, "--repo", githubRepo]);
  if (result.exitCode === 0) {
    _ensuredLabels.add(label);
  } else if (result.stderr.toLowerCase().includes("already exists")) {
    // Label already exists (possibly with custom color/description) — don't overwrite
    _ensuredLabels.add(label);
    log.debug("Label already exists, keeping custom definition", { label });
  } else {
    log.warn("Failed to ensure label, will try issue creation anyway", {
      label,
      stderr: result.stderr.slice(0, 200),
    });
  }
}

// ============================================================
// ISSUE OPERATIONS
// ============================================================

export async function createIssue(
  title: string,
  body: string,
  labels: string[],
): Promise<{ number: number; url: string } | null> {
  const { githubRepo } = getConfig();

  // Ensure all labels exist before creating the issue (parallel)
  await Promise.all(labels.map((label) => ensureLabel(label)));

  const args = ["issue", "create", "--repo", githubRepo, "--title", title, "--body", body];
  for (const label of labels) {
    args.push("--label", label);
  }

  let result = await ghExec(args);

  // If creation failed and we have labels, retry without labels as fallback
  if (result.exitCode !== 0 && labels.length > 0) {
    log.warn("Issue creation failed with labels, retrying without labels", {
      title,
      labels,
      stderr: result.stderr.slice(0, 200),
    });
    const fallbackArgs = [
      "issue",
      "create",
      "--repo",
      githubRepo,
      "--title",
      title,
      "--body",
      body,
    ];
    result = await ghExec(fallbackArgs);
  }

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

export async function commentOnIssue(issueNumber: number, body: string): Promise<boolean> {
  const { githubRepo } = getConfig();
  const result = await ghExec([
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

export async function closeIssue(issueNumber: number): Promise<boolean> {
  const { githubRepo } = getConfig();
  const result = await ghExec(["issue", "close", String(issueNumber), "--repo", githubRepo]);
  if (result.exitCode !== 0) {
    log.error("Failed to close issue", { issueNumber, stderr: result.stderr.slice(0, 300) });
    return false;
  }
  return true;
}

// ============================================================
// PROJECT BOARD OPERATIONS
// ============================================================

export async function addToProject(issueUrl: string): Promise<string | null> {
  const { githubProjectNumber, githubRepo } = getConfig();
  if (!githubProjectNumber) {
    log.debug("No GITHUB_PROJECT_NUMBER configured, skipping project board");
    return null;
  }

  const owner = githubRepo.split("/")[0];
  const result = await ghExec([
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

export async function postDocument(
  issueNumber: number,
  docType: string,
  content: string,
): Promise<boolean> {
  const chunks = chunkDocument(content);
  let allOk = true;

  for (let i = 0; i < chunks.length; i++) {
    const header =
      chunks.length === 1 ? `## ${docType}\n\n` : `## ${docType} (${i + 1}/${chunks.length})\n\n`;
    const ok = await commentOnIssue(issueNumber, header + chunks[i]);
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

  await _syncSemaphore.acquire();
  try {
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
    const result = await createIssue(title, body, labels);
    if (!result) return;

    log.info("Created run issue", { runId: run.id, issueNumber: result.number });

    const projectItemId = await addToProject(result.url);

    await saveEntity(supabase, {
      run_id: run.id,
      pipeline_type: pipelineType,
      entity_type: "run_issue",
      phase: null,
      issue_number: result.number,
      issue_url: result.url,
      project_item_id: projectItemId,
    });
  } finally {
    _syncSemaphore.release();
  }
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

  await _syncSemaphore.acquire();
  try {
    const parentIssue = await getRunIssue(supabase, runId);
    if (!parentIssue) {
      log.warn("No parent issue found for run, skipping phase sync", { runId, phase });
      return;
    }

    const existingPhaseIssue = await getPhaseIssue(supabase, runId, phase);
    if (existingPhaseIssue) {
      // Crash recovery: issue was already created and closed — skip to avoid duplicate documents
      log.debug("Phase issue already exists, skipping (crash recovery)", {
        runId,
        phase,
        issueNumber: existingPhaseIssue.issue_number,
      });
      return;
    }

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

    const result = await createIssue(title, body, [pipelineType, `phase:${phase}`]);
    if (!result) return;

    const phaseIssueNumber = result.number;
    const phaseProjectItemId = await addToProject(result.url);
    await saveEntity(supabase, {
      run_id: runId,
      pipeline_type: pipelineType,
      entity_type: "phase_issue",
      phase,
      issue_number: result.number,
      issue_url: result.url,
      project_item_id: phaseProjectItemId,
    });

    log.info("Created phase sub-issue", { runId, phase, issueNumber: result.number });

    for (const content of documentContents) {
      if (content.trim()) {
        const ok = await postDocument(phaseIssueNumber, phase.toUpperCase(), content);
        if (!ok) {
          log.warn("Some document chunks failed to post", { runId, phase, phaseIssueNumber });
        }
      }
    }

    await closeIssue(phaseIssueNumber);
  } finally {
    _syncSemaphore.release();
  }
}

export async function syncRunComplete(
  supabase: SupabaseClient,
  runId: string,
  finalStatus: string,
): Promise<void> {
  if (!isSyncEnabled()) return;

  await _syncSemaphore.acquire();
  try {
    const parentIssue = await getRunIssue(supabase, runId);
    if (!parentIssue) return;

    await commentOnIssue(
      parentIssue.issue_number,
      `## Run Complete\n\n**Final status:** ${finalStatus}`,
    );
    await closeIssue(parentIssue.issue_number);
    log.info("Closed run issue", { runId, issueNumber: parentIssue.issue_number, finalStatus });
  } finally {
    _syncSemaphore.release();
  }
}
