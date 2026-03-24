/**
 * @module agent
 * @description Sub-agent execution: launches Claude Code with branch-PR workflow.
 */

/**
 * Agentic Task Execution
 *
 * Launches Claude Code as a sub-agent to execute tasks autonomously.
 * Uses branch-PR workflow: creates a feature branch, makes changes,
 * then creates a PR for review before merging to master.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { spawn, spawnSync } from "bun";
import { buildBmadExecPrompt, enrichPromptWithAgent } from "./bmad-agents.ts";
import { createLogger } from "./logger.ts";
import { type Task, updateTaskStatus } from "./tasks.ts";

const log = createLogger("agent");

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

// ── SpawnClaude — Centralized CLI spawn (S28-T1) ─────────────

export interface SpawnClaudeOptions {
  prompt: string;
  systemPrompt?: string;
  outputFormat?: "text" | "json";
  jsonSchema?: object;
  effort?: "low" | "medium" | "high" | "max";
  model?: string;
  fallbackModel?: string;
  maxBudgetUsd?: number;
  useWorktree?: boolean;
  fromPr?: number;
  cwd?: string;
  timeout?: number;
  /** S34: Enable model cascade (Haiku -> Sonnet -> Opus). AC-011 to AC-015 */
  cascade?: boolean;
}

export interface SpawnClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** S34: Model that was actually used (for cascade tracking) */
  modelUsed?: string;
  /** S34: Number of cascade escalations (0 if no cascade) */
  cascadeEscalations?: number;
}

/** S34: Model cascade order — cheapest to most expensive */
export const CASCADE_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"] as const;

/**
 * S34 FR-003: Run spawnClaude with model cascade.
 * Starts with cheapest model, escalates on failure.
 * AC-013: Includes failure reason from previous attempt.
 * EC-003: Stops after exhausting all 3 tiers.
 * EC-006: Explicit model override disables cascade.
 */
export async function spawnClaudeWithCascade(
  options: SpawnClaudeOptions,
): Promise<SpawnClaudeResult> {
  // EC-006: If explicit model is set, use it directly (no cascade)
  if (options.model) {
    const result = await spawnClaudeCore(options);
    result.modelUsed = options.model;
    result.cascadeEscalations = 0;
    return result;
  }

  let lastError = "";
  let escalations = 0;

  for (let i = 0; i < CASCADE_MODELS.length; i++) {
    const model = CASCADE_MODELS[i];

    // AC-013: Include failure context from previous attempt
    let prompt = options.prompt;
    if (lastError && i > 0) {
      prompt = [
        prompt,
        "",
        `NOTE: A previous attempt with a simpler model failed. Error context:`,
        lastError.substring(0, 1000),
        "",
        "Please try to produce a correct output.",
      ].join("\n");
    }

    const result = await spawnClaudeCore({
      ...options,
      prompt,
      model,
      fallbackModel: undefined, // cascade handles escalation
    });

    result.modelUsed = model;
    result.cascadeEscalations = escalations;

    // Success: return immediately
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return result;
    }

    // Failed: record error and escalate
    lastError = result.stderr || result.stdout || "Empty output";
    escalations++;
  }

  // EC-003: All tiers exhausted, return failure from last (Opus) attempt
  return {
    stdout: "",
    stderr: lastError,
    exitCode: 1,
    modelUsed: CASCADE_MODELS[CASCADE_MODELS.length - 1],
    cascadeEscalations: escalations,
  };
}

/**
 * Centralized function to spawn Claude Code CLI with all supported flags.
 * Builds args conditionally: flags are only added if the option is provided.
 * S34: Renamed core logic to spawnClaudeCore, spawnClaude is the public API
 * that handles cascade routing.
 */
