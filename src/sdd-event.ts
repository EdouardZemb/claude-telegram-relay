/**
 * @module sdd-event
 * @description Best-effort SDD verdict emission to agent_events.
 * Extracted from job-manager to respect the S3 LOC threshold.
 * Imported via dynamic require in job-manager (fire-and-forget path).
 */

import { createLogger } from "./logger.ts";
import { PHASE_TO_AGENT_ROLE } from "./sdd-agents.ts";

const log = createLogger("sdd-event");

/** Regex to extract SDD verdict from a job result string. */
const VERDICT_REGEX =
  /^SDD_\w+_(GO_WITH_CHANGES|NO-GO|GO|OK|FAILED|PIVOT|DROP|APPROVED|CHANGES_REQUESTED):/;

/**
 * Emit an sdd_verdict event to agent_events (best-effort, never throws).
 * Reads Supabase credentials lazily via getConfig().
 *
 * @param jobId   - Used as session_id (unique per run, F-SS-8)
 * @param jobType - Full job type string, e.g. "sdd-challenge:my-feature"
 * @param result  - Job result string (SDD_* prefixed)
 */
export async function emitSddVerdict(
  jobId: string,
  jobType: string,
  result: string | null,
): Promise<void> {
  try {
    const ci = jobType.indexOf(":");
    if (ci === -1) return;
    const sddPhase = jobType.substring(4, ci).toLowerCase();
    const pipelineName = jobType.substring(ci + 1);
    const agentRole = PHASE_TO_AGENT_ROLE[sddPhase] ?? sddPhase;
    const verdict = result?.match(VERDICT_REGEX)?.[1] ?? "FAILED";
    const details = result?.replace(/^SDD_\w+:\s*/, "").substring(0, 200);
    const { getConfig } = await import("./config.ts");
    const { createClient } = await import("@supabase/supabase-js");
    const cfg = getConfig();
    const { error } = await createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
      .from("agent_events")
      .insert({
        session_id: jobId,
        agent_role: agentRole,
        event_type: "sdd_verdict",
        payload: { verdict, source: sddPhase, pipelineName, details },
      });
    if (error) log.warn("emitSddVerdict failed", { error: String(error), sddPhase });
    else log.info("emitSddVerdict: emitted", { agentRole, sddPhase, verdict });
  } catch (err) {
    log.warn("emitSddVerdict: error", { error: String(err) });
  }
}
