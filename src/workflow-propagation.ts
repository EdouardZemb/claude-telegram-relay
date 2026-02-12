/**
 * Workflow Propagation — Cross-Project Improvement Sharing
 *
 * When a project's retro suggests workflow improvements (gate changes,
 * checkpoint adjustments), those improvements can propagate to other
 * projects via a voting mechanism.
 *
 * Flow:
 * 1. Project A's retro suggests "lighten Gate 2 for small tasks"
 * 2. The suggestion is recorded as a proposal
 * 3. When Project B's retro independently suggests the same thing, it counts as a vote
 * 4. When a proposal reaches the threshold (default: 2 votes), it's promoted
 *    to the reference template (config/bmad-templates/)
 *
 * S15-09: Cross-project propagation
 * S15-10: Gate allegement voting
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

export interface WorkflowProposal {
  id: string;
  created_at: string;
  proposal_type: "gate_change" | "checkpoint_change" | "workflow_adjustment";
  target: string; // e.g., "gate_2", "checkpoint_review", "step_execution"
  description: string;
  suggested_value: string; // e.g., "mode: light", "skip_for_priority_lte: 3"
  source_project_id: string;
  source_sprint: string;
  votes: string[]; // project_ids that voted for this
  status: "pending" | "promoted" | "rejected";
  promoted_at: string | null;
}

// ── Database Operations ──────────────────────────────────────

const VOTE_THRESHOLD = 2; // Number of projects needed to promote a proposal

/**
 * Create or vote on a workflow improvement proposal.
 * If a similar proposal exists, add a vote. If not, create a new one.
 */
export async function proposeWorkflowChange(
  supabase: SupabaseClient,
  proposal: {
    type: "gate_change" | "checkpoint_change" | "workflow_adjustment";
    target: string;
    description: string;
    suggestedValue: string;
    projectId: string;
    sprint: string;
  }
): Promise<{ isNew: boolean; votes: number; promoted: boolean }> {
  // Check for existing similar proposal
  const { data: existing } = await supabase
    .from("workflow_proposals")
    .select("*")
    .eq("proposal_type", proposal.type)
    .eq("target", proposal.target)
    .eq("suggested_value", proposal.suggestedValue)
    .eq("status", "pending")
    .limit(1);

  if (existing && existing.length > 0) {
    const existingProposal = existing[0] as WorkflowProposal;
    const votes = existingProposal.votes || [];

    // Don't double-count votes from the same project
    if (votes.includes(proposal.projectId)) {
      return { isNew: false, votes: votes.length, promoted: false };
    }

    const newVotes = [...votes, proposal.projectId];
    const shouldPromote = newVotes.length >= VOTE_THRESHOLD;

    await supabase
      .from("workflow_proposals")
      .update({
        votes: newVotes,
        status: shouldPromote ? "promoted" : "pending",
        promoted_at: shouldPromote ? new Date().toISOString() : null,
      })
      .eq("id", existingProposal.id);

    return { isNew: false, votes: newVotes.length, promoted: shouldPromote };
  }

  // Create new proposal
  const { error } = await supabase.from("workflow_proposals").insert({
    proposal_type: proposal.type,
    target: proposal.target,
    description: proposal.description,
    suggested_value: proposal.suggestedValue,
    source_project_id: proposal.projectId,
    source_sprint: proposal.sprint,
    votes: [proposal.projectId],
    status: "pending",
  });

  if (error) {
    console.error("proposeWorkflowChange error:", error);
    return { isNew: true, votes: 0, promoted: false };
  }

  return { isNew: true, votes: 1, promoted: false };
}

/**
 * Get all pending proposals.
 */
export async function getPendingProposals(
  supabase: SupabaseClient
): Promise<WorkflowProposal[]> {
  const { data, error } = await supabase
    .from("workflow_proposals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getPendingProposals error:", error);
    return [];
  }
  return (data ?? []) as WorkflowProposal[];
}

