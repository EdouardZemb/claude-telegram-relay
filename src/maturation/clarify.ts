/**
 * @module maturation/clarify
 * @description Socratic clarification loop for maturation runs.
 * Uses a maïeutic strategy to ask targeted questions and enrich rawInput.
 */

import { createLogger } from "../logger.ts";
import { listRuns, readDocument, saveRunMeta } from "./documents.ts";
import type { ClarificationQA, ClarificationState, MaturationRun } from "./types.ts";

const log = createLogger("maturation/clarify");

// ── Public types ─────────────────────────────────────────────

export interface ClarifierResponse {
  status: "QUESTION" | "DONE";
  question: string;
  ambiguityScore: number;
  reasoning: string;
}

// ── Test hook ────────────────────────────────────────────────

let _callClaudeHook: ((prompt: string) => Promise<string>) | undefined;

export function _setCallClaudeHookForTests(
  fn: ((prompt: string) => Promise<string>) | undefined,
): void {
  _callClaudeHook = fn;
}

// ── Prompt builder ───────────────────────────────────────────

/**
 * Builds the prompt for the clarifier agent.
 * Includes raw idea, understanding content, Q&A history (Q1/R1, Q2/R2...), and current turn N/5.
 */
export function buildClarifierPrompt(
  rawInput: string,
  understandingContent: string,
  qaHistory: ClarificationQA[],
  currentTurn: number,
): string {
  const maxTurns = 5;

  const qaSection =
    qaHistory.length === 0
      ? "Aucune question posee encore"
      : qaHistory.map((qa, i) => `Q${i + 1}: ${qa.question}\nR${i + 1}: ${qa.answer}`).join("\n\n");

  return `Tu es un agent de clarification socratique. Ta mission est de poser des questions ciblées pour lever les ambiguïtés d'une idée avant son développement.

## Stratégie maïeutique
- Pose une seule question à la fois, la plus importante pour lever l'ambiguïté principale
- Chaque question doit révéler une contrainte, un cas d'usage ou une hypothèse cachée
- Si tu as suffisamment d'information pour continuer (ambiguity score ≤ 3), indique DONE
- Maximum ${maxTurns} tours de clarification

## Idée brute
${rawInput}

## Compréhension initiale
${understandingContent}

## Historique Q&A (tour ${currentTurn}/${maxTurns})
${qaSection}

## Instructions de réponse
Réponds UNIQUEMENT avec un objet JSON valide respectant ce format exact :
{
  "status": "QUESTION" | "DONE",
  "question": "La question à poser (vide si DONE)",
  "ambiguityScore": <nombre entre 0 et 10>,
  "reasoning": "Pourquoi cette question / pourquoi DONE"
}

- status "QUESTION" : tu as encore besoin d'informations, question contient la prochaine question
- status "DONE" : assez d'informations pour avancer, question peut être vide
- ambiguityScore : 0 = tout est clair, 10 = très ambigu`;
}

// ── Response parser ──────────────────────────────────────────

/**
 * Parses a ClarifierResponse from text.
 * Handles: direct JSON, markdown code blocks, JSON embedded in text.
 * Returns null on invalid input.
 */
export function parseClarifierResponse(text: string): ClarifierResponse | null {
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
    log.warn("parseClarifierResponse: no JSON found in text");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    log.warn("parseClarifierResponse: JSON parse error", { error: String(err) });
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Validate status
  if (obj.status !== "QUESTION" && obj.status !== "DONE") {
    log.warn("parseClarifierResponse: invalid status", { status: obj.status });
    return null;
  }

  // Validate ambiguityScore
  if (typeof obj.ambiguityScore !== "number") {
    log.warn("parseClarifierResponse: ambiguityScore must be a number");
    return null;
  }

  // question must be present (can be empty string for DONE, but key must exist)
  if (typeof obj.question !== "string") {
    log.warn("parseClarifierResponse: question field missing or not a string");
    return null;
  }

  // If QUESTION status, question must be non-empty
  if (obj.status === "QUESTION" && !obj.question.trim()) {
    log.warn("parseClarifierResponse: QUESTION status requires a non-empty question");
    return null;
  }

  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";

  return {
    status: obj.status,
    question: obj.question,
    ambiguityScore: obj.ambiguityScore,
    reasoning,
  };
}

// ── Run finder ───────────────────────────────────────────────

/**
 * Finds a maturation run matching chatId, threadId, currentPhase="clarify",
 * and a pending question. Returns null if not found.
 */
export async function checkMaturationClarify(
  chatId: number,
  threadId?: number,
): Promise<MaturationRun | null> {
  const runs = await listRuns();
  const match = runs.find((run) => {
    const chatMatch = run.chatId === chatId;
    const threadMatch = run.threadId === threadId;
    const phaseMatch = run.currentPhase === "clarify";
    const hasPending = !!run.clarification?.pendingQuestion;
    return chatMatch && threadMatch && phaseMatch && hasPending;
  });
  return match ?? null;
}

// ── Clarification start ──────────────────────────────────────

/**
 * Starts a clarification round for a run.
 * - Reads UNDERSTANDING.md
 * - Calls the clarifier agent
 * - If DONE: skips clarify, advances to explore
 * - If QUESTION: sets pendingQuestion on the run
 * Returns {question, ambiguityScore} or null if clarification was skipped.
 */
