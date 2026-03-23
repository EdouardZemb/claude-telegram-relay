/**
 * @module adversarial-challenge
 * @description P2 — Adversarial challenge (Devil's Advocate) + E1 — Impact Analysis.
 * Detects blocking problems before implementation. Behind feature flag `adversarial_challenge`.
 */

import { spawnClaude } from "./agent.ts";
import type { AdversarialResult, ImpactAnalysisResult, ProtoSpec } from "./agent-schemas.ts";
import { type CodeGraph, getGraph, getImpactRadius } from "./code-graph.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("adversarial-challenge");
// ── Types ────────────────────────────────────────────────────

export interface AdversarialInput {
  /** Proto-spec from P1 (if available) */
  protoSpec?: ProtoSpec | null;
  /** Architect or planner output (fallback when P1 is off) */
  agentOutput?: string;
  /** Task title for context */
  taskTitle: string;
  /** Task description for context */
  taskDescription?: string;
}

// ── Adversarial Challenge (P2) ───────────────────────────────

/**
 * Run the Devil's Advocate adversarial challenge.
 * Analyzes spec/plan for blocking problems before dev implementation.
 *
 * R6: Uses a single agent (Devil's Advocate) with max 10 findings.
 * R7: Returns verdict PAUSE when bloquants >= 1.
 * V3: Parses Devil's Advocate output into AdversarialResult.
 * V4: Returns verdict PASS with 0 findings on agent failure (fail-safe).
 *      F-DA-3: Returns verdict SKIPPED (not PASS) on agent failure.
 * V5: PAUSE when bloquants >= 1, PASS otherwise.
 */
export async function runAdversarialChallenge(
  input: AdversarialInput,
  agentContext?: string,
): Promise<AdversarialResult> {
  const startTime = Date.now();

  const specSection = input.protoSpec
    ? [
        "PROTO-SPEC:",
        `Objectif: ${input.protoSpec.objective}`,
        "V-Criteres:",
        ...input.protoSpec.v_criteria.map((c) => `  [${c.id}] ${c.description} (${c.level})`),
        `Fichiers impactes: ${input.protoSpec.impacted_files.join(", ")}`,
      ].join("\n")
    : "";

  const agentOutputSection = input.agentOutput
    ? `SORTIE AGENT (architect/planner):\n${input.agentOutput.substring(0, 15000)}`
    : "";

  const prompt = [
    "Tu es un DEVIL'S ADVOCATE. Ton role est de trouver les failles BLOQUANTES",
    "dans la specification ou le plan AVANT l'implementation.",
    "",
    `TACHE: ${input.taskTitle}`,
    input.taskDescription ? `Description: ${input.taskDescription}` : "",
    "",
    specSection,
    agentOutputSection,
    "",
    agentContext ? `CONTEXTE:\n${agentContext}` : "",
    "",
    "INSTRUCTIONS:",
    "Analyse les risques, incoherences, et failles logiques.",
    "Classe chaque finding par severite: BLOQUANT, MAJEUR, ou MINEUR.",
    "Maximum 10 findings.",
    "",
    "Produis un JSON avec cette structure:",
    "{",
    '  "findings": [',
    '    { "id": "F-DA-1", "severity": "BLOQUANT|MAJEUR|MINEUR", "title": "titre court", "description": "detail", "source": "section concernee" }',
    "  ]",
    "}",
    "",
    "Si aucun probleme: retourne un tableau findings vide.",
    "Pas de texte hors du JSON.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await spawnClaude({
      prompt,
      model: "claude-sonnet-4-20250514",
      effort: "medium",
    });

    if (result.exitCode !== 0 || !result.stdout) {
      // F-DA-3: Distinguish SKIPPED from PASS — agent failed to run
      log.warn("adversarial-challenge: spawnClaude failed, returning SKIPPED");
      return {
        findings: [],
        stats: { bloquants: 0, majeurs: 0, mineurs: 0 },
        verdict: "SKIPPED",
        duration_ms: Date.now() - startTime,
      };
    }

    return parseAdversarialResult(result.stdout, startTime);
  } catch (error) {
    log.error("adversarial-challenge error", { error: String(error) });
    // F-DA-3: SKIPPED on error, not PASS
    return {
      findings: [],
      stats: { bloquants: 0, majeurs: 0, mineurs: 0 },
      verdict: "SKIPPED",
      duration_ms: Date.now() - startTime,
    };
  }
}

