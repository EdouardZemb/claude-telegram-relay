/**
 * Agentic Task Execution
 *
 * Launches Claude Code as a sub-agent to execute tasks autonomously.
 * Uses branch-PR workflow: creates a feature branch, makes changes,
 * then creates a PR for review before merging to master.
 */

import { spawn, spawnSync } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateTaskStatus, type Task } from "./tasks.ts";
import { buildBmadExecPrompt, enrichPromptWithAgent } from "./bmad-agents.ts";
import { runCodeReview, saveReviewResult, formatReviewResult } from "./code-review.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
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

function sanitizeBranchName(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
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
  onProgress?: (message: string) => Promise<void>
): Promise<{ passed: boolean; details: string }> {
  const maxWaitMs = 10 * 60 * 1000; // 10 minutes
  const pollIntervalMs = 15_000; // 15 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const result = spawnSync(
      ["gh", "pr", "checks", branchName, "-R", GITHUB_REPO, "--json", "name,state,conclusion"],
      { cwd: PROJECT_DIR }
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
        conclusion: string;
      }>;

      if (checks.length === 0) {
        // No checks configured yet, wait
        await Bun.sleep(pollIntervalMs);
        continue;
      }

      const allCompleted = checks.every(
        (c) => c.state === "COMPLETED" || c.state === "completed"
      );

      if (!allCompleted) {
        await Bun.sleep(pollIntervalMs);
        continue;
      }

      const allPassed = checks.every(
        (c) =>
          c.conclusion === "SUCCESS" ||
          c.conclusion === "success" ||
          c.conclusion === "NEUTRAL" ||
          c.conclusion === "neutral" ||
          c.conclusion === "SKIPPED" ||
          c.conclusion === "skipped"
      );

      const details = checks
        .map((c) => `${c.name}: ${c.conclusion}`)
        .join(", ");

      if (allPassed) {
        if (onProgress) {
          await onProgress(`CI OK: ${details}`);
        }
        return { passed: true, details };
      } else {
        const failed = checks.filter(
          (c) =>
            c.conclusion !== "SUCCESS" &&
            c.conclusion !== "success" &&
            c.conclusion !== "NEUTRAL" &&
            c.conclusion !== "neutral" &&
            c.conclusion !== "SKIPPED" &&
            c.conclusion !== "skipped"
        );
        const failDetails = failed
          .map((c) => `${c.name}: ${c.conclusion}`)
          .join(", ");
        if (onProgress) {
          await onProgress(`CI echouee: ${failDetails}`);
        }
        return { passed: false, details: failDetails };
      }
    } catch {
      await Bun.sleep(pollIntervalMs);
      continue;
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
  onProgress?: (message: string) => Promise<void>
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
    const args = [
      CLAUDE_PATH,
      "-p",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
    ];

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: { ...process.env },
    });

    // Heartbeat: send periodic progress updates instead of hard timeout
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (onProgress) {
      heartbeatTimer = setInterval(async () => {
        const elapsed = Math.round((Date.now() - startTime) / 60000);
        await onProgress(`Agent toujours en cours... (${elapsed} min)`).catch(() => {});
      }, AGENT_HEARTBEAT_MS);
    }

    // No hard timeout — let the process run until completion
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    const durationMs = Date.now() - startTime;

    if (exitCode !== 0) {
      // Task failed — go back to master
      git("checkout", "master");
      return {
        success: false,
        output: output.trim(),
        error: stderr.trim(),
        durationMs,
      };
    }

    // Check if there are any changes to commit
    const status = git("status", "--porcelain");
    let prUrl: string | undefined;
    let reviewResult: Awaited<ReturnType<typeof runCodeReview>> | undefined;

    if (status.stdout) {
      // Stage and commit all changes
      git("add", "-A");
      git("commit", "-m", `feat: ${task.title}`);

      // Gate 3: Adversarial code review before push
      if (onProgress) {
        await onProgress("Code review adversariale en cours...");
      }
      reviewResult = await runCodeReview(branchName, task.title, onProgress);

      if (supabase) {
        await saveReviewResult(supabase, task.id, branchName, reviewResult);
      }

      if (onProgress) {
        const reviewText = formatReviewResult(reviewResult);
        await onProgress(reviewText.length > 4000 ? reviewText.substring(0, 4000) : reviewText);
      }

      if (!reviewResult.passesGate) {
        git("checkout", "master");
        if (supabase) {
          await updateTaskStatus(supabase, task.id, "review");
        }
        return {
          success: true,
          output: output.trim(),
          durationMs: Date.now() - startTime,
          reviewScore: reviewResult.score,
          reviewSummary: `Code review bloquee (score: ${reviewResult.score}/100). ${reviewResult.findings.filter(f => f.severity === "critical").length} findings critiques.`,
        };
      }

      // Push branch
      const pushResult = git("push", "-u", "origin", branchName);
      if (pushResult.ok) {
        // Create PR via gh CLI (sanitize user-controlled strings)
        const safeTitle = sanitizeShellArg(task.title);
        const safeDesc = sanitizeShellArg(task.description || "");
        const prBody = `Tache automatisee via /exec\n\nID: ${task.id.substring(0, 8)}\nPriorite: P${task.priority}\n\n${safeDesc}`.trim();
        const prResult = spawnSync(
          ["gh", "pr", "create",
            "-R", GITHUB_REPO,
            "--title", safeTitle,
            "--body", prBody,
            "--base", "master",
            "--head", branchName,
          ],
          { cwd: PROJECT_DIR }
        );
        const prOutput = new TextDecoder().decode(prResult.stdout).trim();
        if (prResult.exitCode === 0 && prOutput.startsWith("http")) {
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
      }
    }

    // Go back to master
    git("checkout", "master");

    // Mark task as done
    if (supabase) {
      await updateTaskStatus(supabase, task.id, "done");
    }

    return {
      success: true,
      output: output.trim(),
      durationMs,
      prUrl,
      ciPassed: prUrl ? true : undefined,
      reviewScore: reviewResult?.score,
      reviewSummary: reviewResult?.summary,
    };
  } catch (error) {
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
  request: string
): Promise<Array<{ title: string; description: string; priority: number }>> {
  const taskPrompt = [
    "Decompose cette demande en sous-taches techniques concretes.",
    "Chaque tache doit etre independante et realisable par un agent Claude Code.",
    "",
    `DEMANDE: ${request}`,
    "",
    "Reponds UNIQUEMENT au format JSON, un array d'objets avec les champs:",
    '  title: string (court, imperatif, ex: "Ajouter la route /api/tasks")',
    '  description: string (1-2 phrases de contexte technique)',
    "  priority: number (1=critique, 2=important, 3=normal)",
    "",
    "Exemple de reponse:",
    '[{"title": "Creer le composant Button", "description": "Composant React reutilisable avec variantes primary/secondary.", "priority": 2}]',
    "",
    "JSON:",
  ].join("\n");

  // Enrich with PM agent (John) persona
  const { enrichedPrompt: prompt } = enrichPromptWithAgent("plan", taskPrompt);

  try {
    const args = [
      CLAUDE_PATH,
      "-p",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
    ];

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: { ...process.env },
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Extract JSON from the response
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const tasks = JSON.parse(jsonMatch[0]);
    return tasks.filter(
      (t: { title?: string }) => t && typeof t.title === "string"
    );
  } catch (error) {
    console.error("decomposeTask error:", error);
    return [];
  }
}
