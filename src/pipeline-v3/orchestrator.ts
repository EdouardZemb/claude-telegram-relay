/**
 * @module pipeline-v3/orchestrator
 * @description V3 pipeline orchestrator: bridges SPEC-UNIFIEE to implementation,
 * runs the reflective loop (implement -> review -> fix), and reports progress.
 * Addresses AM-1 (SPEC-UNIFIEE bridge) and AM-2 (fix agent on existing branch).
 */

import { readFile } from "fs/promises";
import { type SpawnClaudeOptions, type SpawnClaudeResult, spawnClaude } from "../agent.ts";
import { syncPhaseComplete, syncRunComplete, syncRunStart } from "../github-sync.ts";
import { createLogger } from "../logger.ts";
import { handleV3PhaseResult } from "./engine.ts";
import { runReviewPanel } from "./reviewers.ts";
import { createEmptyV3Run, type V3Run } from "./types.ts";

const log = createLogger("pipeline-v3/orchestrator");

// ── Test hooks ──────────────────────────────────────────────

type SpawnHook = (
  opts: Pick<SpawnClaudeOptions, "prompt" | "systemPrompt" | "model" | "effort" | "useWorktree">,
) => Promise<SpawnClaudeResult>;

let _spawnHook: SpawnHook | undefined;

/** @internal -- for tests only */
export function _setSpawnHookForTests(fn: SpawnHook | undefined): void {
  _spawnHook = fn;
}

async function callSpawn(
  opts: Pick<SpawnClaudeOptions, "prompt" | "systemPrompt" | "model" | "effort" | "useWorktree">,
): Promise<SpawnClaudeResult> {
  if (_spawnHook) return _spawnHook(opts);
  return spawnClaude(opts);
}

type ReadFileHook = (path: string) => Promise<string>;
let _readFileHook: ReadFileHook | undefined;

/** @internal -- for tests only */
export function _setReadFileHookForTests(fn: ReadFileHook | undefined): void {
  _readFileHook = fn;
}

async function readSpecFile(path: string): Promise<string> {
  if (_readFileHook) return _readFileHook(path);
  return readFile(path, "utf-8");
}

type ReviewPanelHook = (
  specPath: string,
  branchName: string,
  prUrl: string | undefined,
  previousFindings: string,
) => Promise<import("./types.ts").PanelVerdict>;

let _reviewPanelHook: ReviewPanelHook | undefined;

/** @internal -- for tests only */
export function _setReviewPanelHookForTests(fn: ReviewPanelHook | undefined): void {
  _reviewPanelHook = fn;
}

// ── Progress callback type ──────────────────────────────────

export type OnV3Progress = (message: string) => Promise<void>;

// ── Bridge phase (AM-1) ─────────────────────────────────────

/**
 * Bridge SPEC-UNIFIEE.md to a prompt consumable by the implement agent.
 * Reads the spec file and extracts key sections.
 * Returns the spec content or throws on read failure.
 */
export async function bridgeSpec(specPath: string): Promise<string> {
  const content = await readSpecFile(specPath);

  if (!content.trim()) {
    throw new Error(`SPEC-UNIFIEE is empty: ${specPath}`);
  }

  return content;
}

// ── Implement phase ─────────────────────────────────────────

/**
 * Build the implementation prompt from the spec content.
 */
export function buildImplementPrompt(
  specContent: string,
  name: string,
  previousChangeRequests: string,
): string {
  const parts = [
    "IMPLEMENTATION V3 POST-MATURATION",
    "",
    `Pipeline: ${name}`,
    "",
    "SPEC-UNIFIEE:",
    specContent,
    "",
    "Instructions:",
    "- Implémente en TDD (tests d'abord, puis code)",
    "- Respecte les conventions du projet (barrel, logger, config)",
    "- Crée les tests dans tests/unit/",
    "- Assure-toi que bun test passe",
    `- Sauvegarde le rapport dans docs/reviews/implement-${name}.md`,
    "- Cree une PR avec les changements",
  ];

  if (previousChangeRequests) {
    parts.push(
      "",
      "CORRECTIONS DEMANDÉES PAR LE PANEL DE REVIEW:",
      previousChangeRequests,
      "",
      "Tu DOIS adresser ces corrections dans cette iteration.",
    );
  }

  return parts.join("\n");
}