/**
 * Parse the Devil's Advocate output into an AdversarialResult.
 */
export function parseAdversarialResult(output: string, startTime: number): AdversarialResult {
  let findings: AdversarialResult["findings"] = [];

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed.findings)) {
      findings = normalizeFindings(parsed.findings);
    }
  } catch {
    // R5: parse failure → fallback
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.findings)) {
          findings = normalizeFindings(parsed.findings);
        }
      } catch {
        // R5: parse failure → fallback
      }
    }
  }

  const stats = {
    bloquants: findings.filter((f) => f.severity === "BLOQUANT").length,
    majeurs: findings.filter((f) => f.severity === "MAJEUR").length,
    mineurs: findings.filter((f) => f.severity === "MINEUR").length,
  };

  // V5: PAUSE if bloquants >= 1, PASS otherwise
  const verdict = stats.bloquants >= 1 ? "PAUSE" : "PASS";

  return {
    findings,
    stats,
    verdict,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Normalize findings array: validate fields, cap at 10.
 */
function normalizeFindings(raw: unknown[]): AdversarialResult["findings"] {
  return raw
    .filter((f): f is Record<string, unknown> => f !== null && typeof f === "object")
    .map((f: Record<string, unknown>, i: number) => ({
      id: typeof f.id === "string" ? f.id : `F-DA-${i + 1}`,
      severity:
        typeof f.severity === "string" && ["BLOQUANT", "MAJEUR", "MINEUR"].includes(f.severity)
          ? (f.severity as "BLOQUANT" | "MAJEUR" | "MINEUR")
          : "MINEUR",
      title: typeof f.title === "string" ? f.title : "Finding sans titre",
      description: typeof f.description === "string" ? f.description : "",
      source: typeof f.source === "string" ? f.source : "",
    }))
    .slice(0, 10); // Max 10 findings
}

// ── Impact Analysis (E1) ─────────────────────────────────────

/**
 * Run impact analysis combining zero-LLM code graph + optional agent.
 *
 * R15: Launched in parallel with P2 via Promise.all.
 * R16: Produces risk_level (LOW/MEDIUM/HIGH), modules counts, breaking changes.
 * R17: Advisory only — never blocks the pipeline.
 * R23: Uses getImpactRadius() zero-LLM. Only spawns agent if >= 3 files impacted.
 * V19: Returns full ImpactAnalysisResult when >= 3 files impacted.
 * V20: Returns graph_only result when < 3 files.
 * V21: Returns LOW with 0 modules if graph unavailable.
 */
export async function runImpactAnalysis(
  impactedFiles: string[],
  agentContext?: string,
): Promise<ImpactAnalysisResult> {
  const startTime = Date.now();

  if (!impactedFiles || impactedFiles.length === 0) {
    // V21: No files — return LOW, 0 modules
    return {
      risk_level: "LOW",
      modules_impacted_direct: 0,
      modules_impacted_transitive: 0,
      breaking_changes: [],
      attention_points: [],
      graph_only: true,
      duration_ms: Date.now() - startTime,
    };
  }

  // Zero-LLM: use code-graph for static analysis
  let graph: CodeGraph | null = null;
  try {
    graph = getGraph();
  } catch {
    // R8: business error → log.warn
    // V21: Graph unavailable
    log.warn("adversarial-challenge: code-graph not available");
    return {
      risk_level: "LOW",
      modules_impacted_direct: 0,
      modules_impacted_transitive: 0,
      breaking_changes: [],
      attention_points: [],
      graph_only: true,
      duration_ms: Date.now() - startTime,
    };
  }

  // Calculate impact radius for all impacted files
  const allImpacted = new Set<string>();
  const directImpacted = new Set<string>();

  for (const file of impactedFiles) {
    // Normalize file path to module ID (strip src/ prefix, .ts suffix)
    const moduleId = file.replace(/^src\//, "").replace(/\.ts$/, "");

    const impacts = getImpactRadius(graph, moduleId, 3);
    for (const impact of impacts) {
      allImpacted.add(impact.module);
      if (impact.distance === 1) {
        directImpacted.add(impact.module);
      }
    }
  }

  const directCount = directImpacted.size;
  const transitiveCount = allImpacted.size;

  // R23: If < 3 files impacted, return zero-LLM result only
  if (impactedFiles.length < 3) {
    const riskLevel = directCount <= 1 ? "LOW" : directCount <= 3 ? "MEDIUM" : "HIGH";
    return {
      risk_level: riskLevel,
      modules_impacted_direct: directCount,
      modules_impacted_transitive: transitiveCount,
      breaking_changes: [],
      attention_points: [],
      graph_only: true,
      duration_ms: Date.now() - startTime,
    };
  }

  // >= 3 files impacted: spawn agent for semantic analysis
  try {
    const agentResult = await spawnImpactAgent(
      impactedFiles,
      Array.from(allImpacted),
      agentContext,
    );

    return {
      risk_level:
        agentResult.risk_level || (directCount <= 1 ? "LOW" : directCount <= 3 ? "MEDIUM" : "HIGH"),
      modules_impacted_direct: directCount,
      modules_impacted_transitive: transitiveCount,
      breaking_changes: agentResult.breaking_changes || [],
      attention_points: agentResult.attention_points || [],
      graph_only: false,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    // R17: Advisory — agent failure is not blocking
    log.warn("adversarial-challenge: impact agent failed, using graph-only result", {
      error: String(error),
    });
    const riskLevel = directCount <= 1 ? "LOW" : directCount <= 3 ? "MEDIUM" : "HIGH";
    return {
      risk_level: riskLevel,
      modules_impacted_direct: directCount,
      modules_impacted_transitive: transitiveCount,
      breaking_changes: [],
      attention_points: [],
      graph_only: true,
      duration_ms: Date.now() - startTime,
    };
  }
}

/**
 * Spawn haiku agent for semantic impact analysis.
 */
async function spawnImpactAgent(
  impactedFiles: string[],
  transitiveModules: string[],
  agentContext?: string,
): Promise<{
  risk_level?: "LOW" | "MEDIUM" | "HIGH";
  breaking_changes?: string[];
  attention_points?: string[];
}> {
  const prompt = [
    "Tu es un IMPACT ANALYST. Analyse le blast radius de cette modification.",
    "",
    `Fichiers directement modifies: ${impactedFiles.join(", ")}`,
    `Modules impactes transitivement: ${transitiveModules.slice(0, 20).join(", ")}`,
    "",
    agentContext ? `CONTEXTE:\n${agentContext}` : "",
    "",
    "Produis un JSON:",
    "{",
    '  "risk_level": "LOW|MEDIUM|HIGH",',
    '  "breaking_changes": ["description du breaking change"],',
    '  "attention_points": ["point d\'attention"]',
    "}",
    "",
    "Pas de texte hors du JSON.",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await spawnClaude({
    prompt,
    model: "claude-haiku-4-5",
    effort: "low",
  });

  if (result.exitCode !== 0 || !result.stdout) {
    return {};
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return parsed;
  } catch {
    // R5: parse failure → fallback
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // R5: parse failure → fallback
        return {};
      }
    }
    return {};
  }
}
