/**
 * @module pipeline-v3/types
 * @description Types for V3 pipeline: reflective loop with multi-critic panel.
 * V3 Enhanced architecture: sequential implement -> review -> fix loop,
 * 3 specialized reviewer agents (security, performance, architecture),
 * quorum 2/3, hierarchical veto, circuit breaker (max 3 iterations).
 */

// ── Reviewer types ──────────────────────────────────────────

export type ReviewerRole = "security" | "performance" | "architecture";

export const ALL_REVIEWER_ROLES: ReviewerRole[] = ["security", "performance", "architecture"];

export type ReviewVerdict = "APPROVED" | "CHANGES_REQUESTED";

export interface ReviewerFinding {
  role: ReviewerRole;
  verdict: ReviewVerdict;
  findings: string;
  /** Whether this reviewer exercised a veto (blocks even if quorum otherwise passes) */
  veto: boolean;
}

export interface PanelVerdict {
  /** Overall panel decision */
  verdict: ReviewVerdict;
  /** Number of APPROVED votes */
  approvedCount: number;
  /** Total reviewers that responded */
  totalResponded: number;
  /** Whether a veto was exercised */
  vetoed: boolean;
  /** Individual findings from each reviewer */
  findings: ReviewerFinding[];
  /** Consolidated change requests (empty if APPROVED) */
  changeRequests: string;
}

// ── Pipeline phases ─────────────────────────────────────────

export type V3Phase = "bridge" | "implement" | "review" | "fix" | "done" | "failed";

export type V3StepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface V3Step {
  phase: V3Phase;
  status: V3StepStatus;
  startedAt?: string;
  completedAt?: string;
  result?: string;
}

// ── Pipeline run ────────────────────────────────────────────

export interface V3Run {
  id: string;
  /** Maturation run ID that produced the SPEC-UNIFIEE */
  maturationRunId: string;
  /** Pipeline name (derived from maturation run name) */
  name: string;
  /** Path to the SPEC-UNIFIEE.md source */
  specPath: string;
  /** Current phase in the reflective loop */
  currentPhase: V3Phase;
  /** Current iteration of the implement->review->fix loop (0-indexed) */
  iteration: number;
  /** Max iterations before circuit breaker trips (default 3) */
  maxIterations: number;
  /** Step states for each phase */
  steps: Record<V3Phase, V3Step>;
  /** Panel verdicts from each review iteration */
  panelHistory: PanelVerdict[];
  /** PR URL if implementation created one */
  prUrl?: string;
  /** Branch name for the implementation */
  branchName?: string;
  /** Final status */
  finalStatus?: "merged" | "circuit_breaker" | "failed";
  createdAt: string;
  updatedAt: string;
}

// ── Constants ───────────────────────────────────────────────

/** Default max iterations for the reflective loop circuit breaker */
export const DEFAULT_MAX_ITERATIONS = 3;

/** Quorum threshold: minimum APPROVED votes to pass (2 out of 3) */
export const QUORUM_THRESHOLD = 2;

// ── Helpers ─────────────────────────────────────────────────

export const V3_ALL_PHASES: V3Phase[] = ["bridge", "implement", "review", "fix", "done", "failed"];

export const V3_PHASE_LABELS: Record<V3Phase, string> = {
  bridge: "Bridge SPEC",
  implement: "Implementation",
  review: "Panel Review",
  fix: "Corrections",
  done: "Terminé",
  failed: "Échoué",
};

export function createEmptyV3Run(maturationRunId: string, name: string, specPath: string): V3Run {
  const now = new Date().toISOString();
  const steps = {} as Record<V3Phase, V3Step>;
  for (const phase of V3_ALL_PHASES) {
    steps[phase] = { phase, status: "pending" };
  }
  return {
    id: crypto.randomUUID(),
    maturationRunId,
    name,
    specPath,
    currentPhase: "bridge",
    iteration: 0,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    steps,
    panelHistory: [],
    createdAt: now,
    updatedAt: now,
  };
}
