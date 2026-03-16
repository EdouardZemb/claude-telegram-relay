/**
 * @module mcp-config
 * @description Per-role MCP tool configuration: defines which MCP tools each agent role
 * can use and generates system prompt instructions for tool access.
 */

import type { AgentRole } from "./orchestrator.ts";

// ── MCP Tool Registry ────────────────────────────────────────

/** All available MCP tools from the memory server */
export const MCP_TOOLS = [
  "search_thoughts",
  "list_thoughts",
  "thought_stats",
  "capture_thought",
  "get_tasks",
  "get_sprint_summary",
  "get_project_context",
  "read_blackboard",
  "write_blackboard",
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number];

/** Human-readable descriptions for each tool */
const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  search_thoughts: "Recherche semantique dans la memoire (faits, goals, decisions)",
  list_thoughts: "Liste les memories recentes par type (fact, goal, preference, decision)",
  thought_stats: "Statistiques memoire (total, types, activite recente)",
  capture_thought: "Enregistrer un nouveau souvenir (fait, decision, goal)",
  get_tasks: "Lister les taches (filtrable par status, projet, sprint)",
  get_sprint_summary: "Progression du sprint (total, done, in_progress, backlog)",
  get_project_context: "Contexte complet du projet (memoire + sprint + taches)",
  read_blackboard: "Lire une section du blackboard (spec, plan, tasks, implementation, verification)",
  write_blackboard: "Ecrire dans une section du blackboard (avec locking optimiste)",
};

// ── Per-Role Tool Allowlists ────────────────────────────────

/**
 * MCP tools allowed per agent role.
 *
 * - analyst: read-only context (memory + project, no blackboard write)
 * - pm: memory + project + capture (can save decisions)
 * - architect: all tools (needs blackboard read/write for design docs)
 * - dev: all tools (needs blackboard for implementation tracking)
 * - qa: read-only everything (can read blackboard but not write)
 * - sm: memory only (summary + capture)
 */
const ROLE_TOOLS: Record<AgentRole, McpToolName[]> = {
  analyst: [
    "search_thoughts",
    "list_thoughts",
    "thought_stats",
    "get_tasks",
    "get_sprint_summary",
    "get_project_context",
  ],
  pm: [
    "search_thoughts",
    "list_thoughts",
    "thought_stats",
    "capture_thought",
    "get_tasks",
    "get_sprint_summary",
    "get_project_context",
  ],
  architect: [
    "search_thoughts",
    "list_thoughts",
    "thought_stats",
    "capture_thought",
    "get_tasks",
    "get_sprint_summary",
    "get_project_context",
    "read_blackboard",
    "write_blackboard",
  ],
  dev: [
    "search_thoughts",
    "list_thoughts",
    "thought_stats",
    "capture_thought",
    "get_tasks",
    "get_sprint_summary",
    "get_project_context",
    "read_blackboard",
    "write_blackboard",
  ],
  qa: [
    "search_thoughts",
    "list_thoughts",
    "thought_stats",
    "get_tasks",
    "get_sprint_summary",
    "get_project_context",
    "read_blackboard",
  ],
  sm: [
    "search_thoughts",
    "list_thoughts",
    "thought_stats",
    "capture_thought",
  ],
};

// ── Public API ───────────────────────────────────────────────

/**
 * Get the list of allowed MCP tools for a given agent role.
 */
export function getMcpToolsForRole(role: AgentRole | string): McpToolName[] {
  return ROLE_TOOLS[role as AgentRole] ?? ROLE_TOOLS.dev;
}

/**
 * Get MCP tool names in the Claude Code format: mcp__memory__<tool>
 * Suitable for --allowedTools flag.
 */
export function getMcpAllowedToolNames(role: AgentRole | string): string[] {
  return getMcpToolsForRole(role).map((t) => `mcp__memory__${t}`);
}

/**
 * Build system prompt instructions explaining which MCP tools are available
 * to the agent and how to use them.
 *
 * Returns a formatted string to inject via --append-system-prompt.
 */
export function buildMcpToolInstructions(role: AgentRole | string): string {
  const tools = getMcpToolsForRole(role);

  const lines: string[] = [
    "--- OUTILS MCP DISPONIBLES ---",
    "Tu as acces aux outils MCP suivants pour interroger la base de donnees du projet.",
    "Utilise-les quand tu as besoin de contexte supplementaire pendant ton travail.",
    "",
  ];

  for (const tool of tools) {
    lines.push(`- ${tool}: ${TOOL_DESCRIPTIONS[tool]}`);
  }

  // Role-specific guidance
  const guidance = getRoleGuidance(role as AgentRole);
  if (guidance) {
    lines.push("");
    lines.push(guidance);
  }

  return lines.join("\n");
}

/**
 * Check if a specific tool is allowed for a role.
 */
export function isToolAllowed(role: AgentRole | string, tool: McpToolName): boolean {
  return getMcpToolsForRole(role).includes(tool);
}

// ── Role-specific Guidance ───────────────────────────────────

function getRoleGuidance(role: AgentRole): string | null {
  switch (role) {
    case "analyst":
      return "GUIDE: Utilise get_project_context pour un apercu rapide, puis search_thoughts pour approfondir des sujets specifiques. Ne modifie pas la memoire.";
    case "pm":
      return "GUIDE: Utilise get_tasks et get_sprint_summary pour comprendre l'etat actuel. Utilise capture_thought pour enregistrer les decisions importantes prises.";
    case "architect":
      return "GUIDE: Utilise read_blackboard pour lire les specs et le plan existant. Utilise write_blackboard pour sauvegarder tes decisions d'architecture dans la section 'plan'.";
    case "dev":
      return "GUIDE: Utilise read_blackboard pour lire le plan et les specs avant de coder. Utilise write_blackboard pour mettre a jour la section 'implementation' avec les fichiers modifies.";
    case "qa":
      return "GUIDE: Utilise read_blackboard pour comparer l'implementation avec les specs et le plan. Ne modifie pas le blackboard.";
    case "sm":
      return "GUIDE: Utilise search_thoughts pour retrouver le contexte des decisions passees. Utilise capture_thought pour enregistrer les conclusions de retros et sprint reviews.";
    default:
      return null;
  }
}
