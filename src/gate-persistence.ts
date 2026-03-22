/**
 * @module gate-persistence
 * @description Persists gate evaluation results to Supabase and implements
 * double-loop learning from recurring rubric weaknesses (S35).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeterministicCheckResult, RubricDimension } from "./gate-evaluator.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("gate-persistence");
// ── Types ────────────────────────────────────────────────────

export interface GateEvaluationRecord {
  sessionId: string;
  taskId?: string;
  sprintId?: string;
  agentRole: string;
  gateName: string;
  score: number;
  passed: boolean;
  rubricDimensions?: RubricDimension[];
  deterministicChecks?: DeterministicCheckResult[];
  reworkIteration: number;
  reworkTriggered: boolean;
  autoApproved: boolean;
}

export interface DimensionWeakness {
  agentRole: string;
  dimensionName: string;
  count: number;
}

// ── Constants ────────────────────────────────────────────────

/** Score threshold below which a dimension is considered weak */
const WEAK_DIMENSION_THRESHOLD = 15;

/** Number of weak occurrences before generating a double-loop rule */
const DOUBLE_LOOP_TRIGGER_COUNT = 3;

// ── Persistence ──────────────────────────────────────────────

/**
 * Persist a gate evaluation result to Supabase.
 */
export async function persistGateEvaluation(
  supabase: SupabaseClient | null,
  record: GateEvaluationRecord,
): Promise<void> {
  if (!supabase) return;

  const { error } = await supabase.from("gate_evaluations").insert({
    session_id: record.sessionId,
    task_id: record.taskId || null,
    sprint_id: record.sprintId || null,
    agent_role: record.agentRole,
    gate_name: record.gateName,
    score: record.score,
    passed: record.passed,
    rubric_dimensions: record.rubricDimensions || null,
    deterministic_checks: record.deterministicChecks || null,
    rework_iteration: record.reworkIteration,
    rework_triggered: record.reworkTriggered,
    auto_approved: record.autoApproved,
  });

  if (error) {
    log.error("persistGateEvaluation error", { error: String(error) });
  }
}

// ── Double-loop Learning ─────────────────────────────────────

/**
 * Detect weak dimensions for an agent role by querying gate_evaluations.
 * Returns dimensions that have been weak (< 15/25) 3+ times.
 */
export async function detectWeakDimensions(
  supabase: SupabaseClient,
  agentRole: string,
): Promise<DimensionWeakness[]> {
  // Query all gate evaluations for this role with rubric data
  const { data, error } = await supabase
    .from("gate_evaluations")
    .select("rubric_dimensions")
    .eq("agent_role", agentRole)
    .not("rubric_dimensions", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error || !data) return [];

  // Count weak dimensions
  const weakCounts: Record<string, number> = {};
  for (const row of data) {
    const dims = row.rubric_dimensions as RubricDimension[] | null;
    if (!dims) continue;
    for (const dim of dims) {
      if (dim.score < WEAK_DIMENSION_THRESHOLD) {
        weakCounts[dim.name] = (weakCounts[dim.name] || 0) + 1;
      }
    }
  }

  // Filter to those at/above trigger count
  return Object.entries(weakCounts)
    .filter(([, count]) => count >= DOUBLE_LOOP_TRIGGER_COUNT)
    .map(([name, count]) => ({ agentRole, dimensionName: name, count }));
}

/**
 * Generate a corrective instruction for a weak dimension.
 * Returns a specific instruction based on the dimension name.
 */
