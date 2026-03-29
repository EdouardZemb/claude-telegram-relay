/**
 * @module maturation/phases
 * @description Phase execution logic for the maturation pipeline.
 * Each phase function spawns one or more agents, writes output documents,
 * and returns a PhaseResult with status, documents, optional verdict and score.
 */

import { spawnClaude } from "../agent.ts";
import { isFeatureEnabled } from "../feature-flags.ts";
import { createLogger } from "../logger.ts";
import { buildEnrichedPrompt } from "../prompt-overlay.ts";
import { buildPhasePrompt, getAgentConfig } from "./agents.ts";
import { getRunDir, readDocument, writeDocument } from "./documents.ts";
import type { PhaseResult } from "./engine.ts";
import { extractAmbiguityScore, extractMaturityScore, extractShowstopper } from "./scoring.ts";
import type { MaturationDocType, MaturationRun } from "./types.ts";

const log = createLogger("maturation/phases");

// ── Test hook ─────────────────────────────────────────────────

let _featureFlagHook: ((flag: string) => boolean) | undefined;

/** @internal — for tests: override feature flag checks without mock.module() */
export function _setFeatureFlagHookForTests(fn: ((flag: string) => boolean) | undefined): void {
  _featureFlagHook = fn;
}

function checkFeatureFlag(flag: string): boolean {
  if (_featureFlagHook !== undefined) return _featureFlagHook(flag);
  return isFeatureEnabled(flag);
}

let _enrichPromptHook: ((role: string, base: string) => string) | undefined;

/** @internal — for tests: override buildEnrichedPrompt without mock.module() */
export function _setEnrichPromptHookForTests(
  fn: ((role: string, base: string) => string) | undefined,
): void {
  _enrichPromptHook = fn;
}

function callBuildEnrichedPrompt(role: string, base: string): string {
  if (_enrichPromptHook !== undefined) return _enrichPromptHook(role, base);
  return buildEnrichedPrompt(role, base);
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Collect prior documents for a list of doc types from the run directory.
 */
async function collectDocuments(
  runId: string,
  docTypes: MaturationDocType[],
): Promise<Partial<Record<string, string>>> {
  const docs: Partial<Record<string, string>> = {};
  for (const docType of docTypes) {
    const content = await readDocument(runId, docType);
    if (content !== null) {
      docs[docType] = content;
    }
  }
  return docs;
}

interface SpawnAgentResult {
  docPath: string;
  overlaysUsed: boolean;
}

/**
 * Spawn a single agent and write its output.
 * Returns SpawnAgentResult with docPath and overlaysUsed, or null on failure.
 */
async function spawnAgent(run: MaturationRun, role: string): Promise<SpawnAgentResult | null> {
  const config = getAgentConfig(role);
  if (!config) {
    log.warn("unknown agent role", { role });
    return null;
  }

  const documents = await collectDocuments(run.id, config.requiredDocs);
  const runDir = getRunDir(run.id);

  let globalDecisions: Array<{ source: string; summary: string; userChoice: string }> = [];
  try {
    const { loadGlobalDecisions } = await import("./checkpoint.ts");
    const gd = await loadGlobalDecisions();
    globalDecisions = gd.slice(0, 5).map((d) => ({
      source: d.source,
      summary: d.summary,
      userChoice: d.userChoice,
    }));
  } catch {
    // checkpoint module may not be available, ignore
  }

  const basePrompt = buildPhasePrompt(role, {
    rawInput: run.rawInput,
    runDir,
    documents,
    resolvedCheckpoints: run.resolvedCheckpoints?.map((cp) => ({
      source: cp.source,
      summary: cp.summary,
      userChoice: cp.userChoice ?? "",
    })),
    globalDecisions,
  });

  const overlaysEnabled = checkFeatureFlag("prompt_feedback_loop");
  const prompt = overlaysEnabled ? callBuildEnrichedPrompt(role, basePrompt) : basePrompt;
  const overlaysUsed = overlaysEnabled && prompt !== basePrompt;

  const result = await spawnClaude({
    prompt,
    model: config.model,
    effort: config.effort,
  });

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    log.warn("agent spawn failed", { role, exitCode: result.exitCode });
    return null;
  }

  try {
    const docPath = await writeDocument(run.id, config.outputDoc, result.stdout);
    return { docPath, overlaysUsed };
  } catch (err) {
    log.warn("failed to write agent output", { role, error: String(err) });
    return null;
  }
}

