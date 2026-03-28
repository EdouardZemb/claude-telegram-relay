/**
 * @module pipeline-v3
 * @description Barrel re-export for pipeline-v3 sub-modules.
 */

export {
  getNextV3Phase,
  handleV3PhaseResult,
  type V3PhaseResult,
  type V3TransitionContext,
} from "./engine.ts";

export {
  bridgeSpec,
  buildFixPrompt,
  buildImplementPrompt,
  type OnV3Progress,
  runV3Pipeline,
} from "./orchestrator.ts";

export {
  buildReviewPrompt,
  computePanelVerdict,
  extractReviewerVerdict,
  extractVeto,
  runReviewPanel,
} from "./reviewers.ts";

export {
  ALL_REVIEWER_ROLES,
  createEmptyV3Run,
  DEFAULT_MAX_ITERATIONS,
  type PanelVerdict,
  QUORUM_THRESHOLD,
  type ReviewerFinding,
  type ReviewerRole,
  type ReviewVerdict,
  V3_ALL_PHASES,
  V3_PHASE_LABELS,
  type V3Phase,
  type V3Run,
  type V3Step,
  type V3StepStatus,
} from "./types.ts";
