/**
 * @module pipeline-v3/reviewers
 * @description Multi-critic panel: 3 specialized reviewer agents (security, performance,
 * architecture) with quorum 2/3, hierarchical veto, and fail-closed verdict extraction.
 * Addresses F-TC-2: parsing failure = CHANGES_REQUESTED (never silent GO).
 */

import { type SpawnClaudeOptions, type SpawnClaudeResult, spawnClaude } from "../agent.ts";
import { createLogger } from "../logger.ts";
import {
  ALL_REVIEWER_ROLES,
  type PanelVerdict,
  QUORUM_THRESHOLD,
  type ReviewerFinding,
  type ReviewerRole,
  type ReviewVerdict,
} from "./types.ts";

const log = createLogger("pipeline-v3/reviewers");

// ── Test hooks ──────────────────────────────────────────────

type SpawnHook = (
  opts: Pick<SpawnClaudeOptions, "prompt" | "systemPrompt" | "model" | "effort">,
) => Promise<SpawnClaudeResult>;

let _spawnHook: SpawnHook | undefined;

/** @internal -- for tests only */
export function _setSpawnHookForTests(fn: SpawnHook | undefined): void {
  _spawnHook = fn;
}

async function callSpawn(
  opts: Pick<SpawnClaudeOptions, "prompt" | "systemPrompt" | "model" | "effort">,
): Promise<SpawnClaudeResult> {
  if (_spawnHook) return _spawnHook(opts);
  return spawnClaude(opts);
}

// ── Reviewer prompts ────────────────────────────────────────

const REVIEWER_SYSTEM_PROMPTS: Record<ReviewerRole, string> = {
  security: [
    "Tu es un expert en sécurité logicielle.",
    "Analyse le code pour identifier :",
    "- Injections (SQL, commandes, XSS)",
    "- Failles d'authentification/autorisation",
    "- Secrets exposés (tokens, clés API)",
    "- Dépendances vulnérables",
    "- Validation d'entrée insuffisante",
    "",
    "IMPORTANT: Si tu trouves un problème de sécurité critique, exerce ton VETO.",
    "Un veto bloque le merge même si les autres reviewers approuvent.",
  ].join("\n"),
  performance: [
    "Tu es un expert en performance logicielle.",
    "Analyse le code pour identifier :",
    "- Boucles N+1 ou requêtes non optimisées",
    "- Fuites mémoire potentielles",
    "- Appels synchrones bloquants",
    "- Absence de pagination/limites",
    "- Complexité algorithmique excessive",
    "",
    "Tu ne peux pas exercer de veto. Tes findings sont consultatifs.",
  ].join("\n"),
  architecture: [
    "Tu es un expert en architecture logicielle.",
    "Analyse le code pour identifier :",
    "- Violations des conventions du projet (barrel pattern, logger, config)",
    "- Couplage excessif entre modules",
    "- Duplications de logique",
    "- Inconsistance avec les patterns existants",
    "- Tests manquants ou insuffisants",
    "",
    "Tu ne peux pas exercer de veto. Tes findings sont consultatifs.",
  ].join("\n"),
};

/** Build the review prompt for a specific reviewer role */
export function buildReviewPrompt(
  role: ReviewerRole,
  specPath: string,
  branchName: string,
  prUrl: string | undefined,
  previousFindings: string,
): string {
  const parts = [
    `REVIEW SPÉCIALISÉE — ${role.toUpperCase()}`,
    "",
    `Spec de référence: ${specPath}`,
    `Branche: ${branchName}`,
  ];

  if (prUrl) {
    parts.push(`PR: ${prUrl}`);
  }

  if (previousFindings) {
    parts.push("", "Findings des itérations précédentes:", previousFindings);
  }

  parts.push(
    "",
    "Instructions:",
    "- Lis les fichiers modifiés sur la branche courante",
    "- Analyse le code selon ta spécialité",
    "- Identifie les problèmes avec leur sévérité: [CRITIQUE], [MAJEUR], [MINEUR]",
    "",
    "Format de reponse obligatoire (derniere ligne):",
    "VERDICT: APPROVED",
    "ou",
    "VERDICT: CHANGES_REQUESTED",
    "",
  );

  // Security-specific: veto instruction
  if (role === "security") {
    parts.push(
      "Si tu trouves un problème [CRITIQUE], ajoute sur une ligne séparée:",
      "VETO: <raison>",
      "",
    );
  }

  return parts.join("\n");
}

// ── Verdict extraction (F-TC-2: fail-closed) ───────────────

/**
 * Extract verdict from reviewer output.
 * F-TC-2 fix: if parsing fails, returns CHANGES_REQUESTED (fail-closed).
 * Never returns silent GO on parse failure.
 */
