/**
 * @module maturation/checkpoint
 * @description Checkpoint system for maturation runs: decision point extraction,
 * advisor prompting, keyboard building, and global decision persistence.
 */

import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { InlineKeyboard } from "grammy";
import { join } from "path";
import { createLogger } from "../logger.ts";
import { getMaturationDir, listRuns, saveRunMeta } from "./documents.ts";
import { extractShowstopper } from "./scoring.ts";
import type {
  CheckpointDecision,
  GlobalDecision,
  MaturationPhase,
  MaturationRun,
} from "./types.ts";

const log = createLogger("maturation/checkpoint");

// ── Constants ─────────────────────────────────────────────────

export const CONTRADICTION_THRESHOLD = 0.85;
export const MAX_CONTRADICTION_PAUSES = 2;

// ── Public types ─────────────────────────────────────────────

export interface ContradictionResult {
  score: number;
  summary: string;
}

export interface CheckpointAdvice {
  summary: string;
  options: string[];
  recommendation: "CONTINUE" | "RE-EXPLORE";
  tags: string[];
}

// ── Test hook ────────────────────────────────────────────────

let _callClaudeHook: ((prompt: string) => Promise<string>) | undefined;

export function _setCallClaudeHookForTests(
  fn: ((prompt: string) => Promise<string>) | undefined,
): void {
  _callClaudeHook = fn;
}

// ── Decision point extraction ─────────────────────────────────

/**
 * Extracts decision points from phase output.
 * - synthesize: looks for "Questions ouvertes" or "Decisions bloquantes" section
 * - advocate: uses extractShowstopper() from scoring.ts
 */
export function extractDecisionPoints(output: string, source: "synthesize" | "advocate"): string[] {
  if (source === "advocate") {
    const ss = extractShowstopper(output);
    return ss ? [ss.reason] : [];
  }

  // synthesize: look for section headers
  const sectionRe =
    /(?:##?\s*(?:Questions\s+ouvertes|D[eé]cisions?\s+bloquantes)[^\n]*\n)([\s\S]*?)(?=\n##|\n#|z|$)/i;
  const sectionMatch = output.match(sectionRe);

  if (!sectionMatch) return [];

  const sectionContent = sectionMatch[1];
  // Extract numbered items: "1. ...", "1) ...", or "- ..."
  const numberedRe = /^\s*(?:\d+[.)]\s+|-\s+)(.+)/gm;
  const items: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = numberedRe.exec(sectionContent)) !== null) {
    const item = match[1].trim();
    if (item) items.push(item);
  }

  return items;
}

// ── Advisor response parser ───────────────────────────────────

/**
 * Parses a CheckpointAdvice from advisor response text.
 * Handles: direct JSON, markdown code block, embedded JSON.
 * Returns null on invalid input.
 */
export function parseAdvisorResponse(text: string): CheckpointAdvice | null {
  if (!text || typeof text !== "string") return null;

  let jsonStr: string | null = null;

  // Try markdown code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try direct JSON object extraction
  if (!jsonStr) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
  }

  if (!jsonStr) {
    log.warn("parseAdvisorResponse: no JSON found in text");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    log.warn("parseAdvisorResponse: JSON parse error", { error: String(err) });
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Validate summary
  if (typeof obj.summary !== "string") {
    log.warn("parseAdvisorResponse: summary must be a string");
    return null;
  }

  // Validate options
  if (
    !Array.isArray(obj.options) ||
    obj.options.length === 0 ||
    !obj.options.every((o) => typeof o === "string")
  ) {
    log.warn("parseAdvisorResponse: options must be a non-empty array of strings");
    return null;
  }

  // Validate recommendation
  if (obj.recommendation !== "CONTINUE" && obj.recommendation !== "RE-EXPLORE") {
    log.warn("parseAdvisorResponse: invalid recommendation", {
      recommendation: obj.recommendation,
    });
    return null;
  }

  // tags: optional, default to []
  const tags =
    Array.isArray(obj.tags) && obj.tags.every((t) => typeof t === "string")
      ? (obj.tags as string[])
      : [];

  return {
    summary: obj.summary,
    options: obj.options as string[],
    recommendation: obj.recommendation,
    tags,
  };
}

// ── Keyboard builder ──────────────────────────────────────────

/**
 * Builds an InlineKeyboard for checkpoint options.
 * One button per option + a final "Autre (texte libre)" button.
 */
