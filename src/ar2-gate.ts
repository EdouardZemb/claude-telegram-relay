/**
 * @module ar2-gate
 * @description AR2 expert-persona gate for feature request validation.
 * Part of SPEC: lorsque-l-on-discute-d-une-nouvelle (V3 post-maturation).
 *
 * AR2 = Alternative Radicale 2 : "valider avant de construire".
 * An expert-as-persona LLM call produces a GO/NO-GO verdict with rationale
 * before launching the full maturation pipeline.
 *
 * Design decisions from SPEC-UNIFIEE:
 * - Dedicated semaphore (max 1) to avoid starving the main bot semaphore
 * - Rolling context compression (17K token max, ~4 chars/token heuristic)
 * - JSON persistence for auditability
 * - Fail-open: any LLM/parse error returns GO to avoid blocking the user
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createLogger } from "./logger.ts";
import { Semaphore } from "./semaphore.ts";

const log = createLogger("ar2-gate");

// ── Constants ────────────────────────────────────────────────────

/** Approximate chars-per-token ratio for context compression heuristic */
const CHARS_PER_TOKEN = 4;

/** Maximum context size in tokens before rolling compression kicks in */
const MAX_CONTEXT_TOKENS = 17_000;

/** JSON file path for persisting AR2 gate decisions */
export const AR2_RESULTS_FILE = join(process.cwd(), ".ar2-gate-results.json");

/** TTL for cached AR2 results (5 minutes in ms) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Semaphore acquisition timeout in ms — prevents indefinite blocking */
const SEMAPHORE_TIMEOUT_MS = 15_000;

// ── Dedicated semaphore ──────────────────────────────────────────

/**
 * Dedicated semaphore for AR2 evaluations (max 1 concurrent).
 * Prevents AR2 calls from competing with main bot operations.
 */
const ar2Semaphore = new Semaphore(1);

/**
 * Acquire the semaphore with a timeout.
 * Rejects with a timeout error if the semaphore is not acquired within timeoutMs.
 */