/**
 * Build the fix prompt from the change requests.
 * AM-2: The fix agent applies corrections on the existing branch.
 */
export function buildFixPrompt(name: string, changeRequests: string, specContent: string): string {
  return [
    "CORRECTIONS V3 POST-REVIEW",
    "",
    `Pipeline: ${name}`,
    "",
    "Le panel de review multi-critique a demandé les corrections suivantes:",
    "",
    changeRequests,
    "",
    "SPEC-UNIFIEE de reference:",
    specContent,
    "",
    "Instructions:",
    "- Applique uniquement les corrections demandées",
    "- Ne modifie pas de code qui n'est pas concerné par les corrections",
    "- Assure-toi que bun test passe après les corrections",
    "- Commit et push les corrections sur la branche courante",
  ].join("\n");
}

// ── Orchestrator ────────────────────────────────────────────

/**
 * Run the V3 pipeline: bridge -> implement -> review -> (fix -> implement -> review)* -> done/failed.
 * Returns a result string:
 * - "V3_DONE:{name} — {prUrl}" on success
 * - "V3_CIRCUIT_BREAKER:{name}" if max iterations reached
 * - "V3_FAILED:{phase}:{name}" on unrecoverable error
 */
export async function runV3Pipeline(
  maturationRunId: string,
  name: string,
  specPath: string,
  onProgress: OnV3Progress,
  // biome-ignore lint/suspicious/noExplicitAny: supabase client type not available here
  supabase?: any,
): Promise<{ result: string; run: V3Run }> {
  const run = createEmptyV3Run(maturationRunId, name, specPath);
  log.info("V3 pipeline started", { runId: run.id, name, specPath });

  // ── Phase: Bridge ──────────────────────────────────────
  await onProgress(`[V3] Bridge SPEC-UNIFIEE...`);
  run.steps.bridge.status = "running";
  run.steps.bridge.startedAt = new Date().toISOString();

  let specContent: string;
  try {
    specContent = await bridgeSpec(specPath);
    handleV3PhaseResult(run, "bridge", {
      status: "ok",
      result: `Spec loaded (${specContent.length} chars)`,
    });
    await onProgress(`[V3] Bridge OK (${specContent.length} chars)`);
    // Fire-and-forget GitHub sync
    if (supabase) {
      syncRunStart(
        supabase,
        { id: run.id, name, rawInput: specContent.substring(0, 500) },
        "v3",
      ).catch((err) => log.warn("GitHub sync failed for V3 run start", { error: String(err) }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    handleV3PhaseResult(run, "bridge", { status: "failed", result: msg });
    return { result: `V3_FAILED:bridge:${name}`, run };
  }

  // ── Reflective loop ────────────────────────────────────
  let previousChangeRequests = "";

  while (run.currentPhase !== "done" && run.currentPhase !== "failed") {
    if (run.currentPhase === "implement") {
      await onProgress(`[V3] Implementation (iteration ${run.iteration})...`);
      run.steps.implement.status = "running";
      run.steps.implement.startedAt = new Date().toISOString();

      try {
        const prompt = buildImplementPrompt(specContent, name, previousChangeRequests);
        const result = await callSpawn({
          prompt,
          model: "claude-sonnet-4-6",
          effort: "high",
          useWorktree: run.iteration === 0, // Only use worktree on first iteration
        });

        if (result.exitCode !== 0 || !result.stdout.trim()) {
          handleV3PhaseResult(run, "implement", {
            status: "failed",
            result: result.stderr || "Empty output",
          });
          return { result: `V3_FAILED:implement:${name}`, run };
        }

        // Extract PR URL from output
        const prUrlMatch = result.stdout.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
        if (prUrlMatch) {
          run.prUrl = prUrlMatch[0];
        }

        // Extract branch name
        const branchMatch = result.stdout.match(
          /(?:branch|branche)\s*:?\s*[`'"]?([a-zA-Z0-9/_-]+)[`'"]?/i,
        );
        if (branchMatch) {
          run.branchName = branchMatch[1];
        }

        handleV3PhaseResult(run, "implement", {
          status: "ok",
          result: result.stdout.substring(0, 500),
        });
        if (supabase) {
          syncPhaseComplete(
            supabase,
            run.id,
            "implement",
            "v3",
            [result.stdout.substring(0, 2000)],
            run.branchName || "",
          ).catch((err) =>
            log.warn("GitHub sync failed", { phase: "implement", error: String(err) }),
          );
        }
        await onProgress(`[V3] Implementation OK`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        handleV3PhaseResult(run, "implement", { status: "failed", result: msg });
        return { result: `V3_FAILED:implement:${name}`, run };
      }
    }

    if (run.currentPhase === "review") {
      await onProgress(`[V3] Panel review (iteration ${run.iteration})...`);
      run.steps.review.status = "running";
      run.steps.review.startedAt = new Date().toISOString();

      try {
        const reviewFn = _reviewPanelHook || runReviewPanel;
        const panelVerdict = await reviewFn(
          specPath,
          run.branchName || "unknown",
          run.prUrl,
          previousChangeRequests,
        );

        handleV3PhaseResult(run, "review", {
          status: "ok",
          panelVerdict,
          result: `${panelVerdict.verdict} (${panelVerdict.approvedCount}/${panelVerdict.totalResponded})`,
        });

        if (supabase) {
          const verdictSummary = `${panelVerdict.verdict} (${panelVerdict.approvedCount}/${panelVerdict.totalResponded})`;
          syncPhaseComplete(
            supabase,
            run.id,
            `review-${run.iteration}`,
            "v3",
            [panelVerdict.changeRequests || ""],
            verdictSummary,
          ).catch((err) => log.warn("GitHub sync failed", { phase: "review", error: String(err) }));
        }

        if (panelVerdict.verdict === "APPROVED") {
          await onProgress(
            `[V3] Panel APPROVED (${panelVerdict.approvedCount}/${panelVerdict.totalResponded})`,
          );
        } else {
          previousChangeRequests = panelVerdict.changeRequests;
          await onProgress(
            `[V3] Panel CHANGES_REQUESTED (${panelVerdict.approvedCount}/${panelVerdict.totalResponded})${panelVerdict.vetoed ? " [VETO]" : ""}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        handleV3PhaseResult(run, "review", { status: "failed", result: msg });
        return { result: `V3_FAILED:review:${name}`, run };
      }
    }

    if (run.currentPhase === "fix") {
      await onProgress(`[V3] Corrections (iteration ${run.iteration})...`);
      run.steps.fix.status = "running";
      run.steps.fix.startedAt = new Date().toISOString();

      try {
        const prompt = buildFixPrompt(name, previousChangeRequests, specContent);
        const result = await callSpawn({
          prompt,
          model: "claude-sonnet-4-6",
          effort: "high",
        });

        if (result.exitCode !== 0 || !result.stdout.trim()) {
          handleV3PhaseResult(run, "fix", {
            status: "failed",
            result: result.stderr || "Empty output",
          });
          return { result: `V3_FAILED:fix:${name}`, run };
        }

        handleV3PhaseResult(run, "fix", {
          status: "ok",
          result: result.stdout.substring(0, 500),
        });
        await onProgress(`[V3] Corrections appliquées`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        handleV3PhaseResult(run, "fix", { status: "failed", result: msg });
        return { result: `V3_FAILED:fix:${name}`, run };
      }
    }
  }

  // ── Terminal states ────────────────────────────────────
  if (run.finalStatus === "merged") {
    const prInfo = run.prUrl || "no PR URL";
    log.info("V3 pipeline completed successfully", { runId: run.id, name, prUrl: run.prUrl });
    if (supabase) {
      syncRunComplete(supabase, run.id, run.finalStatus || "unknown").catch((err) =>
        log.warn("GitHub sync failed for V3 completion", { error: String(err) }),
      );
    }
    return { result: `V3_DONE:${name} — ${prInfo}`, run };
  }

  if (run.finalStatus === "circuit_breaker") {
    log.warn("V3 pipeline circuit breaker tripped", {
      runId: run.id,
      name,
      iterations: run.iteration,
    });
    if (supabase) {
      syncRunComplete(supabase, run.id, run.finalStatus || "unknown").catch((err) =>
        log.warn("GitHub sync failed for V3 completion", { error: String(err) }),
      );
    }
    return { result: `V3_CIRCUIT_BREAKER:${name}`, run };
  }

  return { result: `V3_FAILED:unknown:${name}`, run };
}