export function buildCheckpointKeyboard(runId: string, options: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  options.forEach((option, index) => {
    const label = option.length > 40 ? `${option.slice(0, 37)}...` : option;
    kb.text(label, `mat_cp_opt:${runId}:${index}`).row();
  });

  kb.text("Autre (texte libre)", `mat_cp_other:${runId}`);

  return kb;
}

// ── Advisor prompt builder ────────────────────────────────────

/**
 * Builds the prompt for the Haiku advisor to generate a CheckpointAdvice JSON.
 */
export function buildAdvisorPrompt(
  decisions: string[],
  source: "synthesize" | "advocate",
  specSummary: string,
  existingDecisions: GlobalDecision[],
): string {
  const sourceLabel = source === "synthesize" ? "Synthèse unifiée" : "Avocat du diable";
  const decisionsText = decisions.map((d, i) => `${i + 1}. ${d}`).join("\n");

  const existingContext =
    existingDecisions.length === 0
      ? "Aucune décision précédente."
      : existingDecisions
          .slice(0, 5)
          .map((d) => `- [${d.source}] ${d.summary} → Choix: ${d.userChoice}`)
          .join("\n");

  return `Tu es un conseiller de décision pour un pipeline de maturation d'idées logicielles.

## Contexte de la spec
${specSummary}

## Points de décision identifiés (source: ${sourceLabel})
${decisionsText}

## Décisions précédentes (mémoire globale)
${existingContext}

## Ta mission
Analyser les points de décision et proposer des options claires à l'utilisateur.

Réponds UNIQUEMENT avec un objet JSON valide respectant ce format exact :
{
  "summary": "Résumé concis des points de décision (1-2 phrases)",
  "options": ["Option A : ...", "Option B : ...", "Option C : ..."],
  "recommendation": "CONTINUE" | "RE-EXPLORE",
  "tags": ["tag1", "tag2"]
}

Règles :
- summary : synthèse claire et actionnable des décisions à prendre
- options : 2-4 choix concrets et distincts pour avancer (en français)
- recommendation : CONTINUE si les décisions sont mineures ou claires, RE-EXPLORE si elles remettent en cause des hypothèses fondamentales
- tags : mots-clés thématiques (architecture, sécurité, ux, performance, etc.)`;
}

// ── Checkpoint start ──────────────────────────────────────────

/**
 * Starts a checkpoint for a maturation run.
 * Extracts decision points, calls advisor, sets run.pendingCheckpoint.
 * Returns null if no decision points found.
 */
export async function startCheckpoint(
  run: MaturationRun,
  output: string,
  source: "synthesize" | "advocate",
  callClaude: (prompt: string) => Promise<string>,
): Promise<CheckpointDecision | null> {
  const effectiveCall = _callClaudeHook ?? callClaude;

  const decisions = extractDecisionPoints(output, source);
  if (decisions.length === 0) {
    log.info("startCheckpoint: no decision points found", { runId: run.id, source });
    return null;
  }

  const existingDecisions = await loadGlobalDecisions();

  const specSummary = run.rawInput.slice(0, 500);
  const prompt = buildAdvisorPrompt(decisions, source, specSummary, existingDecisions);

  let responseText: string;
  try {
    responseText = await effectiveCall(prompt);
  } catch (err) {
    log.error("startCheckpoint: callClaude failed", { runId: run.id, error: String(err) });
    return null;
  }

  const advice = parseAdvisorResponse(responseText);

  let checkpoint: CheckpointDecision;

  if (advice) {
    checkpoint = {
      id: randomUUID(),
      source,
      summary: advice.summary,
      options: advice.options,
      recommendation: advice.recommendation,
      tags: advice.tags,
    };
  } else {
    // Fallback: use raw text as summary, await free text from user
    log.warn("startCheckpoint: advisor parse failed, falling back to free text", { runId: run.id });
    checkpoint = {
      id: randomUUID(),
      source,
      summary: responseText.slice(0, 500),
      options: decisions.slice(0, 4),
      recommendation: "CONTINUE",
      tags: [],
      awaitingFreeText: true,
    };
  }

  run.pendingCheckpoint = checkpoint;
  run.updatedAt = new Date().toISOString();
  await saveRunMeta(run);

  log.info("startCheckpoint: checkpoint set", {
    runId: run.id,
    source,
    checkpointId: checkpoint.id,
  });
  return checkpoint;
}

// ── Checkpoint response handler ───────────────────────────────

/**
 * Handles user response to a checkpoint.
 * Resolves the pending checkpoint and saves to global decisions.
 */
