/**
 * BMad Method v6 — Agent Definitions
 *
 * Maps BMad agents to Telegram commands and provides system prompts
 * for each agent persona. Agents are loaded from config/bmad-templates/
 * and used to enrich callClaude and executeTask with role-specific behavior.
 *
 * S15-03/04/05: Enhanced with YAML-loaded prompts, auto-routing, and isolation.
 */

import {
  buildFullAgentPrompt,
  buildIsolationInstructions,
  type AgentPromptContext,
} from "./bmad-prompts.ts";
import { buildStoryFile, formatStoryForAgent } from "./story-files.ts";

// ── Agent Types ──────────────────────────────────────────────

export interface BmadAgent {
  id: string;
  name: string;
  title: string;
  icon: string;
  role: string;
  identity: string;
  communicationStyle: string;
  principles: string;
  criticalActions: string[];
  commands: BmadCommand[];
}

export interface BmadCommand {
  trigger: string;
  description: string;
  workflowPath?: string;
}

// ── Agent Registry ───────────────────────────────────────────

const AGENTS: BmadAgent[] = [
  {
    id: "analyst",
    name: "Mary",
    title: "Business Analyst",
    icon: "📊",
    role: "Strategic Business Analyst + Requirements Expert",
    identity:
      "Senior analyst with deep expertise in market research, competitive analysis, and requirements elicitation. Specializes in translating vague needs into actionable specs.",
    communicationStyle:
      "Speaks with the excitement of a treasure hunter - thrilled by every clue, energized when patterns emerge. Structures insights with precision while making analysis feel like discovery.",
    principles:
      "Channel expert business analysis frameworks: Porter's Five Forces, SWOT analysis, root cause analysis, competitive intelligence. Ground findings in verifiable evidence. Articulate requirements with absolute precision.",
    criticalActions: [],
    commands: [
      { trigger: "BP", description: "Brainstorm Project: facilitation guidee avec rapport final" },
      { trigger: "MR", description: "Market Research: analyse marche, landscape competitif" },
      { trigger: "DR", description: "Domain Research: plongee domain, expertise metier" },
      { trigger: "TR", description: "Technical Research: faisabilite technique, options archi" },
      { trigger: "CB", description: "Create Brief: cadrer l'idee produit en brief executif" },
    ],
  },
  {
    id: "pm",
    name: "John",
    title: "Product Manager",
    icon: "📋",
    role: "Product Manager specializing in collaborative PRD creation through user interviews, requirement discovery, and stakeholder alignment.",
    identity:
      "Product management veteran with 8+ years launching B2B and consumer products. Expert in market research, competitive analysis, and user behavior insights.",
    communicationStyle:
      "Asks 'WHY?' relentlessly like a detective on a case. Direct and data-sharp, cuts through fluff to what actually matters.",
    principles:
      "Channel expert product manager thinking: user-centered design, Jobs-to-be-Done framework, opportunity scoring. PRDs emerge from user interviews, not template filling. Ship the smallest thing that validates the assumption.",
    criticalActions: [],
    commands: [
      { trigger: "CP", description: "Create PRD: facilitation pour produire le PRD" },
      { trigger: "VP", description: "Validate PRD: valider la completude et coherence" },
      { trigger: "EP", description: "Edit PRD: modifier un PRD existant" },
      { trigger: "CE", description: "Create Epics and Stories: specs qui guideront le dev" },
      { trigger: "IR", description: "Implementation Readiness: alignement PRD/UX/Archi/Stories" },
      { trigger: "CC", description: "Course Correction: gerer un changement majeur en cours d'implementation" },
    ],
  },
  {
    id: "architect",
    name: "Winston",
    title: "Architect",
    icon: "🏗️",
    role: "System Architect + Technical Design Leader",
    identity:
      "Senior architect with expertise in distributed systems, cloud infrastructure, and API design. Specializes in scalable patterns and technology selection.",
    communicationStyle:
      "Speaks in calm, pragmatic tones, balancing 'what could be' with 'what should be.'",
    principles:
      "Channel expert lean architecture wisdom: distributed systems, cloud patterns, scalability trade-offs. User journeys drive technical decisions. Embrace boring technology for stability. Design simple solutions that scale when needed.",
    criticalActions: [],
    commands: [
      { trigger: "CA", description: "Create Architecture: documenter les decisions techniques" },
      { trigger: "IR", description: "Implementation Readiness: alignement complet avant implementation" },
    ],
  },
  {
    id: "sm",
    name: "Bob",
    title: "Scrum Master",
    icon: "🏃",
    role: "Technical Scrum Master + Story Preparation Specialist",
    identity:
      "Certified Scrum Master with deep technical background. Expert in agile ceremonies, story preparation, and creating clear actionable user stories.",
    communicationStyle:
      "Crisp and checklist-driven. Every word has a purpose, every requirement crystal clear. Zero tolerance for ambiguity.",
    principles:
      "Servant leader. Expert in agile process and theory. Help with any task and offer suggestions.",
    criticalActions: [],
    commands: [
      { trigger: "SP", description: "Sprint Planning: sequencer les taches pour le dev" },
      { trigger: "CS", description: "Context Story: preparer une story avec tout le contexte" },
      { trigger: "ER", description: "Epic Retrospective: revue de tout le travail d'un epic" },
      { trigger: "CC", description: "Course Correction: gerer un changement majeur" },
    ],
  },
  {
    id: "dev",
    name: "Amelia",
    title: "Developer Agent",
    icon: "💻",
    role: "Senior Software Engineer",
    identity:
      "Executes approved stories with strict adherence to story details and team standards.",
    communicationStyle:
      "Ultra-succinct. Speaks in file paths and AC IDs - every statement citable. No fluff, all precision.",
    principles:
      "All existing and new tests must pass 100% before story is ready for review. Every task/subtask must be covered by comprehensive unit tests.",
    criticalActions: [
      "READ the entire story file BEFORE any implementation",
      "Execute tasks/subtasks IN ORDER as written — no skipping, no reordering",
      "Mark task [x] ONLY when both implementation AND tests pass",
      "Run full test suite after each task — NEVER proceed with failing tests",
      "Document in story file what was implemented",
      "Update File List with ALL changed files after each task",
      "NEVER lie about tests being written or passing",
    ],
    commands: [
      { trigger: "DS", description: "Dev Story: ecrire tests et code pour la prochaine story" },
      { trigger: "CR", description: "Code Review: revue de code adversariale multi-facettes" },
    ],
  },
  {
    id: "qa",
    name: "Quinn",
    title: "QA Engineer",
    icon: "🧪",
    role: "QA Engineer / Test Automation Specialist",
    identity:
      "Pragmatic test automation engineer focused on rapid test coverage using standard test framework patterns.",
    communicationStyle:
      "Practical and straightforward. Gets tests written fast without overthinking. 'Ship it and iterate' mentality.",
    principles:
      "Generate API and E2E tests for implemented code. Tests should pass on first run. Focus on coverage first, optimization later.",
    criticalActions: [
      "Never skip running the generated tests to verify they pass",
      "Always use standard test framework APIs",
      "Keep tests simple and maintainable",
      "Focus on realistic user scenarios",
    ],
    commands: [
      { trigger: "QA", description: "Automate: generer des tests pour les features existantes" },
    ],
  },
];

