/**
 * BMad Agent Prompts — Specialized system prompts loaded from YAML templates
 *
 * Each agent gets context-aware prompts that change based on:
 * - The command being executed (/exec, /plan, /retro, etc.)
 * - The task context (title, description, AC, subtasks)
 * - The project context (workflow config, previous retros)
 *
 * S15-03: Dedicated system prompts per BMad agent
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { parse as parseYaml } from "yaml";
import { buildFeedbackContext } from "./feedback-loop.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const AGENTS_DIR = join(PROJECT_ROOT, "config", "bmad-templates", "agents");

// ── Types ────────────────────────────────────────────────────

interface AgentYaml {
  agent: {
    metadata: {
      id: string;
      name: string;
      title: string;
      icon: string;
      capabilities?: string;
    };
    persona: {
      role: string;
      identity: string;
      communication_style: string;
      principles: string | string[];
    };
    critical_actions?: string[];
    menu?: Array<{
      trigger: string;
      description: string;
      workflow?: string;
      exec?: string;
    }>;
  };
}

export interface AgentPromptContext {
  command: string;
  taskTitle?: string;
  taskDescription?: string;
  priority?: number;
  acceptanceCriteria?: string;
  devNotes?: string;
  architectureRef?: string;
  subtasks?: Array<{ title: string; done?: boolean }>;
  sprintId?: string;
  projectName?: string;
  shardedContext?: string;
}

// ── YAML Loader ──────────────────────────────────────────────

const agentCache = new Map<string, AgentYaml>();

function loadAgentYaml(agentId: string): AgentYaml | null {
  if (agentCache.has(agentId)) return agentCache.get(agentId)!;

  const filePath = join(AGENTS_DIR, `${agentId}.agent.yaml`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(content) as AgentYaml;
    agentCache.set(agentId, parsed);
    return parsed;
  } catch (e) {
    console.error(`Failed to load agent YAML ${agentId}:`, e);
    return null;
  }
}

/**
 * Load all agent YAMLs and return their raw data.
 */
export function loadAllAgents(): Map<string, AgentYaml> {
  const agents = ["analyst", "pm", "architect", "sm", "dev", "qa"];
  for (const id of agents) {
    loadAgentYaml(id);
  }
  return agentCache;
}

// ── Prompt Builders ──────────────────────────────────────────

/**
 * Build a full system prompt for an agent from its YAML definition.
 * Enriched with Telegram-specific instructions and context.
 */
export function buildFullAgentPrompt(
  agentId: string,
  context: AgentPromptContext
): string {
  const yaml = loadAgentYaml(agentId);
  if (!yaml) return "";

  const { agent } = yaml;
  const { persona, metadata } = agent;

  const parts: string[] = [];

  // Identity block
  parts.push(`Tu es ${metadata.name}, ${metadata.title} (${metadata.icon}).`);
  parts.push("");
  parts.push(`ROLE: ${persona.role}`);
  parts.push(`IDENTITE: ${persona.identity}`);
  parts.push(`STYLE: ${persona.communication_style}`);
  parts.push("");

  // Principles
  const principles = Array.isArray(persona.principles)
    ? persona.principles.join("\n")
    : persona.principles;
  parts.push("PRINCIPES:");
  parts.push(principles.trim());

  // Critical actions
  if (agent.critical_actions && agent.critical_actions.length > 0) {
    parts.push("");
    parts.push("ACTIONS CRITIQUES:");
    for (const action of agent.critical_actions) {
      parts.push(`- ${action}`);
    }
  }

  // Command-specific instructions
  parts.push("");
  parts.push(getCommandInstructions(agentId, context));

  // Task context
  if (context.taskTitle) {
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push(`TACHE: ${context.taskTitle}`);
    if (context.taskDescription) {
      parts.push(`DESCRIPTION: ${context.taskDescription}`);
    }
    if (context.projectName) {
      parts.push(`PROJET: ${context.projectName}`);
    }
    if (context.priority != null) {
      parts.push(`PRIORITE: P${context.priority}`);
    }
    if (context.sprintId) {
      parts.push(`SPRINT: ${context.sprintId}`);
    }
  }

  // Acceptance criteria
  if (context.acceptanceCriteria) {
    parts.push("");
    parts.push("CRITERES D'ACCEPTATION:");
    parts.push(context.acceptanceCriteria);
  }

  // Dev notes
  if (context.devNotes) {
    parts.push("");
    parts.push("NOTES DEV:");
    parts.push(context.devNotes);
  }

  // Architecture ref
  if (context.architectureRef) {
    parts.push("");
    parts.push("REFERENCE ARCHITECTURE:");
    parts.push(context.architectureRef);
  }

  // Subtasks
  if (context.subtasks && context.subtasks.length > 0) {
    parts.push("");
    parts.push("SOUS-TACHES:");
    for (const st of context.subtasks) {
      parts.push(`${st.done ? "[x]" : "[ ]"} ${st.title}`);
    }
  }

  // Sharded document context
  if (context.shardedContext) {
    parts.push("");
    parts.push("CONTEXTE DOCUMENTS:");
    parts.push(context.shardedContext);
  }

  // Feedback from retros (S16-03)
  const feedback = buildFeedbackContext(agentId as any);
  if (feedback) {
    parts.push(feedback);
  }

  return parts.join("\n");
}

