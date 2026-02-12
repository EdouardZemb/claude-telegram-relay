/**
 * Unit Tests — src/workflow-propagation.ts
 *
 * Tests for cross-project workflow proposal extraction and formatting.
 */

import { describe, it, expect } from "bun:test";
import {
  extractProposalsFromRetro,
  formatProposals,
  type WorkflowProposal,
} from "../../src/workflow-propagation";

describe("extractProposalsFromRetro", () => {
  it("extracts proposals from retro actions", () => {
    const retroData = {
      sprint: "S16",
      actions: [
        { action: "Ajouter des tests automatiques", priority: "haute" },
        { action: "Ameliorer la documentation", priority: "moyenne" },
      ],
    };

    const proposals = extractProposalsFromRetro(retroData, "project-1");
    expect(Array.isArray(proposals)).toBe(true);
  });

  it("handles empty actions", () => {
    const retroData = { sprint: "S15", actions: [] };
    const proposals = extractProposalsFromRetro(retroData, "project-1");
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.length).toBe(0);
  });
});

describe("formatProposals", () => {
  it("formats empty proposals", () => {
    const output = formatProposals([]);
    expect(output).toContain("Aucune proposition");
  });

  it("formats proposals with correct structure", () => {
    const proposals: WorkflowProposal[] = [
      {
        id: "p1",
        created_at: new Date().toISOString(),
        proposal_type: "gate_change",
        target: "testing",
        description: "Ajouter tests automatiques",
        suggested_value: "mode: strict",
        source_project_id: "proj-1",
        source_sprint: "S16",
        votes: ["proj-1", "proj-2"],
        status: "pending",
        promoted_at: null,
      },
    ];

    const output = formatProposals(proposals);
    expect(output).toContain("PROPOSITIONS WORKFLOW");
    expect(output).toContain("testing");
    expect(output).toContain("Ajouter tests automatiques");
    expect(output).toContain("PENDING");
  });
});