export async function handleCheckpointResponse(
  run: MaturationRun,
  userChoice: string,
): Promise<{ action: "CONTINUE" | "RE-EXPLORE" }> {
  const checkpoint = run.pendingCheckpoint;
  if (!checkpoint) {
    log.warn("handleCheckpointResponse: no pending checkpoint", { runId: run.id });
    return { action: "CONTINUE" };
  }

  // Resolve checkpoint
  checkpoint.userChoice = userChoice;
  checkpoint.resolvedAt = new Date().toISOString();

  // Move to resolvedCheckpoints
  run.resolvedCheckpoints = [...(run.resolvedCheckpoints ?? []), checkpoint];
  run.pendingCheckpoint = undefined;
  run.updatedAt = new Date().toISOString();

  // Save global decision — skipped for contradiction source to avoid polluting decisions.json
  if (checkpoint.source !== "contradiction") {
    const globalDecision: GlobalDecision = {
      id: randomUUID(),
      runId: run.id,
      runName: run.name,
      source: checkpoint.source,
      summary: checkpoint.summary,
      userChoice,
      timestamp: new Date().toISOString(),
      tags: checkpoint.tags,
    };
    await saveGlobalDecision(globalDecision);
  }

  // Save run meta
  await saveRunMeta(run);

  log.info("handleCheckpointResponse: checkpoint resolved", {
    runId: run.id,
    checkpointId: checkpoint.id,
    userChoice,
  });

  return { action: checkpoint.recommendation };
}

// ── Run finder ────────────────────────────────────────────────

/**
 * Finds a maturation run with a pending checkpoint for a given chatId + threadId.
 * Returns null if not found.
 */
export async function checkMaturationCheckpoint(
  chatId: number,
  threadId?: number,
): Promise<MaturationRun | null> {
  const runs = await listRuns();
  const match = runs.find((run) => {
    const chatMatch = run.chatId === chatId;
    const threadMatch = run.threadId === threadId;
    const hasPending = !!run.pendingCheckpoint;
    return chatMatch && threadMatch && hasPending;
  });
  return match ?? null;
}

// ── Contradiction detection ───────────────────────────────────

/**
 * Builds a prompt asking Claude to evaluate if phase output invalidates existing decisions.
 */
export function buildContradictionDetectorPrompt(
  phaseOutput: string,
  decisions: GlobalDecision[],
  phaseName: string,
): string {
  const truncatedOutput = phaseOutput.slice(0, 2000);
  const decisionsText = decisions
    .slice(0, 10)
    .map((d, i) => `${i + 1}. [${d.source}] ${d.summary} → Choix: ${d.userChoice}`)
    .join("\n");

  return `Tu es un détecteur de contradictions pour un pipeline de maturation d'idées logicielles.

## Phase analysée : ${phaseName}

## Sortie de la phase (extrait)
${truncatedOutput}

## Décisions précédemment validées par l'utilisateur
${decisionsText}

## Ta mission
Évalue si la sortie de la phase **invalide ou contredit** des décisions déjà validées par l'utilisateur.

Réponds UNIQUEMENT avec un objet JSON valide :
{
  "score": 0.0,
  "summary": "Résumé de la contradiction détectée ou 'Aucune contradiction'"
}

Règles :
- score : float entre 0.0 (aucune contradiction) et 1.0 (contradiction forte et claire)
- Un score >= 0.85 déclenche une alerte à l'utilisateur
- summary : description concise de la contradiction (ou "Aucune contradiction" si score < 0.85)
- Ne signale que des contradictions réelles avec les DÉCISIONS VALIDÉES, pas des tensions mineures`;
}

/**
 * Parses a ContradictionResult from detector response text.
 * Returns null on invalid input.
 */
export function parseContradictionResponse(text: string): ContradictionResult | null {
  if (!text || typeof text !== "string") return null;

  let jsonStr: string | null = null;

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  if (!jsonStr) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
  }

  if (!jsonStr) {
    log.warn("parseContradictionResponse: no JSON found");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    log.warn("parseContradictionResponse: parse error", { error: String(err) });
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.score !== "number" || obj.score < 0 || obj.score > 1) {
    log.warn("parseContradictionResponse: invalid score", { score: obj.score });
    return null;
  }

  if (typeof obj.summary !== "string") {
    log.warn("parseContradictionResponse: invalid summary");
    return null;
  }

  return { score: obj.score, summary: obj.summary };
}

/**
 * Detects if phase output contradicts existing decisions.
 * Returns null when no decisions exist, score is below threshold, or on error (fail-open).
 */