/**
 * Get promoted proposals that haven't been applied yet.
 */
export async function getPromotedProposals(
  supabase: SupabaseClient
): Promise<WorkflowProposal[]> {
  const { data, error } = await supabase
    .from("workflow_proposals")
    .select("*")
    .eq("status", "promoted")
    .order("promoted_at", { ascending: false });

  if (error) {
    console.error("getPromotedProposals error:", error);
    return [];
  }
  return (data ?? []) as WorkflowProposal[];
}

/**
 * Reject a proposal.
 */
export async function rejectProposal(
  supabase: SupabaseClient,
  proposalId: string
): Promise<boolean> {
  const { error } = await supabase
    .from("workflow_proposals")
    .update({ status: "rejected" })
    .eq("id", proposalId);

  return !error;
}

/**
 * Extract workflow change suggestions from a retro's actions.
 * Looks for patterns like "alleger gate X", "changer checkpoint Y".
 */
export function extractProposalsFromRetro(
  retro: {
    sprint: string;
    actions?: Array<{ action: string; accepted?: boolean }>;
    improvements?: string[];
  },
  projectId: string
): Array<{
  type: "gate_change" | "checkpoint_change" | "workflow_adjustment";
  target: string;
  description: string;
  suggestedValue: string;
}> {
  const proposals: Array<{
    type: "gate_change" | "checkpoint_change" | "workflow_adjustment";
    target: string;
    description: string;
    suggestedValue: string;
  }> = [];

  const actions = retro.actions || [];
  const improvements = retro.improvements || [];
  const texts = [
    ...actions.filter((a) => a.accepted).map((a) => a.action),
    ...improvements,
  ];

  for (const text of texts) {
    const lower = text.toLowerCase();

    // Detect gate changes
    const gateMatch = lower.match(/(?:all[eé]ger|relax|assouplir|d[eé]sactiver)\s+(?:la\s+)?gate\s*(\d)/);
    if (gateMatch) {
      proposals.push({
        type: "gate_change",
        target: `gate_${gateMatch[1]}`,
        description: text,
        suggestedValue: "mode: light",
      });
      continue;
    }

    // Detect checkpoint changes
    const checkpointMatch = lower.match(/(?:all[eé]ger|relax|passer en light)\s+(?:le\s+)?checkpoint\s+(\w+)/);
    if (checkpointMatch) {
      proposals.push({
        type: "checkpoint_change",
        target: `checkpoint_${checkpointMatch[1]}`,
        description: text,
        suggestedValue: "mode: light",
      });
      continue;
    }

    // Detect skip conditions
    const skipMatch = lower.match(/(?:skip|ignorer|passer)\s+(?:pour\s+)?(?:les?\s+)?(?:taches?\s+)?(?:p([3-5])|priori(?:t[eé])?\s*(?:basse|faible|<=?\s*(\d)))/);
    if (skipMatch) {
      const priority = skipMatch[1] || skipMatch[2] || "3";
      proposals.push({
        type: "workflow_adjustment",
        target: "skip_condition",
        description: text,
        suggestedValue: `priority_lte: ${priority}`,
      });
    }
  }

  return proposals;
}

// ── Formatting ───────────────────────────────────────────────

export function formatProposals(proposals: WorkflowProposal[]): string {
  if (proposals.length === 0) return "Aucune proposition en cours.";

  const lines = ["PROPOSITIONS WORKFLOW CROSS-PROJETS", ""];

  for (const p of proposals) {
    const votes = p.votes.length;
    const bar = "o".repeat(votes) + ".".repeat(Math.max(0, VOTE_THRESHOLD - votes));
    lines.push(`[${bar}] ${p.target} — ${p.description}`);
    lines.push(`  Valeur: ${p.suggested_value}`);
    lines.push(`  Votes: ${votes}/${VOTE_THRESHOLD} | Source: sprint ${p.source_sprint}`);
    lines.push(`  Statut: ${p.status.toUpperCase()}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}
