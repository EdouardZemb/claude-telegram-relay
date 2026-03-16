/**
 * @module agent-schemas
 * @description Typed JSON output schemas per agent role, parsing, structured chain context.
 */

/**
 * Structured Agent Message Schemas — S22-01/02
 *
 * Defines typed JSON output schemas for each BMad agent role.
 * Replaces raw text concatenation with structured message passing
 * between agents in the orchestration pipeline.
 *
 * Each agent produces a typed output that downstream agents can parse
 * and extract exactly what they need.
 */

import type { AgentRole } from "./orchestrator.ts";

// ── Per-Role Output Schemas ──────────────────────────────────

export interface AnalystOutput {
  role: "analyst";
  analysis: string;
  risks: Array<{
    severity: "high" | "medium" | "low";
    description: string;
  }>;
  recommendations: string[];
  dependencies: string[];
  feasibility: "high" | "medium" | "low";
}

export interface PmOutput {
  role: "pm";
  subtasks: Array<{
    title: string;
    description: string;
    priority: number;
    acceptance_criteria: string;
    dependencies?: string[];
  }>;
  priorities: string[];
  risks: string[];
}

export interface ArchitectOutput {
  role: "architect";
  design: string;
  components: Array<{
    name: string;
    responsibility: string;
    interactions: string[];
  }>;
  files_impacted: string[];
  patterns: string[];
  technical_risks: string[];
  decisions: Array<{
    decision: string;
    rationale: string;
    alternatives: string[];
  }>;
}

export interface DevOutput {
  role: "dev";
  files_modified: string[];
  tests_added: string[];
  summary: string;
  issues_encountered: string[];
}

export interface QaOutput {
  role: "qa";
  score: number;
  findings: Array<{
    severity: "critical" | "important" | "minor" | "suggestion";
    description: string;
    suggestion: string;
    file?: string;
  }>;
  summary: string;
  tests_missing: string[];
}

export interface SmOutput {
  role: "sm";
  summary: string;
  blockers: string[];
  next_steps: string[];
  follow_ups: string[];
}

/** Union of all structured agent outputs */
export type StructuredAgentOutput =
  | AnalystOutput
  | PmOutput
  | ArchitectOutput
  | DevOutput
  | QaOutput
  | SmOutput;

// ── AgentMessage: wrapper around structured output ───────────

export interface AgentMessage {
  agentId: AgentRole;
  agentName: string;
  success: boolean;
  structured: StructuredAgentOutput | null;
  rawOutput: string;
  durationMs: number;
  error?: string;
}

// ── JSON Schema Descriptions (for injection into prompts) ────

const SCHEMA_DESCRIPTIONS: Record<AgentRole, string> = {
  analyst: `{
  "role": "analyst",
  "analysis": "resume de l'analyse (2-3 paragraphes)",
  "risks": [{"severity": "high|medium|low", "description": "..."}],
  "recommendations": ["action 1", "action 2"],
  "dependencies": ["module ou systeme dont la tache depend"],
  "feasibility": "high|medium|low"
}`,
  pm: `{
  "role": "pm",
  "subtasks": [{
    "title": "titre court imperatif",
    "description": "contexte technique 1-2 phrases",
    "priority": 1,
    "acceptance_criteria": "Given/When/Then",
    "dependencies": ["autre sous-tache"]
  }],
  "priorities": ["priorite strategique 1"],
  "risks": ["risque identifie 1"]
}`,
  architect: `{
  "role": "architect",
  "design": "description de l'architecture proposee",
  "components": [{
    "name": "nom du composant",
    "responsibility": "sa responsabilite",
    "interactions": ["composant avec lequel il interagit"]
  }],
  "files_impacted": ["src/fichier.ts"],
  "patterns": ["pattern a suivre"],
  "technical_risks": ["risque technique"],
  "decisions": [{
    "decision": "choix fait",
    "rationale": "pourquoi",
    "alternatives": ["option rejetee"]
  }]
}`,
  dev: `{
  "role": "dev",
  "files_modified": ["src/fichier.ts"],
  "tests_added": ["tests/fichier.test.ts"],
  "summary": "resume de ce qui a ete fait",
  "issues_encountered": ["probleme rencontre et comment resolu"]
}`,
  qa: `{
  "role": "qa",
  "score": 85,
  "findings": [{
    "severity": "critical|important|minor|suggestion",
    "description": "probleme identifie",
    "suggestion": "correction proposee",
    "file": "src/fichier.ts"
  }],
  "summary": "resume de la review",
  "tests_missing": ["test manquant"]
}`,
  sm: `{
  "role": "sm",
  "summary": "synthese globale",
  "blockers": ["blocage actuel"],
  "next_steps": ["prochaine etape"],
  "follow_ups": ["point de suivi"]
}`,
};

