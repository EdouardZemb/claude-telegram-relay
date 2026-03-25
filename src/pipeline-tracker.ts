/**
 * @module pipeline-tracker
 * @description Pipeline SDD tracker: tracks conversational SDD pipeline state per chat,
 * persists to disk via atomic write, provides status bar formatting.
 * Phase 2 Architecture V2 — replaces pipeline-state.ts without its orchestrator dependencies.
 *
 * ARCHITECTURE-V2 constraint: no imports from orchestrator/, blackboard.ts, agent-schemas.ts,
 * pipeline-state.ts, or any module marked "Supprime".
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { createLogger } from "./logger.ts";

const log = createLogger("pipeline-tracker");
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (R3)

/** Lazy path resolution so tests can override RELAY_DIR */
function getRelayDir(): string {
  return process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
}
function getPipelinesFile(): string {
  return join(getRelayDir(), "pipelines.json");
}

// ── Types ────────────────────────────────────────────────────

export type SddPhase =
  | "explore"
  | "discuss"
  | "spec"
  | "challenge"
  | "implement"
  | "review"
  | "doc";
export type StepStatus = "pending" | "running" | "ok" | "failed";

export interface PipelineStep {
  phase: SddPhase;
  status: StepStatus;
  artifact?: string;
  summary?: string;
  jobId?: string;
  prUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PipelineTracker {
  chatId: number;
  threadId?: number;
  name: string;
  taskId?: string;
  steps: Record<SddPhase, PipelineStep>;
  createdAt: string;
  updatedAt: string;
}

// ── Constants ────────────────────────────────────────────────

export const ALL_PHASES: SddPhase[] = [
  "explore",
  "discuss",
  "spec",
  "challenge",
  "implement",
  "review",
  "doc",
];

const PHASE_LABELS: Record<SddPhase, string> = {
  explore: "Exploration",
  discuss: "Discussion",
  spec: "Spec",
  challenge: "Challenge",
  implement: "Implementation",
  review: "Review",
  doc: "Documentation",
};

const STATUS_SYMBOLS: Record<StepStatus, string> = {
  ok: "OK",
  running: "EN COURS",
  pending: "--",
  failed: "ECHEC",
};

// ── In-Memory Store ──────────────────────────────────────────

const pipelines = new Map<string, PipelineTracker>();
let persistLoaded = false;

// ── Persistence ──────────────────────────────────────────────

function storageKey(chatId: number, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}:main`;
}

async function loadPipelines(): Promise<void> {
  if (persistLoaded) return;
  try {
    const content = await readFile(getPipelinesFile(), "utf-8");
    const entries: Array<{ key: string; tracker: PipelineTracker }> = JSON.parse(content);
    const now = Date.now();
    for (const { key, tracker } of entries) {
      // Only restore non-expired trackers (R3)
      if (now - new Date(tracker.updatedAt).getTime() < TTL_MS) {
        // R12: backward-compat — add "doc" step if missing from pre-migration trackers
        if (!(tracker.steps as Record<string, unknown>).doc) {
          tracker.steps.doc = { phase: "doc", status: "pending" };
        }
        pipelines.set(key, tracker);
      }
    }
  } catch {
    // R5: optional IO -> degrade gracefully
  }
  persistLoaded = true;
}

async function savePipelines(): Promise<void> {
  try {
    await mkdir(getRelayDir(), { recursive: true });
    const entries = Array.from(pipelines.entries()).map(([key, tracker]) => ({ key, tracker }));
    const pipelinesFile = getPipelinesFile();
    const tmp = pipelinesFile + `.tmp.${crypto.randomUUID().substring(0, 8)}`;
    await writeFile(tmp, JSON.stringify(entries, null, 2));
    await rename(tmp, pipelinesFile);
  } catch (error) {
    log.error("Pipeline persistence error", { error: String(error) });
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Convert a description to a kebab-case pipeline name (R1).
 * 5 steps: lowercase -> NFD normalize -> strip diacritics -> strip non-alphanum -> collapse/trim hyphens
 */
export function toPipelineName(description: string): string {
  const slug = description
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  // Telegram callback_data max 64 bytes. Prefix "sdd_implement:" = 14 chars.
  // Truncate to 48 chars at last complete word boundary.
  if (slug.length <= 48) return slug;
  const truncated = slug.substring(0, 48);
  const lastHyphen = truncated.lastIndexOf("-");
  return lastHyphen > 10 ? truncated.substring(0, lastHyphen) : truncated;
}

/**
 * Create a new pipeline tracker (R3, V3).
 * All 7 steps initialized to 'pending'.
 * Optionally links to a backlog task via taskId.
 */
export async function createPipeline(
  chatId: number,
  threadId: number | undefined,
  name: string,
  opts?: { taskId?: string },
): Promise<PipelineTracker> {
  await loadPipelines();

  const now = new Date().toISOString();
  const steps = {} as Record<SddPhase, PipelineStep>;
  for (const phase of ALL_PHASES) {
    steps[phase] = { phase, status: "pending" };
  }

  const tracker: PipelineTracker = {
    chatId,
    threadId,
    name,
    ...(opts?.taskId ? { taskId: opts.taskId } : {}),
    steps,
    createdAt: now,
    updatedAt: now,
  };

  const key = storageKey(chatId, threadId);
  pipelines.set(key, tracker);
  await savePipelines();
  return tracker;
}

/**
 * Get the tracker for a chat/thread (R4).
 * Returns null if unknown or expired (TTL 7 days based on updatedAt).
 */
export async function getTracker(
  chatId: number,
  threadId?: number,
): Promise<PipelineTracker | null> {
  await loadPipelines();

  const key = storageKey(chatId, threadId);
  const tracker = pipelines.get(key);
  if (!tracker) return null;

  // TTL check (R3)
  if (Date.now() - new Date(tracker.updatedAt).getTime() >= TTL_MS) {
    pipelines.delete(key);
    return null;
  }

  return tracker;
}

/**
 * Update a step in the tracker (R5b).
 * Updates the step's fields and refreshes updatedAt.
 * No-op with log.warn if tracker is null/expired.
 */
export async function updateStep(
  chatId: number,
  threadId: number | undefined,
  phase: SddPhase,
  updates: Partial<Pick<PipelineStep, "status" | "artifact" | "summary" | "jobId" | "prUrl">>,
): Promise<void> {
  const tracker = await getTracker(chatId, threadId);
  if (!tracker) {
    log.warn("updateStep: tracker not found or expired", { chatId, threadId, phase });
    return;
  }

  const step = tracker.steps[phase];
  if (updates.status !== undefined) step.status = updates.status;
  if (updates.artifact !== undefined) step.artifact = updates.artifact;
  if (updates.summary !== undefined) step.summary = updates.summary;
  if (updates.jobId !== undefined) step.jobId = updates.jobId;
  if (updates.prUrl !== undefined) step.prUrl = updates.prUrl;

  // Timestamps
  if (updates.status === "running" && !step.startedAt) {
    step.startedAt = new Date().toISOString();
  }
  if (updates.status === "ok" || updates.status === "failed") {
    step.completedAt = new Date().toISOString();
  }

  tracker.updatedAt = new Date().toISOString();
  await savePipelines();
}

/**
 * Format the status bar for a tracker (R6, V6, V7).
 * Plain-text only (Telegram convention).
 */
export function formatStatusBar(tracker: PipelineTracker): string {
  const lines: string[] = [`Pipeline « ${tracker.name} »`];

  for (const phase of ALL_PHASES) {
    const step = tracker.steps[phase];
    const symbol = STATUS_SYMBOLS[step.status];
    const label = PHASE_LABELS[phase];

    let line = `  ${symbol} ${label}`;

    // Append summary if present
    if (step.summary) {
      line += ` (${step.summary})`;
    }

    // Append artifact reference if present
    if (step.artifact) {
      const shortArtifact = step.artifact.split("/").pop() || step.artifact;
      line += ` — ${shortArtifact}`;
    }

    // Append running indicator
    if (step.status === "running") {
      line += "...";
    }

    lines.push(line);
  }

  return lines.join("\n");
}

// ── Conversational phases eligible for prompt context injection ──

/** Phases where the user is actively conversing and Claude needs pipeline awareness */
const CONVERSATIONAL_PHASES: Set<SddPhase> = new Set(["explore", "discuss"]);

/**
 * Format pipeline context for injection into the system prompt.
 * Returns a concise text block when a conversational phase (explore, discuss) is active.
 * Returns empty string when:
 * - tracker is null (no active pipeline)
 * - no conversational phase is currently running
 *
 * Designed for Option C (enrichissement zz-messages.ts): the output is concatenated
 * with memoryContext before being passed to buildPrompt().
 */
export function formatPipelineContextForPrompt(tracker: PipelineTracker | null): string {
  if (!tracker) return "";

  // Find the currently running conversational phase
  let activePhase: SddPhase | null = null;
  for (const phase of ALL_PHASES) {
    if (tracker.steps[phase].status === "running" && CONVERSATIONAL_PHASES.has(phase)) {
      activePhase = phase;
      break;
    }
  }

  if (!activePhase) return "";

  const lines: string[] = [];
  lines.push(`PIPELINE SDD ACTIF: "${tracker.name}"`);
  lines.push(`Phase en cours: ${PHASE_LABELS[activePhase]}`);

  // List completed artifacts
  const completedArtifacts: string[] = [];
  for (const phase of ALL_PHASES) {
    const step = tracker.steps[phase];
    if (step.status === "ok" && step.artifact) {
      const shortArtifact = step.artifact.split("/").pop() || step.artifact;
      const summaryPart = step.summary ? ` (${step.summary})` : "";
      completedArtifacts.push(`${PHASE_LABELS[phase]}: ${shortArtifact}${summaryPart}`);
    }
  }
  if (completedArtifacts.length > 0) {
    lines.push(`Artefacts: ${completedArtifacts.join(", ")}`);
  }

  // Phase-specific guidance
  if (activePhase === "discuss") {
    lines.push(
      "Objectif: guider la discussion vers des decisions formalisables en spec. " +
        "Quand la conversation converge, utilise le format Decisions: / Prochaine etape:",
    );
  } else if (activePhase === "explore") {
    lines.push(
      "Objectif: explorer le sujet en profondeur avant de formaliser. " +
        "Identifier les alternatives, contraintes et risques.",
    );
  }

  return lines.join("\n");
}

/**
 * Initialize the pipeline tracker by pre-loading from disk.
 * Call once at startup (pattern: initSessions in conversation-session.ts).
 */
export async function initPipelineTracker(): Promise<void> {
  await loadPipelines();
}

/**
 * Clear in-memory store and force reload from disk on next access (R12, V9).
 * For testing only.
 */
export function _clearForTests(): void {
  pipelines.clear();
  persistLoaded = false;
}
