/**
 * @module maturation/phases
 * @description Phase execution logic for the maturation pipeline.
 * Each phase function spawns one or more agents, writes output documents,
 * and returns a PhaseResult with status, documents, optional verdict and score.
 */

import { spawnClaude } from "../agent.ts";
import { createLogger } from "../logger.ts";
import { buildPhasePrompt, getAgentConfig } from "./agents.ts";
import { getRunDir, readDocument, writeDocument } from "./documents.ts";
import type { PhaseResult } from "./engine.ts";
import { extractAmbiguityScore, extractMaturityScore, extractShowstopper } from "./scoring.ts";
import type { MaturationDocType, MaturationRun } from "./types.ts";

const log = createLogger("maturation/phases");

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

/**
 * Spawn a single agent and write its output. Returns the written doc path, or null on failure.
 */
async function spawnAgent(run: MaturationRun, role: string): Promise<string | null> {
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

  const prompt = buildPhasePrompt(role, {
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
    return docPath;
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
  const docPath = await spawnAgent(run, "understander");

  if (!docPath) {
    return { status: "failed", documents: [] };
  }

  const content = await readDocument(run.id, "UNDERSTANDING");
  const ambiguityScore = content !== null ? extractAmbiguityScore(content) : 5;

  return {
    status: "ok",
    documents: [docPath],
    verdict: `ambiguity:${ambiguityScore}`,
    score: ambiguityScore,
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
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      documents.push(result.value);
    }
  }

  if (documents.length === 0) {
    log.warn("all explore agents failed", { runId: run.id });
    return { status: "failed", documents: [] };
  }

  return { status: "ok", documents };
}

/**
 * Confront phase: spawns 3 critics (tech, product, strategy) in parallel.
 * Partial success is acceptable — at least 1 critic must succeed.
 */
export async function runConfrontPhase(run: MaturationRun): Promise<PhaseResult> {
  const roles = ["tech-critic", "product-critic", "strategy-critic"];

  const results = await Promise.allSettled(roles.map((role) => spawnAgent(run, role)));

  const documents: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      documents.push(result.value);
    }
  }

  if (documents.length === 0) {
    log.warn("all confront agents failed", { runId: run.id });
    return { status: "failed", documents: [] };
  }

  return { status: "ok", documents };
}

/**
 * Synthesize phase: spawns the synthesizer agent and extracts the maturity score.
 */
export async function runSynthesizePhase(run: MaturationRun): Promise<PhaseResult> {
  const docPath = await spawnAgent(run, "synthesizer");

  if (!docPath) {
    return { status: "failed", documents: [] };
  }

  const content = await readDocument(run.id, "SPEC-UNIFIEE");
  const maturityScore = content !== null ? extractMaturityScore(content) : 0;

  return {
    status: "ok",
    documents: [docPath],
    score: maturityScore,
  };
}

/**
 * Advocate phase: spawns the devil's advocate agent and detects showstoppers.
 */
export async function runAdvocatePhase(run: MaturationRun): Promise<PhaseResult> {
  const docPath = await spawnAgent(run, "devils-advocate");

  if (!docPath) {
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
    documents: [docPath],
    verdict,
  };
}
