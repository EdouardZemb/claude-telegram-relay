/**
 * @module spec-lite
 * @description P1 — Lightweight spec phase: generates a proto-spec with V-criteria
 * and impacted files before orchestration. Behind feature flag `spec_phase_lite`.
 */

import { spawnClaude } from "./agent.ts";
import type { Task } from "./tasks.ts";
import type { ProtoSpec } from "./agent-schemas.ts";

// ── Types ────────────────────────────────────────────────────

export interface StoryFileInput {
  acceptanceCriteria: string[];
  implementationSteps: string[];
  testStubs: string[];
  impactedFiles: string[];
}

// ── Proto-Spec Generation ────────────────────────────────────

/**
 * Generate a lightweight proto-spec from a task and its story file.
 * Uses haiku model for speed (target < 60s).
 *
 * R2: Produces objective (1-2 phrases), 3-5 V-criteria, impacted files list.
 * R3: No user interview — auto-sufficient from task + story file + context.
 * R11: Max 2 minutes (haiku keeps it under 60s).
 * V1: Returns valid ProtoSpec with 3-5 V-criteria.
 * V2: Returns default ProtoSpec on spawnClaude failure.
 */
export async function generateProtoSpec(
  task: Task,
  storyFile: StoryFileInput | null,
  agentContext?: string
): Promise<ProtoSpec> {
  const startTime = Date.now();

  const storySection = storyFile
    ? [
        "STORY FILE:",
        `Acceptance Criteria: ${storyFile.acceptanceCriteria.join("; ")}`,
        `Implementation Steps: ${storyFile.implementationSteps.join("; ")}`,
        `Test Stubs: ${storyFile.testStubs.join("; ")}`,
        `Impacted Files: ${storyFile.impactedFiles.join(", ")}`,
      ].join("\n")
    : "";

  const prompt = [
    "Tu es un agent spec-lite. Genere une proto-spec COURTE et PRECISE pour cette tache.",
    "",
    "TACHE:",
    `Titre: ${task.title}`,
    `Description: ${task.description || "Pas de description"}`,
    task.acceptance_criteria ? `Criteres d'acceptation: ${task.acceptance_criteria}` : "",
    "",
    storySection,
    "",
    agentContext ? `CONTEXTE:\n${agentContext}` : "",
    "",
    "INSTRUCTIONS:",
    "Produis un JSON avec exactement cette structure:",
    "{",
    '  "objective": "1-2 phrases decrivant l\'objectif de la tache",',
    '  "v_criteria": [',
    '    { "id": "V1", "description": "assertion testable", "level": "unit|integration|E2E" }',
    "  ],",
    '  "impacted_files": ["src/module.ts"]',
    "}",
    "",
    "Regles:",
    "- 3 a 5 V-criteres obligatoires",
    "- Chaque V-critere est une assertion testable avec notation [Vx]",
    "- Les fichiers impactes sont deduits du story file et de l'analyse",
    "- Pas de texte hors du JSON",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await spawnClaude({
      prompt,
      model: "claude-haiku-4-5",
      effort: "low",
    });

    if (result.exitCode !== 0 || !result.stdout) {
      console.warn("spec-lite: spawnClaude failed, returning default proto-spec");
      return buildDefaultProtoSpec(task, startTime);
    }

    return parseProtoSpec(result.stdout, task, startTime);
  } catch (error) {
    console.error("spec-lite error:", error);
    return buildDefaultProtoSpec(task, startTime);
  }
}

// ── Parsing ──────────────────────────────────────────────────

/**
 * Parse the agent output into a ProtoSpec.
 * Falls back to default on parse failure.
 */
export function parseProtoSpec(
  output: string,
  task: Task,
  startTime: number
): ProtoSpec {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(output);
    return normalizeProtoSpec(parsed, startTime);
  } catch {
    // Try to extract JSON from mixed output
  }

  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeProtoSpec(parsed, startTime);
    } catch {
      // Fall through
    }
  }

  console.warn("spec-lite: could not parse agent output, returning default");
  return buildDefaultProtoSpec(task, startTime);
}

/**
 * Normalize a parsed object into a valid ProtoSpec.
 */
function normalizeProtoSpec(obj: any, startTime: number): ProtoSpec {
  const objective =
    typeof obj.objective === "string" && obj.objective.length > 0
      ? obj.objective
      : "Objectif non specifie";

  let vCriteria: ProtoSpec["v_criteria"] = [];
  if (Array.isArray(obj.v_criteria)) {
    vCriteria = obj.v_criteria
      .filter(
        (c: any) =>
          c &&
          typeof c.id === "string" &&
          typeof c.description === "string"
      )
      .map((c: any) => ({
        id: c.id,
        description: c.description,
        level: ["unit", "integration", "E2E"].includes(c.level) ? c.level : "unit",
      }))
      .slice(0, 5); // Max 5
  }

  const impactedFiles: string[] = Array.isArray(obj.impacted_files)
    ? obj.impacted_files.filter((f: any) => typeof f === "string")
    : [];

  return {
    objective,
    v_criteria: vCriteria,
    impacted_files: impactedFiles,
    generated_at: new Date().toISOString(),
    agent_model: "claude-haiku-4-5",
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Build a default proto-spec when agent fails.
 * V2: objective = task title, 0 V-criteria.
 */
function buildDefaultProtoSpec(task: Task, startTime: number): ProtoSpec {
  return {
    objective: task.title,
    v_criteria: [],
    impacted_files: [],
    generated_at: new Date().toISOString(),
    agent_model: "claude-haiku-4-5",
    duration_ms: Date.now() - startTime,
  };
}
