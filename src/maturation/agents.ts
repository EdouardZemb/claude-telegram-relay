import { createLogger } from "../logger.ts";
import type { MaturationDocType } from "./types.ts";

const log = createLogger("maturation/agents");

export interface AgentConfig {
  agentFile: string;
  outputDoc: MaturationDocType;
  model: string;
  effort: "high" | "max";
  requiredDocs: MaturationDocType[];
  doublePass: boolean;
}

export const MATURATION_AGENT_ROLES: Record<string, AgentConfig> = {
  understander: {
    agentFile: "maturation-understander.md",
    outputDoc: "UNDERSTANDING",
    model: "sonnet",
    effort: "max",
    requiredDocs: [],
    doublePass: false,
  },
  expander: {
    agentFile: "maturation-expander.md",
    outputDoc: "EXPAND",
    model: "sonnet",
    effort: "high",
    requiredDocs: ["UNDERSTANDING"],
    doublePass: false,
  },
  researcher: {
    agentFile: "maturation-researcher.md",
    outputDoc: "RESEARCH",
    model: "sonnet",
    effort: "high",
    requiredDocs: ["UNDERSTANDING", "EXPAND"],
    doublePass: false,
  },
  analogist: {
    agentFile: "maturation-analogist.md",
    outputDoc: "ANALOGIES",
    model: "sonnet",
    effort: "high",
    requiredDocs: ["UNDERSTANDING"],
    doublePass: false,
  },
  "tech-critic": {
    agentFile: "maturation-tech-critic.md",
    outputDoc: "CRITIQUE-TECH",
    model: "sonnet",
    effort: "max",
    requiredDocs: ["UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES"],
    doublePass: true,
  },
  "product-critic": {
    agentFile: "maturation-product-critic.md",
    outputDoc: "CRITIQUE-PROD",
    model: "sonnet",
    effort: "max",
    requiredDocs: ["UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES"],
    doublePass: true,
  },
  "strategy-critic": {
    agentFile: "maturation-strategy-critic.md",
    outputDoc: "CRITIQUE-STRAT",
    model: "sonnet",
    effort: "max",
    requiredDocs: ["UNDERSTANDING", "EXPAND", "RESEARCH", "ANALOGIES"],
    doublePass: true,
  },
  synthesizer: {
    agentFile: "maturation-synthesizer.md",
    outputDoc: "SPEC-UNIFIEE",
    model: "opus",
    effort: "max",
    requiredDocs: [
      "UNDERSTANDING",
      "EXPAND",
      "RESEARCH",
      "ANALOGIES",
      "CRITIQUE-TECH",
      "CRITIQUE-PROD",
      "CRITIQUE-STRAT",
    ],
    doublePass: false,
  },
  "devils-advocate": {
    agentFile: "maturation-devils-advocate.md",
    outputDoc: "DEVILS-ADVOCATE",
    model: "sonnet",
    effort: "max",
    requiredDocs: [
      "UNDERSTANDING",
      "EXPAND",
      "RESEARCH",
      "ANALOGIES",
      "CRITIQUE-TECH",
      "CRITIQUE-PROD",
      "CRITIQUE-STRAT",
      "SPEC-UNIFIEE",
    ],
    doublePass: false,
  },
};

export function getAgentConfig(role: string): AgentConfig | null {
  return MATURATION_AGENT_ROLES[role] ?? null;
}

export interface PromptContext {
  rawInput: string;
  runDir: string;
  documents: Partial<Record<string, string>>;
  resolvedCheckpoints?: Array<{ source: string; summary: string; userChoice: string }>;
  globalDecisions?: Array<{ source: string; summary: string; userChoice: string }>;
}

export function buildPhasePrompt(role: string, ctx: PromptContext): string {
  const config = getAgentConfig(role);
  if (!config) return "";

  const parts: string[] = [];
  parts.push(
    `Read your agent profile in \`.claude/agents/${config.agentFile}\` and follow its instructions.\n`,
  );
  parts.push(`## Raw idea\n\n${ctx.rawInput}\n`);
  parts.push(`## Run directory\n\n${ctx.runDir}\n`);

  const docEntries = Object.entries(ctx.documents).filter(([, v]) => v);
  if (docEntries.length > 0) {
    parts.push("## Prior documents\n");
    for (const [name, content] of docEntries) {
      parts.push(`<document name="${name}">\n${content}\n</document>\n`);
    }
  }

  if (ctx.resolvedCheckpoints && ctx.resolvedCheckpoints.length > 0) {
    parts.push("## Decisions humaines (ce run)\n");
    for (const cp of ctx.resolvedCheckpoints) {
      parts.push(`- [${cp.source}] "${cp.summary}" -> Choix: "${cp.userChoice}"`);
    }
    parts.push("");
  }

  if (ctx.globalDecisions && ctx.globalDecisions.length > 0) {
    parts.push("## Decisions historiques\n");
    for (const gd of ctx.globalDecisions) {
      parts.push(`- [${gd.source}] "${gd.summary}" -> "${gd.userChoice}"`);
    }
    parts.push("");
  }

  parts.push(`## Output\n\nWrite your output to: ${ctx.runDir}/${config.outputDoc}.md`);

  if (config.doublePass) {
    parts.push(
      "\n\n**IMPORTANT: Double-pass required.** Write your initial analysis, then re-read ALL documents plus your initial analysis, and produce a refined final version.",
    );
  }

  return parts.join("\n");
}
