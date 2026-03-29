/**
 * @module doc-auto-update
 * @description Automatic documentation update rules with 3-tier stratification.
 *
 * Tier 1 (auto-merge): 8 operational docs — README, CHANGELOG (append-only),
 *   WORKFLOW-DEV, WORKFLOW-PIPELINE, SETUP, dashboard, bmad-system, configuration.
 * Tier 2 (PR + Telegram notification, no auto-merge): CLAUDE.md.
 * Tier 3 (excluded): docs/specs/** and docs/adr/** — design-intent artifacts.
 *
 * Anti-recursion triple barrier:
 *   - shouldTriggerUpdate() gates on src/** changes only
 *   - GITHUB_TOKEN (native, no extra secrets)
 *   - SKIP_CI_SUFFIX in commit messages prevents re-triggering
 *
 * Feature flag: doc_auto_update (disabled by default).
 */

import { createLogger } from "./logger.ts";

const log = createLogger("doc-auto-update");

/** Documentation update tier — drives PR handling strategy */
export type DocTier = 1 | 2 | 3;

/** How a document's content should be updated */
export type UpdateType = "full" | "append-only";

/** Associates a document path with its tier and update strategy */
export interface DocUpdateRule {
  path: string;
  tier: DocTier;
  updateType: UpdateType;
}

/**
 * Canonical rules for operational documentation.
 * Tier 1 (8 docs): auto-merged PRs.
 * Tier 2 (CLAUDE.md): PR created, Telegram notification sent, human reviews before merge.
 */
export const DOC_UPDATE_RULES: DocUpdateRule[] = [
  { path: "README.md", tier: 1, updateType: "full" },
  { path: "CHANGELOG.md", tier: 1, updateType: "append-only" },
  { path: "docs/WORKFLOW-DEV.md", tier: 1, updateType: "full" },
  { path: "docs/WORKFLOW-PIPELINE.md", tier: 1, updateType: "full" },
  { path: "docs/SETUP.md", tier: 1, updateType: "full" },
  { path: "docs/dashboard.md", tier: 1, updateType: "full" },
  { path: "docs/bmad-system.md", tier: 1, updateType: "full" },
  { path: "docs/configuration.md", tier: 1, updateType: "full" },
  { path: "CLAUDE.md", tier: 2, updateType: "full" },
];

/**
 * Path prefixes that unconditionally map to Tier 3 (excluded).
 * Specs and ADRs are design-intent artifacts — never auto-updated.
 */
export const TIER3_PATTERNS: string[] = ["docs/specs/", "docs/adr/"];

/**
 * Commit message suffix that prevents GitHub Actions from re-triggering.
 * Applied to all auto-update commits (anti-recursion barrier 3/3).
 */
export const SKIP_CI_SUFFIX = "[skip actions]";

/**
 * Classify a document path into its update tier.
 * Falls back to Tier 3 (excluded) for unknown paths.
 */
export function classifyDoc(docPath: string): DocTier {
  const rule = DOC_UPDATE_RULES.find((r) => r.path === docPath);
  if (rule) return rule.tier;

  if (TIER3_PATTERNS.some((pattern) => docPath.startsWith(pattern))) {
    return 3;
  }

  return 3;
}

/**
 * Anti-recursion gate (barrier 1/3): returns true only when src/** or config/**
 * files are present in the changed-files list.
 * Prevents doc-only commits from triggering another doc update cycle.
 * Note: scripts/ is excluded intentionally — doc-auto-update.ts itself lives there.
 */
export function shouldTriggerUpdate(changedFiles: string[]): boolean {
  return changedFiles.some((f) => f.startsWith("src/") || f.startsWith("config/"));
}

/** Plan describing which stale documents need updating and how to handle each */
export interface DocUpdatePlan {
  /** Tier 1 docs — eligible for auto-merge */
  tier1: string[];
  /** Tier 2 docs — PR created, Telegram notification, human review required */
  tier2: string[];
  /** Tier 3 docs — excluded from auto-update, listed for observability */
  tier3: string[];
  /** Whether any actionable docs (tier 1 or 2) require attention */
  shouldProceed: boolean;
}

/**
 * Build a doc update plan from a list of stale document paths.
 * Classifies each path by tier to determine PR handling strategy.
 */
export function buildDocUpdatePlan(
  _changedSrcFiles: string[],
  staleDocPaths: string[],
): DocUpdatePlan {
  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];

  for (const docPath of staleDocPaths) {
    const tier = classifyDoc(docPath);
    if (tier === 1) tier1.push(docPath);
    else if (tier === 2) tier2.push(docPath);
    else tier3.push(docPath);
  }

  const shouldProceed = tier1.length > 0 || tier2.length > 0;
  log.info("Doc update plan", { tier1, tier2, tier3Excluded: tier3.length, shouldProceed });

  return { tier1, tier2, tier3, shouldProceed };
}

/**
 * Generate a deterministic branch name for a doc update PR.
 * Uses a timestamp suffix to avoid conflicts across concurrent runs.
 */
export function buildBranchName(timestamp?: number): string {
  const ts = timestamp ?? Date.now();
  return `chore/doc-auto-update-${ts}`;
}

/** Human-readable label for a tier, used in PR titles and Telegram messages */
export function tierLabel(tier: DocTier): string {
  if (tier === 1) return "auto-merge";
  if (tier === 2) return "review-required";
  return "excluded";
}