/**
 * Get the JSON schema description for an agent role.
 * Used to inject into agent prompts so they produce structured output.
 */
export function getSchemaForRole(role: AgentRole): string {
  return SCHEMA_DESCRIPTIONS[role] || "";
}

// ── JSON Schema for --json-schema flag (S28-T4) ─────────────

/** Standard JSON Schemas for Claude CLI --json-schema flag */
const JSON_SCHEMAS: Record<string, object> = {
  analyst: {
    type: "object",
    properties: {
      role: { type: "string", const: "analyst" },
      analysis: { type: "string" },
      risks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["high", "medium", "low"] },
            description: { type: "string" },
          },
          required: ["severity", "description"],
        },
      },
      recommendations: { type: "array", items: { type: "string" } },
      dependencies: { type: "array", items: { type: "string" } },
      feasibility: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["role", "analysis", "risks", "recommendations"],
  },
  pm: {
    type: "object",
    properties: {
      role: { type: "string", const: "pm" },
      subtasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "number" },
            acceptance_criteria: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
          },
          required: ["title", "description", "priority"],
        },
      },
      priorities: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
    },
    required: ["role", "subtasks", "priorities"],
  },
  architect: {
    type: "object",
    properties: {
      role: { type: "string", const: "architect" },
      design: { type: "string" },
      components: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            responsibility: { type: "string" },
            interactions: { type: "array", items: { type: "string" } },
          },
          required: ["name", "responsibility"],
        },
      },
      files_impacted: { type: "array", items: { type: "string" } },
      patterns: { type: "array", items: { type: "string" } },
      technical_risks: { type: "array", items: { type: "string" } },
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            decision: { type: "string" },
            rationale: { type: "string" },
            alternatives: { type: "array", items: { type: "string" } },
          },
          required: ["decision", "rationale"],
        },
      },
    },
    required: ["role", "design", "files_impacted"],
  },
  dev: {
    type: "object",
    properties: {
      role: { type: "string", const: "dev" },
      files_modified: { type: "array", items: { type: "string" } },
      tests_added: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
      issues_encountered: { type: "array", items: { type: "string" } },
    },
    required: ["role", "files_modified", "summary"],
  },
  qa: {
    type: "object",
    properties: {
      role: { type: "string", const: "qa" },
      score: { type: "number", minimum: 0, maximum: 100 },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "important", "minor", "suggestion"] },
            description: { type: "string" },
            suggestion: { type: "string" },
            file: { type: "string" },
          },
          required: ["severity", "description", "suggestion"],
        },
      },
      summary: { type: "string" },
      tests_missing: { type: "array", items: { type: "string" } },
    },
    required: ["role", "score", "findings", "summary"],
  },
  sm: {
    type: "object",
    properties: {
      role: { type: "string", const: "sm" },
      summary: { type: "string" },
      blockers: { type: "array", items: { type: "string" } },
      next_steps: { type: "array", items: { type: "string" } },
      follow_ups: { type: "array", items: { type: "string" } },
    },
    required: ["role", "summary", "next_steps"],
  },
  gate_evaluation: {
    type: "object",
    properties: {
      pass: { type: "boolean" },
      score: { type: "number", minimum: 0, maximum: 100 },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "major", "minor"] },
            description: { type: "string" },
            suggestion: { type: "string" },
          },
          required: ["severity", "description"],
        },
      },
      gate_name: { type: "string" },
    },
    required: ["pass", "score", "issues", "gate_name"],
  },
  drift_report: {
    type: "object",
    properties: {
      coverage_score: { type: "number", minimum: 0, maximum: 100 },
      drift_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fr_id: { type: "string" },
            status: { type: "string", enum: ["implemented", "missing", "partial", "divergent"] },
            details: { type: "string" },
          },
          required: ["fr_id", "status", "details"],
        },
      },
      overall_verdict: { type: "string", enum: ["pass", "fail", "warning"] },
    },
    required: ["coverage_score", "drift_items", "overall_verdict"],
  },
};