export function extractReviewerVerdict(output: string): ReviewVerdict {
  // Use last occurrence to avoid false positives (F-EC-1 pattern)
  const matches = [...output.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)];
  const lastMatch = matches.at(-1);
  if (!lastMatch) {
    // F-TC-2: fail-closed — no verdict found = CHANGES_REQUESTED
    log.warn("No verdict found in reviewer output — fail-closed to CHANGES_REQUESTED");
    return "CHANGES_REQUESTED";
  }
  return lastMatch[1].toUpperCase() as ReviewVerdict;
}

/**
 * Check if the security reviewer exercised a veto.
 * Only the security reviewer can veto (hierarchical veto model).
 */
export function extractVeto(output: string, role: ReviewerRole): boolean {
  if (role !== "security") return false;
  return /VETO:\s*.+/i.test(output);
}

// ── Panel execution ─────────────────────────────────────────

/**
 * Run the multi-critic panel: spawn 3 reviewer agents in parallel,
 * collect verdicts, apply quorum and veto logic.
 */
export async function runReviewPanel(
  specPath: string,
  branchName: string,
  prUrl: string | undefined,
  previousFindings: string,
): Promise<PanelVerdict> {
  const promises = ALL_REVIEWER_ROLES.map(async (role): Promise<ReviewerFinding> => {
    const prompt = buildReviewPrompt(role, specPath, branchName, prUrl, previousFindings);
    const systemPrompt = REVIEWER_SYSTEM_PROMPTS[role];

    try {
      const result = await callSpawn({
        prompt,
        systemPrompt,
        model: "claude-sonnet-4-6",
        effort: "medium",
      });

      if (result.exitCode !== 0 || !result.stdout.trim()) {
        log.error(`Reviewer ${role} failed`, { exitCode: result.exitCode, stderr: result.stderr });
        // F-TC-2: agent crash = CHANGES_REQUESTED (fail-closed)
        return {
          role,
          verdict: "CHANGES_REQUESTED",
          findings: `Agent ${role} crash: ${(result.stderr || "empty output").substring(0, 500)}`,
          veto: false,
        };
      }

      const verdict = extractReviewerVerdict(result.stdout);
      const veto = extractVeto(result.stdout, role);

      return {
        role,
        verdict,
        findings: result.stdout.trim(),
        veto,
      };
    } catch (err) {
      log.error(`Reviewer ${role} exception`, { error: String(err) });
      // F-TC-2: exception = CHANGES_REQUESTED (fail-closed)
      return {
        role,
        verdict: "CHANGES_REQUESTED",
        findings: `Agent ${role} exception: ${String(err).substring(0, 500)}`,
        veto: false,
      };
    }
  });

  const findings = await Promise.allSettled(promises);

  const resolvedFindings: ReviewerFinding[] = findings.map((settled, i) => {
    if (settled.status === "fulfilled") return settled.value;
    // Promise.allSettled rejection (should not happen since we catch inside)
    return {
      role: ALL_REVIEWER_ROLES[i],
      verdict: "CHANGES_REQUESTED" as ReviewVerdict,
      findings: `Promise rejected: ${String(settled.reason).substring(0, 500)}`,
      veto: false,
    };
  });

  return computePanelVerdict(resolvedFindings);
}

/**
 * Compute the panel verdict from individual reviewer findings.
 * Rules:
 * 1. If any reviewer exercised a veto -> CHANGES_REQUESTED (hierarchical veto)
 * 2. If APPROVED count >= QUORUM_THRESHOLD (2/3) -> APPROVED
 * 3. Otherwise -> CHANGES_REQUESTED
 */
export function computePanelVerdict(findings: ReviewerFinding[]): PanelVerdict {
  const vetoed = findings.some((f) => f.veto);
  const approvedCount = findings.filter((f) => f.verdict === "APPROVED").length;
  const totalResponded = findings.length;

  // Collect change requests for the fix agent
  const changeRequests = findings
    .filter((f) => f.verdict === "CHANGES_REQUESTED")
    .map((f) => `### ${f.role.toUpperCase()}\n${f.findings}`)
    .join("\n\n---\n\n");

  // Rule 1: Veto overrides quorum
  if (vetoed) {
    return {
      verdict: "CHANGES_REQUESTED",
      approvedCount,
      totalResponded,
      vetoed: true,
      findings,
      changeRequests,
    };
  }

  // Rule 2: Quorum check
  if (approvedCount >= QUORUM_THRESHOLD) {
    return {
      verdict: "APPROVED",
      approvedCount,
      totalResponded,
      vetoed: false,
      findings,
      changeRequests: "",
    };
  }

  // Rule 3: No quorum
  return {
    verdict: "CHANGES_REQUESTED",
    approvedCount,
    totalResponded,
    vetoed: false,
    findings,
    changeRequests,
  };
}