async function acquireWithTimeout(semaphore: Semaphore, timeoutMs: number): Promise<void> {
  return Promise.race([
    semaphore.acquire(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`AR2 semaphore acquisition timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

// ── Types ────────────────────────────────────────────────────────

/** AR2 gate verdict: proceed or do not proceed with maturation */
export type AR2Verdict = "GO" | "NO_GO";

/** Result of an AR2 expert-persona evaluation */
export interface AR2Result {
  /** Expert verdict: GO (proceed with maturation) or NO_GO (advise against) */
  verdict: AR2Verdict;
  /** Rationale for the verdict */
  rationale: string;
  /** Optional conditions for GO verdict (must be addressed before/during implementation) */
  conditions?: string[];
  /** Unix timestamp of the evaluation (ms) */
  timestamp: number;
}

// ── Context compression ──────────────────────────────────────────

/**
 * Rolling context compression.
 * If context exceeds MAX_CONTEXT_CHARS, keeps the most recent content (tail)
 * and prepends a truncation marker. This is the "17K tokens max" mitigation
 * from the SPEC-UNIFIEE.
 */
export function compressContext(context: string, maxTokens: number = MAX_CONTEXT_TOKENS): string {
  if (!context) return context;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (context.length <= maxChars) return context;

  // Keep the tail (most recent content) — rolling compression
  // Subtract marker length so total output stays within maxChars
  const marker = "[...contexte compresse...]\n";
  const tailContent = context.slice(context.length - (maxChars - marker.length));
  return marker + tailContent;
}

// ── JSON persistence ─────────────────────────────────────────────

/** Hashes a subject string to a stable key for the results file */
function subjectKey(subject: string): string {
  return createHash("sha256").update(subject.trim().toLowerCase()).digest("hex").substring(0, 16);
}

/**
 * Persist an AR2 gate result to the local JSON file.
 * Creates or updates the file (overwrite with full content).
 * Async to avoid blocking the event loop.
 */
export async function persistAR2Result(subject: string, result: AR2Result): Promise<void> {
  try {
    let data: Record<string, AR2Result> = {};
    if (existsSync(AR2_RESULTS_FILE)) {
      const raw = await readFile(AR2_RESULTS_FILE, "utf-8");
      data = JSON.parse(raw) as Record<string, AR2Result>;
    }
    data[subjectKey(subject)] = result;
    await writeFile(AR2_RESULTS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    log.error("Failed to persist AR2 result", { error: String(err) });
  }
}

/**
 * Load a previously persisted AR2 result for a subject.
 * Returns null if no result exists (file missing, subject not found, or I/O error).
 * Async to avoid blocking the event loop.
 */
export async function loadAR2Result(subject: string): Promise<AR2Result | null> {
  try {
    if (!existsSync(AR2_RESULTS_FILE)) return null;
    const raw = await readFile(AR2_RESULTS_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, AR2Result>;
    return data[subjectKey(subject)] ?? null;
  } catch {
    return null;
  }
}

// ── Expert persona prompt ─────────────────────────────────────────

function buildAR2Prompt(subject: string, context: string): string {
  const contextSection = context ? `\nCONTEXTE RECURRENT:\n${context}\n` : "";

  return `Tu es un expert en conception de produit et architecture logicielle aguerri.
Ton rôle: évaluer si la demande de fonctionnalité suivante mérite d'entrer en maturation (processus de 7 phases, ~1-2 semaines d'effort).

FONCTIONNALITE DEMANDEE: ${subject}
${contextSection}
Analyse selon ces 4 critères:
1. Valeur utilisateur réelle (évite les features plaisir sans traction)
2. Faisabilité technique dans le contexte d'un bot Telegram TypeScript
3. Alignement avec la roadmap d'un assistant développeur personnel
4. Risques identifiés (scope creep, dépendances tierces, sécurité)

Réponds UNIQUEMENT avec un JSON valide (aucun texte avant ou après):
{"verdict": "GO" | "NO_GO", "rationale": "explication en 1-2 phrases", "conditions": ["condition optionnelle 1", "condition optionnelle 2"]}

Si les conditions sont vides, omets le champ "conditions".`;
}

// ── Main gate evaluation ─────────────────────────────────────────

/**
 * Run the AR2 expert-persona gate evaluation.
 *
 * Uses a dedicated semaphore (max 1 concurrent) to avoid contention.
 * Compresses context if it exceeds 17K tokens.
 * Fails open (GO verdict) on any LLM or parse error.
 *
 * @param subject - The feature description to evaluate
 * @param context - Optional conversation context (will be compressed if too long)
 * @param callLLM - LLM caller function (e.g., bctx.callClaude)
 */
export async function runAR2Gate(
  subject: string,
  context: string,
  callLLM: (prompt: string) => Promise<string>,
): Promise<AR2Result> {
  // Cache lookup: return cached result if within TTL (avoids repeated LLM calls for same subject)
  const cached = await loadAR2Result(subject);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log.info(`AR2 cache hit for subject: ${subject.substring(0, 40)}`);
    return cached;
  }

  try {
    await acquireWithTimeout(ar2Semaphore, SEMAPHORE_TIMEOUT_MS);
  } catch (timeoutErr) {
    log.error("AR2 semaphore timeout, failing open", { error: String(timeoutErr) });
    return {
      verdict: "GO",
      rationale: "Evaluation non disponible (timeout).",
      timestamp: Date.now(),
    };
  }

  try {
    const compressedContext = compressContext(context);
    const prompt = buildAR2Prompt(subject, compressedContext);

    let raw: string;
    try {
      raw = await callLLM(prompt);
    } catch (llmErr) {
      log.error("AR2 gate LLM call failed, failing open", { error: String(llmErr) });
      return {
        verdict: "GO",
        rationale: "Evaluation non disponible (erreur LLM).",
        timestamp: Date.now(),
      };
    }

    let parsed: { verdict?: string; rationale?: string; conditions?: string[] };
    try {
      // Extract JSON even if LLM wraps it in markdown code fences
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? (JSON.parse(jsonMatch[0]) as typeof parsed) : {};
    } catch {
      log.warn("AR2 gate: malformed LLM response, failing open", { raw: raw.substring(0, 200) });
      return {
        verdict: "GO",
        rationale: "Evaluation non disponible (reponse inattendue).",
        timestamp: Date.now(),
      };
    }

    const verdict: AR2Verdict = parsed.verdict === "NO_GO" ? "NO_GO" : "GO";
    const rationale = parsed.rationale || "Pas de justification fournie.";
    const result: AR2Result = {
      verdict,
      rationale,
      timestamp: Date.now(),
      ...(parsed.conditions && parsed.conditions.length > 0
        ? { conditions: parsed.conditions }
        : {}),
    };

    await persistAR2Result(subject, result);
    return result;
  } finally {
    ar2Semaphore.release();
  }
}
