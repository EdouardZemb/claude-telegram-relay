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

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  prUrl?: string;
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

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

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

    if (status.stdout) {
      // Stage and commit all changes
      git("add", "-A");
      git("commit", "-m", `feat: ${task.title}`);

      // Push branch
      const pushResult = git("push", "-u", "origin", branchName);
      if (pushResult.ok) {
        // Create PR via gh CLI
        const prResult = spawnSync(
          ["gh", "pr", "create",
            "--title", task.title,
            "--body", `Tache automatisee via /exec\n\nID: ${task.id.substring(0, 8)}\nPriorite: P${task.priority}\n\n${task.description || ""}`.trim(),
            "--base", "master",
            "--head", branchName,
          ],
          { cwd: PROJECT_DIR }
        );
        const prOutput = new TextDecoder().decode(prResult.stdout).trim();
        if (prResult.exitCode === 0 && prOutput.startsWith("http")) {
          prUrl = prOutput;
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
 */
function buildAgentPrompt(task: Task): string {
  const parts = [
    "Tu es un agent d'execution autonome. Tu dois realiser la tache suivante.",
    "",
    `TACHE: ${task.title}`,
  ];

  if (task.description) {
    parts.push(`DESCRIPTION: ${task.description}`);
  }

  parts.push(`PROJET: ${task.project}`);
  parts.push(`PRIORITE: P${task.priority}`);

  if (task.notes) {
    parts.push(`NOTES: ${task.notes}`);
  }

  parts.push(
    "",
    "INSTRUCTIONS:",
    "- Analyse le codebase existant avant de faire des modifications",
    "- Ecris du code propre et coherent avec le style existant",
    "- Teste que les modifications fonctionnent",
    "- Fais un resume concis de ce que tu as fait a la fin",
    "- Si tu es bloque, explique clairement pourquoi",
    "",
    "Commence maintenant."
  );

  return parts.join("\n");
}

/**
 * Decompose a high-level request into sub-tasks using Claude.
 *
 * Returns a list of task titles + descriptions that can be added to the backlog.
 */
export async function decomposeTask(
  request: string
): Promise<Array<{ title: string; description: string; priority: number }>> {
  const prompt = [
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