export function generateDoubleLoopInstruction(
  _agentRole: string,
  dimensionName: string,
  weaknessCount: number,
): string {
  const instructions: Record<string, string> = {
    // Code rubric dimensions
    error_handling: `ALERTE QUALITE: La gestion d'erreurs est systematiquement faible (${weaknessCount} evaluations). Ajoute des try/catch sur les operations async, destructure {error} sur les appels Supabase, et log les erreurs avec console.error.`,
    test_coverage: `ALERTE QUALITE: La couverture de tests est insuffisante (${weaknessCount} evaluations). Chaque nouvelle fonction doit avoir au minimum un test unitaire. Vise 80%+ de couverture sur le code ajoute.`,
    code_style: `ALERTE QUALITE: Le style de code ne respecte pas les conventions (${weaknessCount} evaluations). Respecte les conventions TypeScript du projet: types explicites, nommage coherent, pas de any sauf necessite.`,
    spec_conformity: `ALERTE QUALITE: L'implementation s'ecarte souvent de la spec (${weaknessCount} evaluations). Verifie chaque acceptance criteria avant de terminer. Compare ton output avec les FR de la spec.`,
    // Spec rubric dimensions
    completeness: `ALERTE QUALITE: Les specs manquent de completude (${weaknessCount} evaluations). Assure-toi que chaque FR a des AC, que les edge cases sont couverts, et que les success criteria sont mesurables.`,
    traceability: `ALERTE QUALITE: La tracabilite est faible (${weaknessCount} evaluations). Chaque tache doit referencer un FR-XXX, chaque AC doit etre mappee a un test.`,
    clarity: `ALERTE QUALITE: Les specs manquent de clarte (${weaknessCount} evaluations). Utilise un langage precis, evite les ambiguites, definis les termes techniques.`,
    feasibility: `ALERTE QUALITE: La faisabilite est souvent mal evaluee (${weaknessCount} evaluations). Verifie les contraintes techniques, les dependances, et les risques avant de valider un plan.`,
  };

  return (
    instructions[dimensionName] ||
    `ALERTE QUALITE: La dimension "${dimensionName}" est systematiquement faible (${weaknessCount} evaluations). Porte une attention particuliere a cet aspect.`
  );
}

/**
 * Run double-loop analysis after a gate evaluation.
 * If weak dimensions are detected 3+ times, create feedback rules.
 */
export async function runDoubleLoopAnalysis(
  supabase: SupabaseClient | null,
  agentRole: string,
): Promise<{ rulesCreated: number; rulesUpdated: number }> {
  if (!supabase) return { rulesCreated: 0, rulesUpdated: 0 };

  const weaknesses = await detectWeakDimensions(supabase, agentRole);
  let rulesCreated = 0;
  let rulesUpdated = 0;

  for (const weakness of weaknesses) {
    const instruction = generateDoubleLoopInstruction(
      agentRole,
      weakness.dimensionName,
      weakness.count,
    );

    // Check if a double-loop rule already exists for this (role, dimension)
    const { data: existing } = await supabase
      .from("feedback_rules")
      .select("id, occurrences")
      .eq("agent_id", agentRole)
      .eq("pattern", `double_loop:${weakness.dimensionName}`)
      .maybeSingle();

    if (existing) {
      // Update existing rule
      await supabase
        .from("feedback_rules")
        .update({
          instruction,
          occurrences: weakness.count,
          active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      rulesUpdated++;
    } else {
      // Create new rule
      const { error } = await supabase.from("feedback_rules").insert({
        agent_id: agentRole,
        pattern: `double_loop:${weakness.dimensionName}`,
        instruction,
        occurrences: weakness.count,
        sprints: [],
        active: true,
        source: "double_loop",
      });

      if (!error) rulesCreated++;
    }
  }

  return { rulesCreated, rulesUpdated };
}

/**
 * Format double-loop rules for display.
 */
export async function formatDoubleLoopRules(supabase: SupabaseClient | null): Promise<string> {
  if (!supabase) return "Pas de connexion Supabase";

  const { data, error } = await supabase
    .from("feedback_rules")
    .select("agent_id, pattern, instruction, occurrences")
    .like("pattern", "double_loop:%")
    .eq("active", true)
    .order("occurrences", { ascending: false });

  if (error || !data || data.length === 0) return "Aucune regle double-loop active";

  const lines: string[] = ["Regles double-loop:"];
  for (const rule of data) {
    const dim = rule.pattern.replace("double_loop:", "");
    lines.push(`  ${rule.agent_id}/${dim} [${rule.occurrences}x]`);
  }
  return lines.join("\n");
}