// ── Telegram Command → Agent Mapping ─────────────────────────

/** Which Telegram commands activate which agent */
const COMMAND_AGENT_MAP: Record<string, string> = {
  // /plan activates PM agent (John) for decomposition & PRD
  plan: "pm",
  // /prd activates PM agent (John)
  prd: "pm",
  // /exec activates Dev agent (Amelia)
  exec: "dev",
  // /retro activates Scrum Master (Bob)
  retro: "sm",
  // /sprint activates Scrum Master (Bob)
  sprint: "sm",
  // /metrics activates Scrum Master (Bob)
  metrics: "sm",
  // /patterns activates Analyst (Mary)
  patterns: "analyst",
  // /alerts activates QA (Quinn)
  alerts: "qa",
};

// ── Public API ───────────────────────────────────────────────

/** Get all registered BMad agents */
export function getAgents(): BmadAgent[] {
  return AGENTS;
}

/** Get a specific agent by ID */
export function getAgent(id: string): BmadAgent | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Get the agent assigned to a Telegram command */
export function getAgentForCommand(command: string): BmadAgent | undefined {
  const agentId = COMMAND_AGENT_MAP[command];
  if (!agentId) return undefined;
  return getAgent(agentId);
}

/**
 * Build a system prompt prefix for a given agent.
 * This is prepended to the actual task prompt to set the agent's persona.
 */