// ── Phase implementations ─────────────────────────────────────

/**
 * Understand phase: spawns the understander agent and extracts the ambiguity score.
 */
export async function runUnderstandPhase(run: MaturationRun): Promise<PhaseResult> {
  const agentResult = await spawnAgent(run, "understander");

  if (!agentResult) {
    return { status: "failed", documents: [] };
  }

  const content = await readDocument(run.id, "UNDERSTANDING");
  const ambiguityScore = content !== null ? extractAmbiguityScore(content) : 5;

  return {
    status: "ok",
    documents: [agentResult.docPath],
    verdict: `ambiguity:${ambiguityScore}`,
    score: ambiguityScore,
    overlaysUsed: agentResult.overlaysUsed,
  };
}

/**
 * Explore phase: spawns 3 agents (expander, researcher, analogist) in parallel.
 * Partial success is acceptable — at least 1 agent must succeed.
 */
export async function runExplorePhase(run: MaturationRun): Promise<PhaseResult> {
  const roles = ["expander", "researcher", "analogist"];

  const results = await Promise.allSettled(roles.map((role) => spawnAgent(run, role)));

  const documents: string[] = [];
  let overlaysUsed = false;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      documents.push(result.value.docPath);
      if (result.value.overlaysUsed) overlaysUsed = true;
    }
  }

  if (documents.length === 0) {
    log.warn("all explore agents failed", { runId: run.id });
    return { status: "failed", documents: [] };
  }

  return { status: "ok", documents, overlaysUsed };
}

/**
 * Confront phase: spawns 3 critics (tech, product, strategy) in parallel.
 * Partial success is acceptable — at least 1 critic must succeed.
 */
export async function runConfrontPhase(run: MaturationRun): Promise<PhaseResult> {
  const roles = ["tech-critic", "product-critic", "strategy-critic"];

  const results = await Promise.allSettled(roles.map((role) => spawnAgent(run, role)));

  const documents: string[] = [];
  let overlaysUsed = false;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      documents.push(result.value.docPath);
      if (result.value.overlaysUsed) overlaysUsed = true;
    }
  }

  if (documents.length === 0) {
    log.warn("all confront agents failed", { runId: run.id });
    return { status: "failed", documents: [] };
  }

  return { status: "ok", documents, overlaysUsed };
}

/**
 * Synthesize phase: spawns the synthesizer agent and extracts the maturity score.
 */
export async function runSynthesizePhase(run: MaturationRun): Promise<PhaseResult> {
  const agentResult = await spawnAgent(run, "synthesizer");

  if (!agentResult) {
    return { status: "failed", documents: [] };
  }

  const content = await readDocument(run.id, "SPEC-UNIFIEE");
  const maturityScore = content !== null ? extractMaturityScore(content) : 0;

  return {
    status: "ok",
    documents: [agentResult.docPath],
    score: maturityScore,
    overlaysUsed: agentResult.overlaysUsed,
  };
}

/**
 * Advocate phase: spawns the devil's advocate agent and detects showstoppers.
 */
export async function runAdvocatePhase(run: MaturationRun): Promise<PhaseResult> {
  const agentResult = await spawnAgent(run, "devils-advocate");

  if (!agentResult) {
    return { status: "failed", documents: [] };
  }

  const content = await readDocument(run.id, "DEVILS-ADVOCATE");
  const showstopper = content !== null ? extractShowstopper(content) : null;

  let verdict: string;
  if (showstopper) {
    verdict = `SHOWSTOPPER: ${showstopper.reason}`;
  } else {
    verdict = content?.includes("PASS") ? "PASS" : "ok";
  }

  return {
    status: "ok",
    documents: [agentResult.docPath],
    verdict,
    overlaysUsed: agentResult.overlaysUsed,
  };
}
