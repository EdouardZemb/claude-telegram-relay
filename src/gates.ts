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
 * Validates that the task has real BMad artefacts:
 * - acceptance_criteria (from story file or /plan)
 * - architecture_ref (from architect agent or manual)
 * - dev_notes (from story enrichment)
 *
 * A task passes if it has at least acceptance_criteria OR architecture_ref.
 * A description alone is not sufficient.
 */
export async function checkGate2_Architecture(
  supabase: SupabaseClient,
  task: { id: string; title: string; description: string | null }
): Promise<GateResult> {
  // Fetch full task data to check BMad artefacts
  const { data: fullTask } = await supabase
    .from("tasks")
    .select("acceptance_criteria, architecture_ref, dev_notes, subtasks")
    .eq("id", task.id)
    .single();

  const hasAcceptanceCriteria = fullTask?.acceptance_criteria && fullTask.acceptance_criteria.trim().length > 0;
  const hasArchitectureRef = fullTask?.architecture_ref && fullTask.architecture_ref.trim().length > 0;
  const hasDevNotes = fullTask?.dev_notes && fullTask.dev_notes.trim().length > 0;
  const hasSubtasks = Array.isArray(fullTask?.subtasks) && fullTask.subtasks.length > 0;

  // Pass if task has at least acceptance criteria or architecture ref
  if (hasAcceptanceCriteria || hasArchitectureRef) {
    const artefacts: string[] = [];
    if (hasAcceptanceCriteria) artefacts.push("acceptance criteria");
    if (hasArchitectureRef) artefacts.push("architecture ref");
    if (hasDevNotes) artefacts.push("dev notes");
    if (hasSubtasks) artefacts.push(`${fullTask.subtasks.length} subtasks`);
    return {
      passed: true,
      gate: "GATE 2 — Architecture",
      reason: `Artefacts BMad valides: ${artefacts.join(", ")}.`,
      overridable: false,
    };
  }

  // Build helpful message about what's missing
  const missing: string[] = [];
  if (!hasAcceptanceCriteria) missing.push("acceptance criteria (Given/When/Then)");
  if (!hasArchitectureRef) missing.push("architecture ref");

  return {
    passed: false,
    gate: "GATE 2 — Architecture",
    reason: `La tache "${task.title}" n'a pas d'artefacts BMad suffisants.\nManquant: ${missing.join(", ")}.\n\nUtilise /plan pour generer des story files, ou /orchestrate pour le pipeline complet.`,
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

// ── Gate Override Tracking (persisted in workflow_audit) ──────

/**
 * Record that a user explicitly overrode a gate for a task.
 * Persisted in workflow_audit table so overrides survive restarts.
 */
export async function overrideGate(supabase: SupabaseClient, taskId: string, gateName: string): Promise<void> {
  const { error } = await supabase.from("workflow_audit").insert({
    task_id: taskId,
    action: "gate_override",
    field: gateName,
    from_value: "blocked",
    to_value: "overridden",
    reason: "User override via Telegram button",
  });
  if (error) console.error("overrideGate error:", error);
}

/**
 * Check if a gate was overridden for a task.
 * Reads from workflow_audit table.
 */
export async function isGateOverridden(supabase: SupabaseClient, taskId: string, gateName: string): Promise<boolean> {
  const { data } = await supabase
    .from("workflow_audit")
    .select("id")
    .eq("task_id", taskId)
    .eq("action", "gate_override")
    .eq("field", gateName)
    .eq("to_value", "overridden")
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Clear all overrides for a task (after exec completes).
 * Marks them as consumed in workflow_audit.
 */
export async function clearGateOverrides(supabase: SupabaseClient, taskId: string): Promise<void> {
  const { error } = await supabase
    .from("workflow_audit")
    .update({ to_value: "consumed" })
    .eq("task_id", taskId)
    .eq("action", "gate_override")
    .eq("to_value", "overridden");
  if (error) console.error("clearGateOverrides error:", error);
}

/**
 * Run all gates, respecting overrides (persisted in DB).
 * Returns the first non-overridden failing gate, or null if all pass/overridden.
 */
export async function checkGatesWithOverrides(
  supabase: SupabaseClient,
  task: { id: string; title: string; description: string | null; project: string; sprint: string | null }
): Promise<GateResult | null> {
  const gate1 = await checkGate1_PRD(supabase, task);
  if (!gate1.passed && !(await isGateOverridden(supabase, task.id, gate1.gate))) return gate1;

  const gate2 = await checkGate2_Architecture(supabase, task);
  if (!gate2.passed && !(await isGateOverridden(supabase, task.id, gate2.gate))) return gate2;

  return null;
}