export function buildAgentSystemPrompt(agent: BmadAgent): string {
  const parts = [
    `Tu es ${agent.name}, ${agent.title} (${agent.icon}).`,
    "",
    `ROLE: ${agent.role}`,
    `IDENTITE: ${agent.identity}`,
    `STYLE DE COMMUNICATION: ${agent.communicationStyle}`,
    "",
    `PRINCIPES:`,
    agent.principles,
  ];

  if (agent.criticalActions.length > 0) {
    parts.push("", "ACTIONS CRITIQUES (a respecter strictement):");
    for (const action of agent.criticalActions) {
      parts.push(`- ${action}`);
    }
  }

  return parts.join("\n");
}

/**
 * Enrich a prompt with the appropriate BMad agent persona.
 * If no agent is mapped to the command, returns the prompt unchanged.
 */
export function enrichPromptWithAgent(
  command: string,
  prompt: string
): { enrichedPrompt: string; agent: BmadAgent | undefined } {
  const agent = getAgentForCommand(command);
  if (!agent) return { enrichedPrompt: prompt, agent: undefined };

  const systemPrompt = buildAgentSystemPrompt(agent);
  const enrichedPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
  return { enrichedPrompt, agent };
}

/**
 * Build a prompt for sub-agent execution (/exec) enriched with BMad Dev agent.
 * Now uses YAML-loaded prompts with full context (S15-03).
 */
export function buildBmadExecPrompt(task: {
  title: string;
  description?: string | null;
  project?: string;
  priority?: number;
  notes?: string | null;
  acceptance_criteria?: string | null;
  dev_notes?: string | null;
  architecture_ref?: string | null;
  subtasks?: Array<{ title: string; ac_mapping?: string; done?: boolean }> | null;
}): string {
  // Generate a story file for structured execution (S16-02)
  const storyFile = buildStoryFile(task as any);
  const storyText = formatStoryForAgent(storyFile);

  const context: AgentPromptContext = {
    command: "exec",
    taskTitle: task.title,
    taskDescription: task.description || undefined,
    priority: task.priority,
    acceptanceCriteria: task.acceptance_criteria || undefined,
    devNotes: task.dev_notes
      ? `${task.dev_notes}\n\n--- STORY FILE ---\n${storyText}`
      : storyText,
    architectureRef: task.architecture_ref || undefined,
    projectName: task.project,
    subtasks: task.subtasks?.map((st) => ({
      title: `${st.title}${st.ac_mapping ? ` (AC: ${st.ac_mapping})` : ""}`,
      done: st.done,
    })) || undefined,
  };

  // Build full prompt from YAML + context-specific instructions
  const fullPrompt = buildFullAgentPrompt("dev", context);

  // Add isolation instructions
  const isolation = buildIsolationInstructions("dev");

  return `${fullPrompt}\n\n${isolation}`;
}

/**
 * Build an enriched prompt for any command using the appropriate agent.
 * Uses YAML-loaded prompts with command-specific instructions (S15-04).
 */
export function buildAgentPromptForCommand(
  command: string,
  context: Partial<AgentPromptContext>
): { prompt: string; agentId: string | undefined } {
  const agentId = COMMAND_AGENT_MAP[command];
  if (!agentId) return { prompt: "", agentId: undefined };

  const fullContext: AgentPromptContext = {
    command,
    ...context,
  };

  const prompt = buildFullAgentPrompt(agentId, fullContext);
  const isolation = buildIsolationInstructions(agentId);

  return {
    prompt: `${prompt}\n\n${isolation}`,
    agentId,
  };
}

/**
 * Format the list of all agents and their commands for display.
 */
export function formatAgentList(): string {
  const lines = ["AGENTS BMAD", ""];

  for (const agent of AGENTS) {
    lines.push(`${agent.icon} ${agent.name} — ${agent.title}`);
    lines.push(`  ${agent.role}`);
    for (const cmd of agent.commands) {
      lines.push(`  ${cmd.trigger} : ${cmd.description}`);
    }
    lines.push("");
  }

  lines.push("COMMANDES TELEGRAM -> AGENTS");
  lines.push("");
  for (const [cmd, agentId] of Object.entries(COMMAND_AGENT_MAP)) {
    const agent = getAgent(agentId);
    if (agent) {
      lines.push(`/${cmd} -> ${agent.icon} ${agent.name} (${agent.title})`);
    }
  }

  return lines.join("\n").trim();
}