/**
 * Get the JSON Schema for a role, suitable for --json-schema flag.
 * S28: Returns a standard JSON Schema object for Claude CLI structured output.
 */
export function getJsonSchemaForRole(role: string): object | null {
  return JSON_SCHEMAS[role] || null;
}

/**
 * Build the structured output instruction block for an agent prompt.
 * Tells the agent to wrap its output in a JSON block.
 */
export function buildStructuredOutputInstructions(role: AgentRole): string {
  const schema = getSchemaForRole(role);
  if (!schema) return "";

  return [
    "",
    "FORMAT DE SORTIE OBLIGATOIRE:",
    "Tu DOIS produire ta reponse au format JSON structure.",
    "Entoure ton JSON avec les marqueurs <<<JSON>>> et <<<END>>>.",
    "Tu peux ecrire du texte libre avant et apres les marqueurs, mais le JSON est obligatoire.",
    "",
    "Schema attendu:",
    schema,
    "",
    "Exemple:",
    "<<<JSON>>>",
    schema,
    "<<<END>>>",
  ].join("\n");
}

// ── Parsing ──────────────────────────────────────────────────

/**
 * Extract structured JSON from agent raw output.
 * S28: First tries direct JSON parse (for --output-format json output).
 * Then looks for <<<JSON>>> ... <<<END>>> markers.
 * Falls back to finding any JSON object in the output.
 */