export async function detectContradiction(
  phaseOutput: string,
  decisions: GlobalDecision[],
  callClaude: (prompt: string) => Promise<string>,
  phaseName: string,
): Promise<ContradictionResult | null> {
  const effectiveCall = _callClaudeHook ?? callClaude;

  if (decisions.length === 0) return null;

  const prompt = buildContradictionDetectorPrompt(phaseOutput, decisions, phaseName);

  let responseText: string;
  try {
    responseText = await effectiveCall(prompt);
  } catch (err) {
    log.warn("detectContradiction: callClaude failed (fail-open)", {
      phaseName,
      error: String(err),
    });
    return null;
  }

  const result = parseContradictionResponse(responseText);
  if (!result) return null;

  if (result.score < CONTRADICTION_THRESHOLD) return null;

  return result;
}

/**
 * Checks for contradictions between phase output and existing decisions.
 * Respects circuit breaker (MAX_CONTRADICTION_PAUSES).
 * Returns null if no contradiction or circuit breaker reached.
 */
export async function startContradictionCheckpoint(
  run: MaturationRun,
  phaseOutput: string,
  phaseName: MaturationPhase,
  callClaude: (prompt: string) => Promise<string>,
): Promise<CheckpointDecision | null> {
  const pauseCount = run.contradictionPauseCount ?? 0;
  if (pauseCount >= MAX_CONTRADICTION_PAUSES) {
    log.info("startContradictionCheckpoint: circuit breaker reached", {
      runId: run.id,
      contradictionPauseCount: pauseCount,
    });
    return null;
  }

  const existingDecisions = await loadGlobalDecisions();

  const contradiction = await detectContradiction(
    phaseOutput,
    existingDecisions,
    callClaude,
    phaseName,
  );
  if (!contradiction) return null;

  const checkpoint: CheckpointDecision = {
    id: randomUUID(),
    source: "contradiction",
    summary: contradiction.summary,
    options: [
      "Ignorer cette contradiction et continuer",
      "Revoir la décision précédente",
      "Mettre en pause et réévaluer",
    ],
    recommendation: "CONTINUE",
    tags: ["contradiction"],
  };

  run.pendingCheckpoint = checkpoint;
  run.contradictionPauseCount = pauseCount + 1;
  run.updatedAt = new Date().toISOString();
  await saveRunMeta(run);

  log.info("startContradictionCheckpoint: checkpoint set", {
    runId: run.id,
    phaseName,
    score: contradiction.score,
  });

  return checkpoint;
}

// ── Global decisions ──────────────────────────────────────────

function getDecisionsPath(): string {
  return join(getMaturationDir(), "decisions.json");
}

/**
 * Loads global decisions from decisions.json, optionally filtered by tags.
 * Returns [] if file doesn't exist.
 */
export async function loadGlobalDecisions(tags?: string[]): Promise<GlobalDecision[]> {
  const decisionsPath = getDecisionsPath();
  let decisions: GlobalDecision[];

  try {
    const content = await readFile(decisionsPath, "utf-8");
    decisions = JSON.parse(content) as GlobalDecision[];
  } catch (err: unknown) {
    const nodeError = err as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") return [];
    log.error("loadGlobalDecisions: failed to read decisions.json", { error: String(err) });
    return [];
  }

  if (!Array.isArray(decisions)) return [];

  if (tags && tags.length > 0) {
    decisions = decisions.filter((d) => d.tags.some((t) => tags.includes(t)));
  }

  return decisions;
}

/**
 * Appends a decision to decisions.json.
 * Atomic write (tmp + rename). Caps at 50 entries (pruning oldest).
 */
export async function saveGlobalDecision(decision: GlobalDecision): Promise<void> {
  const decisionsPath = getDecisionsPath();

  // Ensure directory exists
  await mkdir(getMaturationDir(), { recursive: true });

  // Load existing decisions
  let decisions: GlobalDecision[] = await loadGlobalDecisions();

  // Append and cap
  decisions.push(decision);
  if (decisions.length > 50) {
    decisions = decisions.slice(decisions.length - 50);
  }

  // Atomic write
  const tmp = `${decisionsPath}.tmp.${randomUUID().substring(0, 8)}`;
  try {
    await writeFile(tmp, JSON.stringify(decisions, null, 2), "utf-8");
    await rename(tmp, decisionsPath);
  } catch (err) {
    log.error("saveGlobalDecision: failed to write decisions.json", { error: String(err) });
    throw err;
  }

  log.info("saveGlobalDecision: saved", { id: decision.id, total: decisions.length });
}
