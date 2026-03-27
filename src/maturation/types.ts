import { randomUUID } from "crypto";
import { createLogger } from "../logger.ts";

const log = createLogger("maturation/types");

// Phase types
export type MaturationPhase =
  | "understand"
  | "clarify"
  | "explore"
  | "confront"
  | "synthesize"
  | "advocate"
  | "validate";

export const ALL_MATURATION_PHASES: MaturationPhase[] = [
  "understand",
  "clarify",
  "explore",
  "confront",
  "synthesize",
  "advocate",
  "validate",
];

export const PHASE_LABELS: Record<MaturationPhase, string> = {
  understand: "Comprehension",
  clarify: "Clarification",
  explore: "Exploration",
  confront: "Confrontation",
  synthesize: "Synthese",
  advocate: "Avocat du diable",
  validate: "Validation",
};

export type PhaseStatus = "pending" | "running" | "ok" | "failed" | "skipped";

// Document types
export type MaturationDocType =
  | "UNDERSTANDING"
  | "EXPAND"
  | "RESEARCH"
  | "ANALOGIES"
  | "CRITIQUE-TECH"
  | "CRITIQUE-PROD"
  | "CRITIQUE-STRAT"
  | "SPEC-UNIFIEE"
  | "DEVILS-ADVOCATE";

export const MATURATION_DOC_TYPES: MaturationDocType[] = [
  "UNDERSTANDING",
  "EXPAND",
  "RESEARCH",
  "ANALOGIES",
  "CRITIQUE-TECH",
  "CRITIQUE-PROD",
  "CRITIQUE-STRAT",
  "SPEC-UNIFIEE",
  "DEVILS-ADVOCATE",
];

// Step & Run interfaces
export interface MaturationStep {
  phase: MaturationPhase;
  status: PhaseStatus;
  documents: string[];
  score?: number;
  verdict?: string;
  jobId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface MaturationRun {
  id: string;
  chatId: number;
  threadId?: number;
  name: string;
  rawInput: string;
  steps: Record<MaturationPhase, MaturationStep>;
  currentPhase: MaturationPhase;
  iteration: number;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
  clarification?: ClarificationState;
  pendingCheckpoint?: CheckpointDecision;
  resolvedCheckpoints?: CheckpointDecision[];
}

// Quality gate
export interface GateResult {
  passed: boolean;
  score: number;
  issues: string[];
  recommendation: "advance" | "loop" | "human" | "abort";
}

// Clarification types
export interface ClarificationQA {
  question: string;
  answer: string;
  turn: number;
  timestamp: string;
}

export interface ClarificationState {
  questions: ClarificationQA[];
  currentTurn: number;
  maxTurns: number;
  pendingQuestion?: string;
}

// Checkpoint types
export interface CheckpointDecision {
  id: string;
  source: "synthesize" | "advocate";
  summary: string;
  options: string[];
  recommendation: "CONTINUE" | "RE-EXPLORE";
  tags: string[];
  awaitingFreeText?: boolean;
  userChoice?: string;
  resolvedAt?: string;
}

export interface GlobalDecision {
  id: string;
  runId: string;
  runName: string;
  source: "synthesize" | "advocate";
  summary: string;
  userChoice: string;
  timestamp: string;
  tags: string[];
}

// Helpers
export function toMaturationName(description: string): string {
  if (!description.trim()) {
    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 13);
    return `maturation-${ts.slice(0, 8)}-${ts.slice(8)}`;
  }
  const slug = description
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (slug.length <= 48) return slug;
  const cut = slug.slice(0, 48);
  const lastDash = cut.lastIndexOf("-");
  return lastDash > 10 ? cut.slice(0, lastDash) : cut;
}

export function createEmptyRun(
  chatId: number,
  threadId: number | undefined,
  name: string,
  rawInput: string,
): MaturationRun {
  const now = new Date().toISOString();
  const steps = {} as Record<MaturationPhase, MaturationStep>;
  for (const phase of ALL_MATURATION_PHASES) {
    steps[phase] = { phase, status: "pending", documents: [] };
  }
  return {
    id: randomUUID(),
    chatId,
    threadId,
    name,
    rawInput,
    steps,
    currentPhase: "understand",
    iteration: 0,
    maxIterations: 2,
    createdAt: now,
    updatedAt: now,
  };
}