export function parseAgentOutput(
  rawOutput: string,
  role: AgentRole
): StructuredAgentOutput | null {
  // S28: Try direct JSON parse first (output from --output-format json)
  try {
    const direct = JSON.parse(rawOutput);
    if (validateAgentOutput(direct, role)) {
      return { ...direct, role } as StructuredAgentOutput;
    }
  } catch {
    // Not direct JSON, fall through to marker-based parsing
  }

  // Try marked JSON (<<<JSON>>> markers — legacy fallback)
  const markerMatch = rawOutput.match(
    /<<<JSON>>>\s*([\s\S]*?)\s*<<<END>>>/
  );
  if (markerMatch) {
    try {
      const parsed = JSON.parse(markerMatch[1].trim());
      if (validateAgentOutput(parsed, role)) {
        return { ...parsed, role } as StructuredAgentOutput;
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: find the largest JSON object in the output
  const jsonMatches = findJsonObjects(rawOutput);
  for (const jsonStr of jsonMatches) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (validateAgentOutput(parsed, role)) {
        return { ...parsed, role } as StructuredAgentOutput;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Find JSON object strings in text, sorted by length (largest first).
 */
function findJsonObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        results.push(text.substring(start, i + 1));
        start = -1;
      }
    }
  }

  // Sort by length descending (largest JSON objects first)
  return results.sort((a, b) => b.length - a.length);
}

/**
 * Validate that a parsed object matches the expected schema for a role.
 * Checks for required fields — lenient validation (missing optional fields are OK).
 */
export function validateAgentOutput(
  obj: any,
  role: AgentRole
): boolean {
  if (!obj || typeof obj !== "object") return false;

  switch (role) {
    case "analyst":
      return (
        typeof obj.analysis === "string" &&
        Array.isArray(obj.risks) &&
        Array.isArray(obj.recommendations)
      );
    case "pm":
      return (
        Array.isArray(obj.subtasks) &&
        Array.isArray(obj.priorities)
      );
    case "architect":
      return (
        typeof obj.design === "string" &&
        Array.isArray(obj.files_impacted)
      );
    case "dev":
      return (
        Array.isArray(obj.files_modified) &&
        typeof obj.summary === "string"
      );
    case "qa":
      return (
        typeof obj.score === "number" &&
        Array.isArray(obj.findings) &&
        typeof obj.summary === "string"
      );
    case "sm":
      return (
        typeof obj.summary === "string" &&
        Array.isArray(obj.next_steps)
      );
    default:
      return false;
  }
}

// ── Context Builder for Downstream Agents ────────────────────

/**
 * Build structured context from previous agent messages.
 * Instead of dumping raw text, extracts relevant fields per role.
 */
export function buildStructuredChainContext(
  messages: AgentMessage[]
): string {
  if (messages.length === 0) return "";

  const parts: string[] = ["CONTEXTE STRUCTURE DES AGENTS PRECEDENTS:"];

  for (const msg of messages) {
    if (!msg.success) continue;

    parts.push("");
    parts.push(`--- ${msg.agentName} (${msg.agentId}) ---`);

    if (msg.structured) {
      parts.push(formatStructuredOutput(msg.structured));
    } else {
      // Fallback to raw output (truncated)
      const truncated = msg.rawOutput.substring(0, 2000);
      parts.push(truncated);
      if (msg.rawOutput.length > 2000) parts.push("...(tronque)");
    }
  }

  parts.push("");
  parts.push("Utilise ces outputs comme base. Ne repete pas ce qui a deja ete fait.");

  return parts.join("\n");
}

/**
 * Format a structured output for inclusion in downstream context.
 * Extracts the most relevant fields per role.
 */
export function formatStructuredOutput(output: StructuredAgentOutput): string {
  switch (output.role) {
    case "analyst":
      return [
        `Analyse: ${output.analysis}`,
        `Faisabilite: ${output.feasibility}`,
        output.risks.length > 0
          ? `Risques: ${output.risks.map((r) => `[${r.severity}] ${r.description}`).join("; ")}`
          : "",
        output.recommendations.length > 0
          ? `Recommandations: ${output.recommendations.join("; ")}`
          : "",
        output.dependencies.length > 0
          ? `Dependances: ${output.dependencies.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "pm":
      return [
        `Sous-taches (${output.subtasks.length}):`,
        ...output.subtasks.map(
          (st, i) =>
            `  ${i + 1}. [P${st.priority}] ${st.title}: ${st.description}`
        ),
        output.risks.length > 0 ? `Risques: ${output.risks.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "architect":
      return [
        `Design: ${output.design}`,
        output.components.length > 0
          ? `Composants: ${output.components.map((c) => `${c.name} (${c.responsibility})`).join(", ")}`
          : "",
        output.files_impacted.length > 0
          ? `Fichiers: ${output.files_impacted.join(", ")}`
          : "",
        output.decisions.length > 0
          ? `Decisions: ${output.decisions.map((d) => `${d.decision} (${d.rationale})`).join("; ")}`
          : "",
        output.technical_risks.length > 0
          ? `Risques techniques: ${output.technical_risks.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "dev":
      return [
        `Resume: ${output.summary}`,
        output.files_modified.length > 0
          ? `Fichiers modifies: ${output.files_modified.join(", ")}`
          : "",
        output.tests_added.length > 0
          ? `Tests ajoutes: ${output.tests_added.join(", ")}`
          : "",
        output.issues_encountered.length > 0
          ? `Problemes: ${output.issues_encountered.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "qa":
      return [
        `Score: ${output.score}/100`,
        `Resume: ${output.summary}`,
        output.findings.length > 0
          ? `Findings (${output.findings.length}): ${output.findings.map((f) => `[${f.severity}] ${f.description}`).join("; ")}`
          : "",
        output.tests_missing.length > 0
          ? `Tests manquants: ${output.tests_missing.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "sm":
      return [
        `Synthese: ${output.summary}`,
        output.blockers.length > 0
          ? `Blocages: ${output.blockers.join("; ")}`
          : "",
        output.next_steps.length > 0
          ? `Prochaines etapes: ${output.next_steps.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

    default:
      return JSON.stringify(output, null, 2);
  }
}
