import { describe, expect, it } from "bun:test";
import { getAction } from "../../src/action-registry.ts";
import { _resetSessions, getSession } from "../../src/conversation-session.ts";
import { detectIntent } from "../../src/intent-detection.ts";
import { explainPipelineChoice } from "../../src/pipeline-selection.ts";
import type { PRDSessionConstraints } from "../../src/prd.ts";

// ── Pipeline Explanation Tests ────────────────────────────────

describe("explainPipelineChoice", () => {
  it("explains SOLO pipeline", () => {
    const result = explainPipelineChoice(["dev"], 0.15);
    expect(result).toContain("dev");
    expect(result).toContain("15%");
    expect(result).toContain("simple");
  });

  it("explains LIGHT pipeline", () => {
    const result = explainPipelineChoice(["planner", "dev", "qa"], 0.45);
    expect(result).toContain("planner");
    expect(result).toContain("45%");
  });

  it("explains DEFAULT pipeline", () => {
    const result = explainPipelineChoice(["analyst", "pm", "architect", "dev", "qa"], 0.75);
    expect(result).toContain("complexe");
    expect(result).toContain("75%");
  });

  it("explains QUICK pipeline", () => {
    const result = explainPipelineChoice(["dev", "qa"]);
    expect(result).toContain("dev");
    expect(result).toContain("qa");
  });

  it("explains REVIEW pipeline", () => {
    const result = explainPipelineChoice(["qa", "architect"]);
    expect(result).toContain("architecte");
  });

  it("explains RESEARCH pipeline", () => {
    const result = explainPipelineChoice(["explorer", "planner", "dev", "qa"]);
    expect(result).toContain("Recherche");
  });

  it("handles unknown pipeline gracefully", () => {
    const result = explainPipelineChoice(["custom", "roles"] as any);
    expect(result).toContain("Pipeline");
  });

  it("works without difficulty score", () => {
    const result = explainPipelineChoice(["dev"]);
    expect(result).not.toContain("%");
    expect(result).toContain("dev");
  });
});

// ── Intent Detection: suggest_prd ─────────────────────────────

describe("intent detection - suggest_prd", () => {
  it("detects 'je voudrais ajouter X'", () => {
    const result = detectIntent("je voudrais ajouter un systeme de cache");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");
    expect(result.detected!.command).toBe("prd_workflow");
  });

  it("detects 'il faudrait que le bot fasse X'", () => {
    const result = detectIntent("il faudrait que le bot envoie des rappels automatiques");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");
  });

  it("detects 'on a besoin de X'", () => {
    const result = detectIntent("on a besoin d'un dashboard ameliore");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");
  });

  it("detects 'nouvelle fonctionnalite'", () => {
    const result = detectIntent("nouvelle fonctionnalite de recherche avancee");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");
  });

  it("detects 'implemente X'", () => {
    const result = detectIntent("implemente un systeme de notifications push");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");
  });

  it("extracts description from args", () => {
    const result = detectIntent("je voudrais ajouter un export CSV");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.args).toContain("export CSV");
  });

  it("does not match simple messages", () => {
    const result = detectIntent("bonjour comment vas-tu");
    expect(result.detected?.intent).not.toBe("suggest_prd");
  });
});

// ── Action Registry: prd_workflow ─────────────────────────────

describe("action registry - prd_workflow", () => {
  it("has prd_workflow action registered", () => {
    const action = getAction("prd_workflow");
    expect(action).toBeDefined();
    expect(action!.command).toBe("prd_workflow");
    expect(action!.risk).toBe("medium");
    expect(action!.module).toBe("planning");
  });
});

// ── Conversation Session: PRD workflow fields ─────────────────

describe("conversation session - PRD workflow fields", () => {
  it("supports activePrdId field", () => {
    _resetSessions();
    const session = getSession(99999);
    expect(session.activePrdId).toBeUndefined();
    session.activePrdId = "test-prd-id";
    expect(session.activePrdId).toBe("test-prd-id");
  });

  it("supports prdWorkflowStep field", () => {
    _resetSessions();
    const session = getSession(99998);
    expect(session.prdWorkflowStep).toBeUndefined();
    session.prdWorkflowStep = "triage";
    expect(session.prdWorkflowStep).toBe("triage");
    session.prdWorkflowStep = "revision";
    expect(session.prdWorkflowStep).toBe("revision");
  });
});

// ── PRD Session Constraints ───────────────────────────────────

describe("PRD session constraints type", () => {
  it("can be constructed with all fields", () => {
    const constraints: PRDSessionConstraints = {
      speed: "fast",
      quality: "high",
      budget: "low",
      scope: "minimal",
      deadline: "vendredi",
    };
    expect(constraints.speed).toBe("fast");
    expect(constraints.quality).toBe("high");
    expect(constraints.budget).toBe("low");
  });

  it("can be empty", () => {
    const constraints: PRDSessionConstraints = {};
    expect(constraints.speed).toBeUndefined();
  });
});