/**
 * Get command-specific instructions for each agent.
 */
function getCommandInstructions(
  agentId: string,
  context: AgentPromptContext
): string {
  const { command } = context;

  switch (agentId) {
    case "dev":
      return getDevInstructions(command);
    case "pm":
      return getPmInstructions(command);
    case "sm":
      return getSmInstructions(command);
    case "architect":
      return getArchitectInstructions(command);
    case "analyst":
      return getAnalystInstructions(command);
    case "qa":
      return getQaInstructions(command);
    default:
      return "";
  }
}

function getDevInstructions(command: string): string {
  if (command === "exec") {
    return [
      "INSTRUCTIONS EXECUTION:",
      "- Analyse le codebase existant avant toute modification",
      "- Execute les sous-taches dans l'ordre indique",
      "- Ecris des tests pour chaque fonctionnalite implementee",
      "- Ne marque une sous-tache comme terminee que quand les tests passent",
      "- Respecte le style de code existant (linting, nommage, patterns)",
      "- Documente chaque decision technique prise",
      "- Si tu es bloque, explique clairement pourquoi",
      "- Fais un resume concis de ce que tu as fait a la fin",
      "",
      "Commence maintenant.",
    ].join("\n");
  }
  if (command === "review") {
    return [
      "INSTRUCTIONS CODE REVIEW:",
      "- Revue adversariale : cherche les problemes, pas les compliments",
      "- Minimum 3 findings obligatoires (meme si le code est bon)",
      "- Categorise : critique / important / mineur / suggestion",
      "- Verifie : securite, performance, maintenabilite, tests manquants",
      "- Verifie l'alignement avec l'architecture et le PRD",
      "- Propose des corrections concretes, pas juste des observations",
    ].join("\n");
  }
  return "";
}

function getPmInstructions(command: string): string {
  if (command === "plan") {
    return [
      "INSTRUCTIONS DECOMPOSITION:",
      "- Decompose en sous-taches techniques concretes et atomiques",
      "- Chaque tache doit etre executable par un agent Claude Code autonome",
      "- Ordonne par dependances logiques",
      "- Estime la priorite (P1=critique, P2=important, P3=normal)",
      "- Inclus des criteres d'acceptation pour chaque tache",
      "- Identifie les risques et les dependances",
    ].join("\n");
  }
  if (command === "prd") {
    return [
      "INSTRUCTIONS PRD:",
      "- Sois concis mais precis",
      "- Les specs techniques doivent etre concretes (noms de fichiers, APIs, tables)",
      "- Les criteres de succes doivent etre mesurables",
      "- Le plan d'implementation doit etre decoupable en taches",
      "- N'utilise PAS de markdown gras ni italique, juste du texte brut avec des titres #",
    ].join("\n");
  }
  return "";
}

function getSmInstructions(command: string): string {
  if (command === "retro") {
    return [
      "INSTRUCTIONS RETRO:",
      "- Analyse les metriques du sprint de maniere factuelle",
      "- Identifie les patterns positifs ET les points d'amelioration",
      "- Compare avec les sprints precedents si disponibles",
      "- Propose des actions concretes et mesurables",
      "- Evalue si des gates ou checkpoints doivent etre ajustes",
      "- Focus sur le systeme, pas sur les individus",
    ].join("\n");
  }
  if (command === "sprint") {
    return [
      "INSTRUCTIONS SPRINT:",
      "- Vue factuelle de l'avancement",
      "- Identifie les blocages actuels",
      "- Propose des ajustements de priorite si necessaire",
      "- Alerte sur les risques de retard",
    ].join("\n");
  }
  if (command === "metrics") {
    return [
      "INSTRUCTIONS METRIQUES:",
      "- Analyse les donnees quantitatives du sprint",
      "- Compare avec les tendances historiques",
      "- Identifie les anomalies et les patterns",
      "- Recommande des actions basees sur les donnees",
    ].join("\n");
  }
  return "";
}

function getArchitectInstructions(command: string): string {
  return [
    "INSTRUCTIONS ARCHITECTURE:",
    "- Decisions techniques documentees avec le contexte (ADR format)",
    "- Trade-offs explicites pour chaque choix",
    "- Diagrammes en texte (ASCII ou mermaid) quand utile",
    "- Alignement avec les contraintes du PRD",
    "- Simplicite d'abord, scalabilite quand necessaire",
  ].join("\n");
}

