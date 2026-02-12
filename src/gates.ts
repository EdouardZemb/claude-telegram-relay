/**
 * BMad Gates — Strict workflow validation
 *
 * Enforces the BMad methodology gates:
 * Gate 1: No implementation (/exec) without an approved PRD
 * Gate 2: No code without validated architecture (readiness check)
 * Gate 3: No merge without code review (handled in CI/PR flow)
 *
 * Gates can be bypassed with explicit user override via Telegram buttons.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface GateResult {
  passed: boolean;
  gate: string;
  reason: string;
  /** If gate fails, can user override it? */
  overridable: boolean;
}

/**
 * Check Gate 1: Does this task have an approved PRD?
 *
 * Looks for a PRD with status "approved" in the same project.
 * If the task's sprint has associated PRDs, checks those.
 */
export async function checkGate1_PRD(
  supabase: SupabaseClient,
  task: { project: string; sprint: string | null; title: string }
): Promise<GateResult> {
  // Check for any approved PRD in the task's project
  const { data: prds } = await supabase
    .from("prds")
    .select("id, title, status")
    .eq("project", task.project)
    .eq("status", "approved")
    .limit(1);

  if (prds && prds.length > 0) {
    return {
      passed: true,
      gate: "GATE 1 — PRD",
      reason: `PRD approuve: ${prds[0].title} [${prds[0].id.substring(0, 8)}]`,
      overridable: false,
    };
  }

  // Check for any draft PRDs that haven't been approved yet
  const { data: drafts } = await supabase
    .from("prds")
    .select("id, title, status")
    .eq("project", task.project)
    .eq("status", "draft")
    .limit(3);

  if (drafts && drafts.length > 0) {
    const draftList = drafts
      .map((d: { id: string; title: string }) => `  ${d.id.substring(0, 8)} — ${d.title}`)
      .join("\n");
    return {
      passed: false,
      gate: "GATE 1 — PRD",
      reason: `Aucun PRD approuve pour le projet "${task.project}". PRDs en brouillon:\n${draftList}\n\nApprouve un PRD avant de lancer /exec, ou force le bypass.`,
      overridable: true,
    };
  }

  return {
    passed: false,
    gate: "GATE 1 — PRD",
    reason: `Aucun PRD pour le projet "${task.project}". Cree d'abord un PRD avec /prd <description>.`,
    overridable: true,
  };
}

/**
 * Check Gate 2: Architecture readiness.
 *
 * For now, checks if the task has dev_notes or architecture_ref populated
 * (story file enrichment). In a full BMad implementation, this would
 * check for a validated architecture document.
 */
export async function checkGate2_Architecture(
  supabase: SupabaseClient,
  task: { id: string; title: string; description: string | null }
): Promise<GateResult> {
  // A task with sufficient description/notes is considered architecture-ready
  // This gate becomes stricter as we add story files (S14-04)
  const hasDescription = task.description && task.description.length > 20;

  if (hasDescription) {
    return {
      passed: true,
      gate: "GATE 2 — Architecture",
      reason: "Tache documentee, prete pour l'implementation.",
      overridable: false,
    };
  }

  return {
    passed: false,
    gate: "GATE 2 — Architecture",
    reason: `La tache "${task.title}" manque de contexte technique. Ajoute une description detaillee ou utilise /plan pour structurer.`,
    overridable: true,
  };
}

/**
 * Run all gates for a task before /exec.
 * Returns the first failing gate, or null if all pass.
 */
export async function checkAllGates(
  supabase: SupabaseClient,
  task: { id: string; title: string; description: string | null; project: string; sprint: string | null }
): Promise<GateResult | null> {
  const gate1 = await checkGate1_PRD(supabase, task);
  if (!gate1.passed) return gate1;

  const gate2 = await checkGate2_Architecture(supabase, task);
  if (!gate2.passed) return gate2;

  return null; // All gates passed
}

// ── Gate Override Tracking ────────────────────────────────────

/**
 * Track active gate overrides.
 * Key: taskId, Value: set of gate names that were overridden.
 */
const gateOverrides = new Map<string, Set<string>>();

/** Record that a user explicitly overrode a gate for a task */
export function overrideGate(taskId: string, gateName: string): void {
  const overrides = gateOverrides.get(taskId) || new Set();
  overrides.add(gateName);
  gateOverrides.set(taskId, overrides);
}

/** Check if a gate was overridden for a task */
export function isGateOverridden(taskId: string, gateName: string): boolean {
  return gateOverrides.get(taskId)?.has(gateName) || false;
}

/** Clear all overrides for a task (after exec completes) */
export function clearGateOverrides(taskId: string): void {
  gateOverrides.delete(taskId);
}

/**
 * Run all gates, respecting overrides.
 * Returns the first non-overridden failing gate, or null if all pass/overridden.
 */
export async function checkGatesWithOverrides(
  supabase: SupabaseClient,
  task: { id: string; title: string; description: string | null; project: string; sprint: string | null }
): Promise<GateResult | null> {
  const gate1 = await checkGate1_PRD(supabase, task);
  if (!gate1.passed && !isGateOverridden(task.id, gate1.gate)) return gate1;

  const gate2 = await checkGate2_Architecture(supabase, task);
  if (!gate2.passed && !isGateOverridden(task.id, gate2.gate)) return gate2;

  return null;
}