async function spawnClaudeCore(options: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
  const args: string[] = [CLAUDE_PATH];

  // System prompt (--append-system-prompt) before task prompt
  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }

  // Task prompt
  args.push("-p", options.prompt);

  // Output format
  if (options.outputFormat === "json") {
    args.push("--output-format", "json");
  } else {
    args.push("--output-format", "text");
  }

  // JSON schema for structured output
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }

  // Model selection
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.fallbackModel) {
    args.push("--fallback-model", options.fallbackModel);
  }

  // Effort level
  if (options.effort) {
    args.push("--effort", options.effort);
  }

  // Budget guard
  if (options.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  // Worktree isolation
  if (options.useWorktree) {
    args.push("-w");
  }

  // PR context for code review
  if (options.fromPr !== undefined) {
    args.push("--from-pr", String(options.fromPr));
  }

  // Always skip permissions for automation
  args.push("--dangerously-skip-permissions");

  // Log spawn command for debugging
  const cmdSummary =
    args.slice(0, 3).join(" ") + (args.length > 3 ? ` ... (${args.length} args)` : "");
  log.info(
    `Spawning: ${cmdSummary} | model=${options.model || "default"} | effort=${options.effort || "default"}`,
  );

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.cwd || PROJECT_DIR,
      env: { ...process.env },
    });

    // Read stdout and stderr in parallel to prevent pipe deadlock.
    // If read sequentially, a full stderr buffer blocks the child process
    // which prevents stdout from closing — causing a hang on long tasks.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      log.error(`Exit code ${exitCode} | stderr: ${stderr.substring(0, 500)}`);
    }

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } catch (error) {
    log.error(`Spawn failed: ${error}`);
    return { stdout: "", stderr: String(error), exitCode: 1 };
  }
}

/**
 * Public API: spawn Claude Code CLI.
 * S34: Routes to cascade when options.cascade is true (AC-015: backward compatible).
 */
export async function spawnClaude(options: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
  if (options.cascade) {
    return spawnClaudeWithCascade(options);
  }
  return spawnClaudeCore(options);
}

const GITHUB_REPO = process.env.GITHUB_REPO || "EdouardZemb/claude-telegram-relay";
const AGENT_HEARTBEAT_MS = 2 * 60 * 1000; // 2 minutes — send progress update

export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  prUrl?: string;
  ciPassed?: boolean;
  ciDetails?: string;
  reviewScore?: number;
  reviewSummary?: string;
}

