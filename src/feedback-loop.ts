/**
 * Feedback Loop — S16-03
 *
 * Learns from retros and workflow logs to enrich agent prompts.
 * When a pattern recurs 2+ times across sprints, it becomes a
 * permanent instruction for the relevant agent.
 *
 * Flow:
 *   retros + workflow_logs -> extract patterns -> match to agents -> enrich prompts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRole } from "./orchestrator.ts";

// ── Types ────────────────────────────────────────────────────

export interface FeedbackRule {
  id: string;
  agentId: AgentRole;
  pattern: string;
  instruction: string;
  occurrences: number;
  sprints: string[];
  active: boolean;
  createdAt: string;
}

// ── In-Memory Cache ──────────────────────────────────────────

let feedbackRules: FeedbackRule[] = [];

export function getFeedbackRules(): FeedbackRule[] {
  return feedbackRules.filter((r) => r.active);
}

export function getFeedbackRulesForAgent(agentId: AgentRole): FeedbackRule[] {
  return feedbackRules.filter((r) => r.active && r.agentId === agentId);
}

// ── Rule Loading from Supabase ───────────────────────────────

/**
 * Load feedback rules from the database.
 * Called on startup and after retros.
 */
export async function loadFeedbackRules(
  supabase: SupabaseClient
): Promise<FeedbackRule[]> {
  const { data, error } = await supabase
    .from("feedback_rules")
    .select("*")
    .eq("active", true)
    .order("occurrences", { ascending: false });

  if (error) {
    console.error("loadFeedbackRules error:", error);
    return feedbackRules; // return cached
  }

  feedbackRules = (data || []).map((row: any) => ({
    id: row.id,
    agentId: row.agent_id,
    pattern: row.pattern,
    instruction: row.instruction,
    occurrences: row.occurrences,
    sprints: row.sprints || [],
    active: row.active,
    createdAt: row.created_at,
  }));

  return feedbackRules;
}

// ── Pattern Extraction from Retros ───────────────────────────

/** Known pattern-to-agent mappings */
const PATTERN_AGENT_MAP: Array<{
  keywords: string[];
  agentId: AgentRole;
  defaultInstruction: string;
}> = [
  {
    keywords: ["test", "tests", "coverage", "testing"],
    agentId: "dev",
    defaultInstruction: "Porte une attention particuliere a la couverture de tests. Des patterns de tests manquants ont ete detectes dans les retros precedentes.",
  },
  {
    keywords: ["test", "tests", "coverage", "testing", "regression"],
    agentId: "qa",
    defaultInstruction: "Verifie systematiquement la couverture de tests. Historiquement, des lacunes ont ete detectees.",
  },
  {
    keywords: ["securite", "security", "injection", "xss", "rls"],
    agentId: "dev",
    defaultInstruction: "Sois particulierement vigilant sur la securite. Des vulnerabilites ont ete detectees dans les retros precedentes.",
  },
  {
    keywords: ["architecture", "design", "pattern", "structure"],
    agentId: "architect",
    defaultInstruction: "Revise les decisions d'architecture avec attention. Des problemes de design ont ete identifies dans les retros precedentes.",
  },
  {
    keywords: ["scope", "perimetre", "creep", "complexite"],
    agentId: "pm",
    defaultInstruction: "Verifie le perimetre des taches. Des derives de scope ont ete observees dans les sprints precedents.",
  },
  {
    keywords: ["performance", "lenteur", "timeout", "memoire", "memory"],
    agentId: "dev",
    defaultInstruction: "Fais attention aux performances. Des problemes de performance ont ete detectes dans les retros precedentes.",
  },
  {
    keywords: ["documentation", "docs", "readme", "commentaire"],
    agentId: "dev",
    defaultInstruction: "N'oublie pas la documentation. Un manque de documentation a ete identifie dans les retros precedentes.",
  },
  {
    keywords: ["bloquer", "blocage", "dependance", "bloque"],
    agentId: "sm",
    defaultInstruction: "Surveille les blocages proactivement. Des taches bloquees ont ete un probleme recurrent.",
  },
];

/**
 * Extract feedback patterns from retro data.
 * Returns new/updated rules based on recurring patterns.
 */