function getAnalystInstructions(command: string): string {
  if (command === "patterns") {
    return [
      "INSTRUCTIONS ANALYSE PATTERNS:",
      "- Analyse multi-sprint des tendances",
      "- Identifie les patterns recurrents (positifs et negatifs)",
      "- Croise avec les metriques et les retros",
      "- Propose des ameliorations systeme basees sur les donnees",
      "- Priorise par impact potentiel",
    ].join("\n");
  }
  return [
    "INSTRUCTIONS ANALYSE:",
    "- Research factuelle et structuree",
    "- Sources verifiables quand possible",
    "- Cadre d'analyse explicite (SWOT, Porter, etc.)",
    "- Recommandations actionnables",
  ].join("\n");
}

function getQaInstructions(command: string): string {
  if (command === "alerts") {
    return [
      "INSTRUCTIONS ALERTES:",
      "- Diagnostique les problemes detectes",
      "- Priorise par severite et impact",
      "- Propose des actions correctives concretes",
      "- Verifie les regressions potentielles",
    ].join("\n");
  }
  return [
    "INSTRUCTIONS QA:",
    "- Genere des tests couvrant happy path + edge cases",
    "- Utilise le framework de test existant du projet",
    "- Tests simples, lisibles, maintenables",
    "- Verifie que tous les tests passent avant de terminer",
  ].join("\n");
}

// ── Agent Capabilities & Limits (S15-05) ─────────────────────

export interface AgentCapability {
  canModifyCode: boolean;
  canModifyArchitecture: boolean;
  canModifyPRD: boolean;
  canCreateTasks: boolean;
  canReviewCode: boolean;
  canDeployToProduction: boolean;
  allowedFilePatterns: string[];
}

const AGENT_CAPABILITIES: Record<string, AgentCapability> = {
  dev: {
    canModifyCode: true,
    canModifyArchitecture: false,
    canModifyPRD: false,
    canCreateTasks: false,
    canReviewCode: false,
    canDeployToProduction: false,
    allowedFilePatterns: ["src/**", "tests/**", "config/**", "package.json"],
  },
  pm: {
    canModifyCode: false,
    canModifyArchitecture: false,
    canModifyPRD: true,
    canCreateTasks: true,
    canReviewCode: false,
    canDeployToProduction: false,
    allowedFilePatterns: ["docs/**", "config/**"],
  },
  architect: {
    canModifyCode: false,
    canModifyArchitecture: true,
    canModifyPRD: false,
    canCreateTasks: false,
    canReviewCode: true,
    canDeployToProduction: false,
    allowedFilePatterns: ["docs/**", "config/**", "db/**"],
  },
  sm: {
    canModifyCode: false,
    canModifyArchitecture: false,
    canModifyPRD: false,
    canCreateTasks: true,
    canReviewCode: false,
    canDeployToProduction: false,
    allowedFilePatterns: [],
  },
  analyst: {
    canModifyCode: false,
    canModifyArchitecture: false,
    canModifyPRD: false,
    canCreateTasks: false,
    canReviewCode: false,
    canDeployToProduction: false,
    allowedFilePatterns: ["docs/**"],
  },
  qa: {
    canModifyCode: true,
    canModifyArchitecture: false,
    canModifyPRD: false,
    canCreateTasks: false,
    canReviewCode: true,
    canDeployToProduction: false,
    allowedFilePatterns: ["tests/**", "src/**/*.test.*"],
  },
};

/**
 * Get capabilities for an agent. Used to enforce isolation.
 */
export function getAgentCapabilities(agentId: string): AgentCapability {
  return AGENT_CAPABILITIES[agentId] || {
    canModifyCode: false,
    canModifyArchitecture: false,
    canModifyPRD: false,
    canCreateTasks: false,
    canReviewCode: false,
    canDeployToProduction: false,
    allowedFilePatterns: [],
  };
}

/**
 * Check if an agent is allowed to perform an action.
 */
export function checkAgentPermission(
  agentId: string,
  action: keyof AgentCapability
): boolean {
  const caps = getAgentCapabilities(agentId);
  return caps[action] as boolean;
}

/**
 * Build isolation instructions for an agent's prompt.
 * Tells the agent what it CAN and CANNOT do.
 */
export function buildIsolationInstructions(agentId: string): string {
  const caps = getAgentCapabilities(agentId);
  const lines: string[] = ["LIMITES DE TON ROLE:"];

  if (!caps.canModifyCode) lines.push("- Tu ne PEUX PAS modifier le code source");
  if (!caps.canModifyArchitecture) lines.push("- Tu ne PEUX PAS modifier les decisions d'architecture");
  if (!caps.canModifyPRD) lines.push("- Tu ne PEUX PAS modifier les PRDs");
  if (!caps.canCreateTasks) lines.push("- Tu ne PEUX PAS creer de taches");
  if (!caps.canReviewCode) lines.push("- Tu ne PEUX PAS faire de revue de code");
  if (!caps.canDeployToProduction) lines.push("- Tu ne PEUX PAS deployer en production");

  if (caps.allowedFilePatterns.length > 0) {
    lines.push(`- Fichiers autorises: ${caps.allowedFilePatterns.join(", ")}`);
  }

  return lines.join("\n");
}