function git(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(["git", ...args], { cwd: PROJECT_DIR });
  return {
    ok: result.exitCode === 0,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

/**
 * Pre-commit validation: typecheck + unit tests.
 * Runs before git commit in executeTask to catch errors early.
 *
 * Defense in profondeur: ce gate hard couvre le chemin executeTask.
 * Les instructions soft (R4-R5 dans bmad-prompts.ts) couvrent les chemins
 * hors executeTask (orchestrateur via spawnClaude direct). Les deux
 * mecanismes coexistent par design.
 *
 * Fail-fast: typecheck first, skip tests if typecheck fails.
 * Error truncation: messages capped at 2000 chars for Telegram readability.
 */
const PRE_COMMIT_TIMEOUT_MS = 60_000;
const ERROR_MAX_LENGTH = 2000;

export function runPreCommitValidation(projectDir: string): { passed: boolean; errors: string[] } {
  const errors: string[] = [];
  // Use the current runtime's bun binary to avoid PATH resolution issues
  const bunPath = process.execPath || "bun";

  try {
    // Step 1: Typecheck (fail-fast — if this fails, skip tests)
    const typecheck = spawnSync([bunPath, "build", "--no-bundle", "--target=bun", "src/"], {
      cwd: projectDir,
      env: { ...process.env },
      timeout: PRE_COMMIT_TIMEOUT_MS,
    });

    if (typecheck.exitCode !== 0) {
      const stderr = new TextDecoder().decode(typecheck.stderr).trim();
      const stdout = new TextDecoder().decode(typecheck.stdout).trim();
      const msg = (stderr || stdout || "typecheck failed").substring(0, ERROR_MAX_LENGTH);
      errors.push(`TypeCheck: ${msg}`);
      log.error("Pre-commit typecheck failed", { exitCode: typecheck.exitCode });
      return { passed: false, errors };
    }

    // Step 2: Unit tests (only if typecheck passed)
    const tests = spawnSync([bunPath, "test", "tests/unit", "--bail"], {
      cwd: projectDir,
      env: { ...process.env },
      timeout: PRE_COMMIT_TIMEOUT_MS,
    });

    if (tests.exitCode !== 0) {
      const stderr = new TextDecoder().decode(tests.stderr).trim();
      const stdout = new TextDecoder().decode(tests.stdout).trim();
      const msg = (stderr || stdout || "tests failed").substring(0, ERROR_MAX_LENGTH);
      errors.push(`Tests: ${msg}`);
      log.error("Pre-commit tests failed", { exitCode: tests.exitCode });
      return { passed: false, errors };
    }

    return { passed: true, errors: [] };
  } catch (err) {
    // spawnSync throws ENOENT if cwd doesn't exist or bun binary not found
    const msg = String(err).substring(0, ERROR_MAX_LENGTH);
    errors.push(`TypeCheck: ${msg}`);
    log.error("Pre-commit validation error", { error: String(err) });
    return { passed: false, errors };
  }
}

function sanitizeBranchName(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 40);
  // Append short unique suffix to prevent branch name collisions
  const suffix = Date.now().toString(36).slice(-5);
  return `${base}-${suffix}`;
}

/**
 * Sanitize a string for safe use in shell arguments.
 * Removes characters that could be used for command injection.
 */
function sanitizeShellArg(input: string): string {
  return input
    .replace(/[`$\\!;|&(){}<>]/g, "")
    .replace(/\n/g, " ")
    .trim();
}

/**
 * Wait for CI checks to complete on a branch.
 * Polls gh pr checks every 15s for up to 10 minutes.
 */
async function waitForCIChecks(
  branchName: string,
  onProgress?: (message: string) => Promise<void>,
): Promise<{ passed: boolean; details: string }> {
  const maxWaitMs = 10 * 60 * 1000; // 10 minutes
  const pollIntervalMs = 15_000; // 15 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const result = spawnSync(
      ["gh", "pr", "checks", branchName, "-R", GITHUB_REPO, "--json", "name,state,bucket"],
      { cwd: PROJECT_DIR },
    );
    const output = new TextDecoder().decode(result.stdout).trim();

    if (result.exitCode !== 0 || !output) {
      // Checks not yet available, wait and retry
      await Bun.sleep(pollIntervalMs);
      continue;
    }

    try {
      const checks = JSON.parse(output) as Array<{
        name: string;
        state: string;
        bucket: string;
      }>;

      if (checks.length === 0) {
        // No checks configured yet, wait
        await Bun.sleep(pollIntervalMs);
        continue;
      }

      const allCompleted = checks.every(
        (c) => c.bucket === "pass" || c.bucket === "fail" || c.bucket === "skipping",
      );

      if (!allCompleted) {
        await Bun.sleep(pollIntervalMs);
        continue;
      }

      const allPassed = checks.every((c) => c.bucket === "pass" || c.bucket === "skipping");

      const details = checks.map((c) => `${c.name}: ${c.bucket}`).join(", ");

      if (allPassed) {
        if (onProgress) {
          await onProgress(`CI OK: ${details}`);
        }
        return { passed: true, details };
      } else {
        const failed = checks.filter((c) => c.bucket === "fail");
        const failDetails = failed.map((c) => `${c.name}: ${c.bucket}`).join(", ");
        if (onProgress) {
          await onProgress(`CI echouee: ${failDetails}`);
        }
        return { passed: false, details: failDetails };
      }
    } catch {
      log.warn("pollForBranchPR catch — retrying"); // R8: business error → log.warn
      await Bun.sleep(pollIntervalMs);
    }
  }

  if (onProgress) {
    await onProgress("Timeout: CI n'a pas termine apres 10 minutes.");
  }
  return { passed: false, details: "Timeout apres 10 minutes" };
}

/**
 * Execute a task using Claude Code as a sub-agent.
 *
 * Workflow: create feature branch -> run Claude -> commit -> push -> create PR.
 * If the task involves no file changes, no PR is created.
 */
export async function executeTask(
  supabase: SupabaseClient | null,
  task: Task,
  onProgress?: (message: string) => Promise<void>,
): Promise<AgentResult> {
  const startTime = Date.now();

  // Mark task as in progress
  if (supabase) {
    await updateTaskStatus(supabase, task.id, "in_progress");
  }

  if (onProgress) {
    await onProgress(`Demarrage de la tache: ${task.title}`);
  }

  // Create feature branch
  const branchName = `feature/${sanitizeBranchName(task.title)}`;
  git("checkout", "master");
  git("pull", "origin", "master");
  const branchResult = git("checkout", "-b", branchName);
  if (!branchResult.ok) {
    // Branch may already exist, try switching to it
    git("checkout", branchName);
  }

  if (onProgress) {
    await onProgress(`Branche ${branchName} creee. Agent en cours d'execution...`);
  }

  const prompt = buildAgentPrompt(task);

  try {
    // Heartbeat: send periodic progress updates instead of hard timeout
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (onProgress) {
      heartbeatTimer = setInterval(async () => {
        const elapsed = Math.round((Date.now() - startTime) / 60000);
        await onProgress(`Agent toujours en cours... (${elapsed} min)`).catch(() => {});
      }, AGENT_HEARTBEAT_MS);
    }

    // S28: Use centralized spawnClaude
    const result = await spawnClaude({
      prompt,
    });

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    const durationMs = Date.now() - startTime;

    if (result.exitCode !== 0) {
      // Task failed — go back to master
      git("checkout", "master");
      return {
        success: false,
        output: result.stdout,
        error: result.stderr,
        durationMs,
      };
    }

    const output = result.stdout;

    // Check if there are any changes to commit
    const status = git("status", "--porcelain");
    let prUrl: string | undefined;

    if (status.stdout) {
      // Stage all changes
      git("add", "-A");

      // Pre-commit validation: typecheck + unit tests (R1, R2)
      const validation = runPreCommitValidation(PROJECT_DIR);
      if (!validation.passed) {
        log.error("Pre-commit validation failed, aborting commit", { errors: validation.errors });
        git("checkout", "master");
        return {
          success: false,
          output: output.trim(),
          error: `Pre-commit validation failed:\n${validation.errors.join("\n")}`,
          durationMs: Date.now() - startTime,
        };
      }

      git("commit", "-m", `feat: ${task.title}`);

      // Push branch
      const pushResult = git("push", "-u", "origin", branchName);
      if (!pushResult.ok) {
        log.error("git push failed", { branch: branchName, stderr: pushResult.stderr });
        git("checkout", "master");
        if (supabase) {
          await updateTaskStatus(supabase, task.id, "review");
        }
        return {
          success: false,
          output: output.trim(),
          error: `Push echoue: ${pushResult.stderr}`,
          durationMs: Date.now() - startTime,
        };
      }

      // Create PR via gh CLI (sanitize user-controlled strings)
      const safeTitle = sanitizeShellArg(task.title);
      const safeDesc = sanitizeShellArg(task.description || "");
      const prBody =
        `Tache automatisee via /exec\n\nID: ${task.id.substring(0, 8)}\nPriorite: P${task.priority}\n\n${safeDesc}`.trim();
      const prResult = spawnSync(
        [
          "gh",
          "pr",
          "create",
          "-R",
          GITHUB_REPO,
          "--title",
          safeTitle,
          "--body",
          prBody,
          "--base",
          "master",
          "--head",
          branchName,
        ],
        { cwd: PROJECT_DIR },
      );
      const prOutput = new TextDecoder().decode(prResult.stdout).trim();
      const prStderr = new TextDecoder().decode(prResult.stderr).trim();

      if (prResult.exitCode !== 0 || !prOutput.startsWith("http")) {
        log.error("PR creation failed", {
          branch: branchName,
          exitCode: prResult.exitCode,
          stderr: prStderr,
        });
        if (onProgress) {
          await onProgress(`Branche ${branchName} poussee mais creation PR echouee: ${prStderr}`);
        }
        git("checkout", "master");
        if (supabase) {
          await updateTaskStatus(supabase, task.id, "review");
        }
        return {
          success: false,
          output: output.trim(),
          error: `PR creation echouee (branche poussee: ${branchName}): ${prStderr}`,
          durationMs: Date.now() - startTime,
        };
      }

      prUrl = prOutput;

      // Wait for CI checks to complete
      if (onProgress) {
        await onProgress("PR creee. Attente des checks CI...");
      }
      const ciResult = await waitForCIChecks(branchName, onProgress);
      if (!ciResult.passed) {
        git("checkout", "master");
        if (supabase) {
          await updateTaskStatus(supabase, task.id, "review");
        }
        return {
          success: true,
          output: output.trim(),
          durationMs: Date.now() - startTime,
          prUrl,
          ciPassed: false,
          ciDetails: ciResult.details,
        };
      }
    }

    // Go back to master
    git("checkout", "master");

    // Only mark task as done if we have a PR (or no changes were needed)
    if (supabase) {
      if (prUrl || !status.stdout) {
        await updateTaskStatus(supabase, task.id, "done");
      } else {
        log.error("task completed without PR despite having changes", { taskId: task.id });
        await updateTaskStatus(supabase, task.id, "review");
      }
    }

    return {
      success: true,
      output: output.trim(),
      durationMs,
      prUrl,
      ciPassed: prUrl ? true : undefined,
    };
  } catch (error) {
    // R9: propagation → log.error
    git("checkout", "master");
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      output: "",
      error: String(error),
      durationMs,
    };
  }
}

/**
 * Build a structured prompt for the sub-agent.
 * Uses BMad Dev agent (Amelia) persona for structured execution.
 */
function buildAgentPrompt(task: Task): string {
  return buildBmadExecPrompt(task);
}

/**
 * Decompose a high-level request into sub-tasks using Claude.
 *
 * Returns a list of task titles + descriptions that can be added to the backlog.
 */
export async function decomposeTask(
  request: string,
): Promise<
  Array<{ title: string; description: string; priority: number; acceptance_criteria?: string }>
> {
  const taskPrompt = [
    "Decompose cette demande en sous-taches techniques concretes.",
    "Chaque tache doit etre independante et realisable par un agent Claude Code.",
    "",
    `DEMANDE: ${request}`,
    "",
    "Reponds UNIQUEMENT au format JSON, un array d'objets avec les champs:",
    '  title: string (court, imperatif, ex: "Ajouter la route /api/tasks")',
    "  description: string (1-2 phrases de contexte technique)",
    "  priority: number (1=critique, 2=important, 3=normal)",
    "  acceptance_criteria: string (criteres d'acceptation au format Given/When/Then, separes par des retours a la ligne)",
    "",
    "Exemple de reponse:",
    '[{"title": "Creer le composant Button", "description": "Composant React reutilisable avec variantes primary/secondary.", "priority": 2, "acceptance_criteria": "Given le composant Button existe\\nWhen l\'utilisateur clique dessus\\nThen l\'action onClick est declenchee"}]',
    "",
    "JSON:",
  ].join("\n");

  // Enrich with PM agent (John) persona
  const { enrichedPrompt: prompt } = enrichPromptWithAgent("plan", taskPrompt);

  try {
    // S28: Use centralized spawnClaude
    const result = await spawnClaude({ prompt });

    // Extract JSON from the response
    const jsonMatch = result.stdout.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const tasks = JSON.parse(jsonMatch[0]);
    return tasks.filter((t: { title?: string }) => t && typeof t.title === "string");
  } catch (error) {
    log.error(`decomposeTask error: ${error}`);
    return [];
  }
}