export function extractFeedbackFromRetro(
  retro: {
    sprint_id: string;
    what_didnt: string[];
    patterns_detected: string[];
    actions_proposed?: Array<{ action: string; priority: string }>;
  }
): Array<{ agentId: AgentRole; pattern: string; instruction: string }> {
  const results: Array<{ agentId: AgentRole; pattern: string; instruction: string }> = [];

  // Analyze what didn't work + patterns detected
  const allPatterns = [
    ...(retro.what_didnt || []),
    ...(retro.patterns_detected || []),
  ];

  for (const patternText of allPatterns) {
    const lower = patternText.toLowerCase();
    for (const mapping of PATTERN_AGENT_MAP) {
      if (mapping.keywords.some((kw) => lower.includes(kw))) {
        results.push({
          agentId: mapping.agentId,
          pattern: patternText,
          instruction: mapping.defaultInstruction,
        });
        break; // one pattern per agent match
      }
    }
  }

  // Also extract from proposed actions
  if (retro.actions_proposed) {
    for (const action of retro.actions_proposed) {
      const lower = action.action.toLowerCase();
      for (const mapping of PATTERN_AGENT_MAP) {
        if (mapping.keywords.some((kw) => lower.includes(kw))) {
          results.push({
            agentId: mapping.agentId,
            pattern: action.action,
            instruction: `Action retro: ${action.action}`,
          });
          break;
        }
      }
    }
  }

  return results;
}

/**
 * Process retro data and upsert feedback rules into Supabase.
 * A rule becomes active when the same pattern appears in 2+ sprints.
 */
export async function processRetroFeedback(
  supabase: SupabaseClient,
  retro: {
    sprint_id: string;
    what_didnt: string[];
    patterns_detected: string[];
    actions_proposed?: Array<{ action: string; priority: string }>;
  }
): Promise<{ newRules: number; updatedRules: number }> {
  const extracted = extractFeedbackFromRetro(retro);
  let newRules = 0;
  let updatedRules = 0;

  for (const item of extracted) {
    // Check if a similar rule already exists for this agent
    const existing = feedbackRules.find(
      (r) =>
        r.agentId === item.agentId &&
        r.pattern.toLowerCase().includes(item.pattern.toLowerCase().substring(0, 20))
    );

    if (existing) {
      // Update: add sprint, bump occurrences
      if (!existing.sprints.includes(retro.sprint_id)) {
        existing.sprints.push(retro.sprint_id);
        existing.occurrences++;
        existing.active = existing.occurrences >= 2;

        await supabase
          .from("feedback_rules")
          .update({
            occurrences: existing.occurrences,
            sprints: existing.sprints,
            active: existing.active,
          })
          .eq("id", existing.id);

        updatedRules++;
      }
    } else {
      // Insert new rule
      const { data, error } = await supabase
        .from("feedback_rules")
        .insert({
          agent_id: item.agentId,
          pattern: item.pattern,
          instruction: item.instruction,
          occurrences: 1,
          sprints: [retro.sprint_id],
          active: false, // Needs 2+ occurrences to activate
        })
        .select()
        .single();

      if (!error && data) {
        feedbackRules.push({
          id: data.id,
          agentId: item.agentId,
          pattern: item.pattern,
          instruction: item.instruction,
          occurrences: 1,
          sprints: [retro.sprint_id],
          active: false,
          createdAt: data.created_at,
        });
        newRules++;
      }
    }
  }

  return { newRules, updatedRules };
}

// ── Prompt Enrichment ────────────────────────────────────────

/**
 * Build a feedback context block to append to an agent's prompt.
 * Only includes rules that are active (2+ occurrences).
 */
export function buildFeedbackContext(agentId: AgentRole): string {
  const rules = getFeedbackRulesForAgent(agentId);
  if (rules.length === 0) return "";

  const lines: string[] = [
    "",
    "APPRENTISSAGES DES RETROS PRECEDENTES:",
    "(ces patterns ont ete detectes dans 2+ sprints, sois particulierement attentif)",
    "",
  ];

  for (const rule of rules) {
    lines.push(`- [${rule.occurrences}x] ${rule.instruction}`);
  }

  return lines.join("\n");
}

// ── Formatting ───────────────────────────────────────────────

export function formatFeedbackRules(rules: FeedbackRule[]): string {
  if (rules.length === 0) return "Aucune regle de feedback active.";

  const lines: string[] = ["REGLES DE FEEDBACK", ""];
  const active = rules.filter((r) => r.active);
  const pending = rules.filter((r) => !r.active);

  if (active.length > 0) {
    lines.push(`Actives (${active.length}):`);
    for (const rule of active) {
      lines.push(`  ${rule.agentId} [${rule.occurrences}x]: ${rule.instruction}`);
      lines.push(`    Pattern: ${rule.pattern.substring(0, 80)}`);
      lines.push(`    Sprints: ${rule.sprints.join(", ")}`);
    }
    lines.push("");
  }

  if (pending.length > 0) {
    lines.push(`En attente (${pending.length}, besoin de 2+ occurrences):`);
    for (const rule of pending) {
      lines.push(`  ${rule.agentId} [${rule.occurrences}x]: ${rule.pattern.substring(0, 60)}`);
    }
  }

  return lines.join("\n").trim();
}