export async function startClarification(
  run: MaturationRun,
  callClaude: (prompt: string) => Promise<string>,
): Promise<{ question: string; ambiguityScore: number } | null> {
  const effectiveCall = _callClaudeHook ?? callClaude;

  const understandingContent = (await readDocument(run.id, "UNDERSTANDING")) ?? "";
  const qaHistory: ClarificationQA[] = run.clarification?.questions ?? [];
  const currentTurn = run.clarification?.currentTurn ?? 1;

  const prompt = buildClarifierPrompt(run.rawInput, understandingContent, qaHistory, currentTurn);

  let responseText: string;
  try {
    responseText = await effectiveCall(prompt);
  } catch (err) {
    log.error("startClarification: callClaude failed", { runId: run.id, error: String(err) });
    return null;
  }

  const parsed = parseClarifierResponse(responseText);
  if (!parsed) {
    log.warn("startClarification: failed to parse clarifier response", { runId: run.id });
    return null;
  }

  if (parsed.status === "DONE") {
    // Skip clarification, advance to explore
    run.steps.clarify.status = "skipped";
    run.currentPhase = "explore";
    run.updatedAt = new Date().toISOString();
    await saveRunMeta(run);
    log.info("startClarification: clarification skipped (DONE)", { runId: run.id });
    return null;
  }

  // QUESTION: set up clarification state
  const maxTurns = 5;
  run.clarification = {
    questions: qaHistory,
    currentTurn,
    maxTurns,
    pendingQuestion: parsed.question,
  };
  run.updatedAt = new Date().toISOString();
  await saveRunMeta(run);

  log.info("startClarification: question set", {
    runId: run.id,
    turn: currentTurn,
    ambiguityScore: parsed.ambiguityScore,
  });

  return { question: parsed.question, ambiguityScore: parsed.ambiguityScore };
}

// ── User response handler ────────────────────────────────────

/**
 * Handles a user response in the clarification loop.
 * Stores Q&A, increments turn, calls clarifier again.
 * Returns {status:"waiting", question} if more questions remain,
 * or {status:"done", enrichedInput} when complete.
 */
export async function handleClarifyResponse(
  run: MaturationRun,
  userResponse: string,
  callClaude: (prompt: string) => Promise<string>,
): Promise<{ status: "waiting" | "done"; question?: string; enrichedInput?: string }> {
  const effectiveCall = _callClaudeHook ?? callClaude;

  const clarification: ClarificationState = run.clarification ?? {
    questions: [],
    currentTurn: 1,
    maxTurns: 5,
  };

  const pendingQuestion = clarification.pendingQuestion ?? "";

  // Store the Q&A pair
  const qa: ClarificationQA = {
    question: pendingQuestion,
    answer: userResponse,
    turn: clarification.currentTurn,
    timestamp: new Date().toISOString(),
  };
  clarification.questions.push(qa);
  clarification.currentTurn += 1;

  // Call clarifier with updated context
  const understandingContent = (await readDocument(run.id, "UNDERSTANDING")) ?? "";
  const prompt = buildClarifierPrompt(
    run.rawInput,
    understandingContent,
    clarification.questions,
    clarification.currentTurn,
  );

  let responseText: string;
  try {
    responseText = await effectiveCall(prompt);
  } catch (err) {
    log.error("handleClarifyResponse: callClaude failed", { runId: run.id, error: String(err) });
    // On error, finalize with what we have
    return await _finalizeClarification(run, clarification);
  }

  const parsed = parseClarifierResponse(responseText);
  const maxTurnsReached = clarification.currentTurn > clarification.maxTurns;

  if (!parsed || parsed.status === "DONE" || maxTurnsReached) {
    // Finalize clarification
    return await _finalizeClarification(run, clarification);
  }

  // More questions: update pending question
  clarification.pendingQuestion = parsed.question;
  run.clarification = clarification;
  run.updatedAt = new Date().toISOString();
  await saveRunMeta(run);

  log.info("handleClarifyResponse: next question set", {
    runId: run.id,
    turn: clarification.currentTurn,
  });

  return { status: "waiting", question: parsed.question };
}

// ── Internal helpers ─────────────────────────────────────────

async function _finalizeClarification(
  run: MaturationRun,
  clarification: ClarificationState,
): Promise<{ status: "done"; enrichedInput: string }> {
  // Clear pending question, mark clarify step ok, advance phase
  clarification.pendingQuestion = undefined;
  run.clarification = clarification;
  run.steps.clarify.status = "ok";
  run.currentPhase = "explore";
  run.updatedAt = new Date().toISOString();

  // Build enriched input from raw + Q&A
  const qaText = clarification.questions
    .map((qa) => `Q${qa.turn}: ${qa.question}\nR${qa.turn}: ${qa.answer}`)
    .join("\n\n");

  const enrichedInput = `${run.rawInput}\n\n## Clarifications\n${qaText}`;

  await saveRunMeta(run);

  log.info("handleClarifyResponse: clarification complete", {
    runId: run.id,
    turns: clarification.questions.length,
  });

  return { status: "done", enrichedInput };
}
