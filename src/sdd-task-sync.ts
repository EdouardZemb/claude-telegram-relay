/**
 * @module sdd-task-sync
 * @description Synchronization between SDD pipeline phases and task statuses.
 * Maps SDD phases to task lifecycle states and provides best-effort sync.
 *
 * Phase mapping:
 *   explore/discuss/spec/challenge -> in_progress
 *   implement/review -> review
 *   doc (ok) -> done
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "./logger.ts";
import type { SddPhase, StepStatus } from "./pipeline-tracker.ts";
import type { Task } from "./tasks.ts";
import { updateTaskStatus } from "./tasks.ts";

const log = createLogger("sdd-task-sync");

// ── Phase-to-Status Mapping ──────────────────────────────────

/**
 * Maps each SDD phase to the target task status when that phase completes successfully.
 */
export const PHASE_TO_TASK_STATUS: Record<SddPhase, Task["status"]> = {
  explore: "in_progress",
  discuss: "in_progress",
  spec: "in_progress",
  challenge: "in_progress",
  implement: "review",
  review: "review",
  doc: "done",
};

// Status progression order (higher index = further along)
const STATUS_ORDER: Task["status"][] = ["backlog", "in_progress", "review", "done"];

/**
 * Synchronize task status based on SDD phase completion.
 * Best-effort: logs warnings but never throws.
 *
 * Only syncs when stepStatus is "ok" (phase completed successfully).
 * Does not downgrade: if task is already in a later status, no-op.
 *
 * @param supabase - Supabase client
 * @param taskId - Task ID to update (undefined = no-op)
 * @param phase - SDD phase that completed
 * @param stepStatus - Status of the step ("ok" triggers sync)
 */
export async function syncTaskStatusForPhase(
  supabase: SupabaseClient,
  taskId: string | undefined,
  phase: SddPhase,
  stepStatus: StepStatus,
): Promise<void> {
  if (!taskId) {
    return; // No task linked — silent no-op
  }

  if (stepStatus !== "ok") {
    return; // Only sync on successful completion
  }

  const targetStatus = PHASE_TO_TASK_STATUS[phase];
  if (!targetStatus) {
    log.warn("Unknown phase for task sync", { phase, taskId });
    return;
  }

  try {
    // Check current task status to avoid downgrade
    const { data: currentTask, error: fetchError } = await supabase
      .from("tasks")
      .select("status")
      .eq("id", taskId)
      .single();

    if (fetchError || !currentTask) {
      log.warn("syncTaskStatus: task not found", { taskId, error: String(fetchError) });
      return;
    }

    const currentIdx = STATUS_ORDER.indexOf(currentTask.status);
    const targetIdx = STATUS_ORDER.indexOf(targetStatus);

    // Do not downgrade
    if (currentIdx >= targetIdx) {
      log.info("syncTaskStatus: skipping downgrade", {
        taskId,
        currentStatus: currentTask.status,
        targetStatus,
        phase,
      });
      return;
    }

    const updated = await updateTaskStatus(supabase, taskId, targetStatus);
    if (updated) {
      log.info("syncTaskStatus: updated", {
        taskId,
        from: currentTask.status,
        to: targetStatus,
        phase,
      });
    }
  } catch (error) {
    // Best-effort: log but don't throw
    log.warn("syncTaskStatus: error during sync", { taskId, phase, error: String(error) });
  }
}
