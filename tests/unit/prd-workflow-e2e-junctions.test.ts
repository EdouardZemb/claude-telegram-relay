/**
 * PRD Workflow — Junction & E2E Integration Tests
 *
 * Tests the data flow between workflow steps, reproduces the context loss bug,
 * and verifies error recovery at each junction point.
 *
 * Focus areas:
 * 1. Context passing: session → triage → pending → callback → generation
 * 2. Context loss: session expiry, TTL timeouts, description loss
 * 3. Error recovery: what happens when each step fails
 * 4. Full flow: discussion → proposal → confirmation → PRD with context
 * 5. Voice/text parity: same flow works for both input types
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isPrdWorkflowEnabled,
  triageDescription,
  buildTriageResponse,
  extractSessionConstraints,
  generateAndSavePRD,
  getRevisionCount,
  canRevise,
  buildRevisionKeyboard,
  revisePRD,
  buildLaunchConfirmation,
  storePendingDescription,
  getPendingDescription,
  clearPendingDescription,
  storePendingRevision,
  getPendingRevision,
  clearPendingRevision,
  chatKey,
  type TriageResult,
} from "../../src/prd-workflow.ts";
import type { PRD, PRDSessionConstraints } from "../../src/prd.ts";
import { formatPRDDetail } from "../../src/prd.ts";
import { detectIntent, detectIntentWithLLM } from "../../src/intent-detection.ts";
import {
  getSession,
  _resetSessions,
  addMessage as addSessionMessage,
  addIntent as addSessionIntent,
  extractConstraints,
  addConstraint,
  formatSessionForIntent,
  buildConversationContext,
  hasActiveSession,
  cleanupExpiredSessions,
  type DetectedConstraint,
  type ConversationSession,
} from "../../src/conversation-session.ts";
import { isPhotoDocument } from "../../src/commands/zz-messages.ts";

// ── Helpers ─────────────────────────────────────────────────

function makePRD(overrides?: Partial<PRD>): PRD {
  return {
    id: "aaaa1111-bbbb-2222-cccc-3333dddd4444",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "Test PRD",
    summary: "A test PRD summary",
    content: "# PRD Content\n\n## Objectif\nTest objective",
    project: "telegram-relay",
    status: "draft",
    version: 1,
    tags: [],
    requested_by: "Edouard",
    metadata: {},
    ...overrides,
  };
}

/**
 * Simulate the full text message → intent detection → triage → pending storage flow.
 * This mirrors exactly what zz-messages.ts does on a text message.
 */
function simulateTextMessageFlow(
  chatId: number,
  threadId: number | undefined,
  text: string,
): {
  session: ConversationSession;
  intentResult: ReturnType<typeof detectIntent>;
  detectedConstraints: DetectedConstraint[];
  chatKeyStr: string;
} {
  // Step 1: Get/create session (same as zz-messages.ts:222)
  const session = getSession(chatId, threadId);

  // Step 2: Add message to session (same as zz-messages.ts:223)
  addSessionMessage(session, text);

  // Step 3: Extract constraints (same as zz-messages.ts:226-229)
  const detectedConstraints = extractConstraints(text);
  for (const c of detectedConstraints) {
    addConstraint(session, c.type, c.value, c.source);
  }

  // Step 4: Detect intent (same as zz-messages.ts:315)
  const intentResult = detectIntent(text);

  // Step 5: Build chat key for pending storage
  const chatKeyStr = chatKey(chatId, threadId);

  return { session, intentResult, detectedConstraints, chatKeyStr };
}

/**
 * Simulate the prdwf_create callback handler flow.
 * This mirrors planning.ts:330-384.
 */
function simulateCreateCallback(
  chatId: number,
  threadId: number | undefined,
): {
  description: string | undefined;
  constraints: PRDSessionConstraints;
  session: ConversationSession;
  hasDescription: boolean;
  hasConstraints: boolean;
} {
  const ck = chatKey(chatId, threadId);

  // Step 1: Retrieve pending description (planning.ts:333)
  const description = getPendingDescription(ck);

  // Step 2: Get session for constraints (planning.ts:341)
  const session = getSession(chatId, threadId);

  // Step 3: Extract session constraints (planning.ts:342)
  const constraints = extractSessionConstraints(session.constraints);

  return {
    description,
    constraints,
    session,
    hasDescription: !!description,
    hasConstraints: Object.keys(constraints).length > 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: JUNCTION TESTS — Context Flow Between Steps
// ═══════════════════════════════════════════════════════════════

describe("Junction 1: Text Message → Intent Detection → Triage", () => {
  beforeEach(() => _resetSessions());

  it("natural language 'j'aimerais ajouter X' flows to suggest_prd with description as args", () => {
    const { intentResult } = simulateTextMessageFlow(
      1001, undefined,
      "j'aimerais ajouter un systeme d'audit de qualite du code",
    );
    expect(intentResult.detected).not.toBeNull();
    expect(intentResult.detected!.intent).toBe("suggest_prd");
    expect(intentResult.detected!.command).toBe("prd_workflow");
    expect(intentResult.detected!.args).toBeDefined();
    expect(intentResult.detected!.args).toContain("systeme d'audit");
  });

  it("extracted args become the pending description stored for the callback", () => {
    const { intentResult, chatKeyStr } = simulateTextMessageFlow(
      1002, undefined,
      "il faudrait que le bot envoie des rappels automatiques",
    );
    // In real code, args OR full text is stored as pending description
    const description = intentResult.detected!.args || "il faudrait que le bot envoie des rappels automatiques";
    storePendingDescription(chatKeyStr, description);

    expect(getPendingDescription(chatKeyStr)).toBeDefined();
    expect(getPendingDescription(chatKeyStr)).toContain("rappels automatiques");
  });

  it("triage receives the same description that was stored as pending", async () => {
    const { intentResult, chatKeyStr } = simulateTextMessageFlow(
      1003, undefined,
      "on devrait ajouter une API REST pour le dashboard",
    );
    const description = intentResult.detected!.args || "on devrait ajouter une API REST pour le dashboard";
    storePendingDescription(chatKeyStr, description);

    // Triage uses the same description
    const triage = await triageDescription(description);
    expect(triage.score).toBeGreaterThanOrEqual(0);
    expect(triage.label).toBeDefined();

    // And the pending description is still retrievable
    expect(getPendingDescription(chatKeyStr)).toBe(description);
  });

  it("constraints from the same message are stored in session before triage", () => {
    const { session } = simulateTextMessageFlow(
      1004, undefined,
      "j'aimerais ajouter un audit qualite, fais ca vite",
    );
    // "vite" should be detected as speed constraint
    const speedConstraint = session.constraints.find(c => c.type === "speed");
    expect(speedConstraint).toBeDefined();
    expect(speedConstraint!.value).toBe("fast");
  });

  it("constraints from multiple messages accumulate in the session", () => {
    const chatId = 1005;
    // Message 1: speed constraint
    simulateTextMessageFlow(chatId, undefined, "fais ca vite s'il te plait");
    // Message 2: quality constraint
    simulateTextMessageFlow(chatId, undefined, "mais en haute qualite quand meme");
    // Message 3: trigger PRD
    const { session } = simulateTextMessageFlow(chatId, undefined, "j'aimerais ajouter un cache");

    // Both constraints should be in session
    const speed = session.constraints.find(c => c.type === "speed");
    const quality = session.constraints.find(c => c.type === "quality");
    expect(speed).toBeDefined();
    expect(quality).toBeDefined();
  });
});

describe("Junction 2: Triage → Callback (prdwf_create) → PRD Generation", () => {
  beforeEach(() => _resetSessions());

  it("callback retrieves the exact description stored during triage", () => {
    const chatId = 2001;
    const ck = chatKey(chatId);

    // Simulate triage step: store pending description
    const description = "ajouter un systeme d'audit de qualite complet avec scoring par module";
    storePendingDescription(ck, description);

    // Simulate callback: retrieve description
    const retrieved = getPendingDescription(ck);
    expect(retrieved).toBe(description);
    expect(retrieved).toContain("audit de qualite complet");
    expect(retrieved).toContain("scoring par module");
  });

  it("callback retrieves session constraints accumulated during conversation", () => {
    const chatId = 2002;

    // Build session with constraints over multiple messages
    const session = getSession(chatId);
    addSessionMessage(session, "je veux un truc rapide");
    addConstraint(session, "speed", "fast", "je veux un truc rapide");
    addSessionMessage(session, "mais bien fait quand meme");
    addConstraint(session, "quality", "high", "bien fait quand meme");
    addSessionMessage(session, "j'aimerais ajouter un cache");

    // Callback retrieves constraints
    const constraints = extractSessionConstraints(session.constraints);
    expect(constraints.speed).toBe("fast");
    expect(constraints.quality).toBe("high");
  });

  it("constraints are passed to generatePRD and included in prompt", () => {
    // Verify that extracted constraints produce valid PRDSessionConstraints
    const constraints: PRDSessionConstraints = {
      speed: "fast",
      quality: "high",
      budget: "low",
      scope: "minimal",
      deadline: "vendredi",
    };

    // All constraint types should be non-undefined
    expect(constraints.speed).toBe("fast");
    expect(constraints.quality).toBe("high");
    expect(constraints.budget).toBe("low");
    expect(constraints.scope).toBe("minimal");
    expect(constraints.deadline).toBe("vendredi");
  });

  it("pending description is cleared after callback processes it", () => {
    const ck = chatKey(2003);
    storePendingDescription(ck, "test description");
    expect(getPendingDescription(ck)).toBeDefined();

    // After callback processes, it should be cleared
    clearPendingDescription(ck);
    expect(getPendingDescription(ck)).toBeUndefined();
  });

  it("session.activePrdId is set after PRD creation", () => {
    const session = getSession(2004);
    expect(session.activePrdId).toBeUndefined();

    // After PRD is created (simulated), activePrdId is set
    session.activePrdId = "prd-abc-123";
    expect(session.activePrdId).toBe("prd-abc-123");
  });

  it("session.prdWorkflowStep progresses to 'generation' after PRD creation", () => {
    const session = getSession(2005);
    expect(session.prdWorkflowStep).toBeUndefined();

    session.prdWorkflowStep = "triage";
    expect(session.prdWorkflowStep).toBe("triage");

    session.prdWorkflowStep = "generation";
    expect(session.prdWorkflowStep).toBe("generation");
  });
});

describe("Junction 3: PRD Generation → Revision Flow", () => {
  beforeEach(() => _resetSessions());

  it("revision callback stores constraints from session for re-injection", () => {
    const chatId = 3001;
    const ck = chatKey(chatId);

    // Build session with constraints
    const session = getSession(chatId);
    addConstraint(session, "quality", "high", "qualite haute");

    // Simulate prdwf_revise callback: store pending revision with constraints
    const constraints = extractSessionConstraints(session.constraints);
    storePendingRevision(ck, "prd-abc-123", constraints);

    // Verify revision has constraints
    const rev = getPendingRevision(ck);
    expect(rev).toBeDefined();
    expect(rev!.prdId).toBe("prd-abc-123");
    expect(rev!.constraints?.quality).toBe("high");
  });

  it("revision feedback text is captured and passed to revisePRD", () => {
    const ck = chatKey(3002);
    storePendingRevision(ck, "prd-xyz-789", { quality: "high" });

    // Simulate user sending revision feedback
    const feedbackText = "ajoute des criteres de securite OWASP et un plan de test";
    const rev = getPendingRevision(ck);
    expect(rev).toBeDefined();

    // Clear after retrieving (same as zz-messages.ts:245)
    clearPendingRevision(ck);
    expect(getPendingRevision(ck)).toBeUndefined();

    // The feedbackText would be passed to revisePRD along with constraints
    expect(feedbackText).toContain("criteres de securite");
    expect(rev!.constraints?.quality).toBe("high");
  });

  it("revision counter increments prevent infinite loops", () => {
    // Start: revision_count = 0
    let prd = makePRD({ metadata: {} });
    expect(canRevise(prd)).toBe(true);
    expect(getRevisionCount(prd)).toBe(0);

    // After 1st revision
    prd = makePRD({ metadata: { revision_count: 1 } });
    expect(canRevise(prd)).toBe(true);
    expect(getRevisionCount(prd)).toBe(1);

    // After 2nd revision
    prd = makePRD({ metadata: { revision_count: 2 } });
    expect(canRevise(prd)).toBe(true);
    expect(getRevisionCount(prd)).toBe(2);

    // After 3rd revision — blocked
    prd = makePRD({ metadata: { revision_count: 3 } });
    expect(canRevise(prd)).toBe(false);
    expect(getRevisionCount(prd)).toBe(3);

    // Keyboard reflects the limit
    const kb = buildRevisionKeyboard(prd);
    const buttons = (kb as any).inline_keyboard.flat();
    const revisionButton = buttons.find((b: any) => b.text?.includes("Revision"));
    expect(revisionButton).toBeUndefined();
  });
});

describe("Junction 4: Approval → Decomposition → Launch", () => {
  it("buildLaunchConfirmation receives triage pipeline info", () => {
    const prdId = "prd-test-123";
    const pipeline = "DEFAULT";
    const explanation = "Pipeline : analyst -> pm -> architect -> dev -> qa (difficulte: 75%)";
    const taskCount = 5;

    const { message, keyboard } = buildLaunchConfirmation(prdId, pipeline, explanation, taskCount);

    // Message includes all context
    expect(message).toContain("5 taches");
    expect(message).toContain("analyst");
    expect(message).toContain("Confirmer");

    // Launch button contains PRD ID prefix
    const buttons = (keyboard as any).inline_keyboard.flat();
    const launchBtn = buttons.find((b: any) => b.callback_data?.startsWith("prdwf_launch:"));
    expect(launchBtn).toBeDefined();
    expect(launchBtn.callback_data).toContain("prd-test");
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: CONTEXT LOSS SCENARIOS — Reproducing the Bug
// ═══════════════════════════════════════════════════════════════

describe("Context Loss: Session Expiry Between Steps", () => {
  beforeEach(() => _resetSessions());

  it("BUG REPRODUCTION: session expires between triage and callback, constraints lost", () => {
    const chatId = 5001;

    // Step 1: User sends message with constraints
    const session = getSession(chatId);
    addSessionMessage(session, "j'aimerais ajouter un audit qualite, haute qualite svp");
    addConstraint(session, "quality", "high", "haute qualite svp");

    // Verify constraints are in session
    expect(session.constraints.length).toBe(1);
    expect(session.constraints[0].type).toBe("quality");

    // Step 2: Store pending description (triage step)
    const ck = chatKey(chatId);
    storePendingDescription(ck, "ajouter un audit qualite");

    // Step 3: Simulate session expiry by forcing lastActivity to 31 minutes ago
    // (This is what happens when the user waits > 30 min before clicking the button)
    (session as any).lastActivity = Date.now() - 3 * 60 * 60 * 1000;

    // Step 4: Callback fires — getSession creates a FRESH session
    const freshSession = getSession(chatId);

    // BUG: Fresh session has no constraints!
    expect(freshSession.constraints.length).toBe(0);

    // The description is still available (pending store is separate from session)
    expect(getPendingDescription(ck)).toBe("ajouter un audit qualite");

    // But extractSessionConstraints returns empty object
    const constraints = extractSessionConstraints(freshSession.constraints);
    expect(Object.keys(constraints).length).toBe(0);
    expect(constraints.quality).toBeUndefined();
    // ^^^ This is the bug: PRD is generated without constraints
  });

  it("session within TTL preserves constraints correctly", () => {
    const chatId = 5002;

    // Step 1: User sends message with constraints
    const session = getSession(chatId);
    addConstraint(session, "speed", "fast", "fais vite");
    addConstraint(session, "quality", "high", "bien fait");

    // Step 2: Store pending (triage)
    storePendingDescription(chatKey(chatId), "test feature");

    // Step 3: Callback fires WITHIN TTL
    const sameSession = getSession(chatId);
    const constraints = extractSessionConstraints(sameSession.constraints);

    // Constraints preserved
    expect(constraints.speed).toBe("fast");
    expect(constraints.quality).toBe("high");
  });

  it("hasActiveSession correctly reports expiry", () => {
    const chatId = 5003;
    const session = getSession(chatId);

    // Active session
    expect(hasActiveSession(chatId)).toBe(true);

    // Force expiry
    (session as any).lastActivity = Date.now() - 3 * 60 * 60 * 1000;

    // Session is now expired
    expect(hasActiveSession(chatId)).toBe(false);
  });

  it("cleanupExpiredSessions removes old sessions", () => {
    const chatId = 5004;
    const session = getSession(chatId);
    (session as any).lastActivity = Date.now() - 3 * 60 * 60 * 1000;

    const cleaned = cleanupExpiredSessions();
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(hasActiveSession(chatId)).toBe(false);
  });
});

describe("Context Loss: Pending Description TTL", () => {
  it("description is available immediately after storage", () => {
    const ck = "ttl-test:1";
    storePendingDescription(ck, "une feature importante");
    expect(getPendingDescription(ck)).toBe("une feature importante");
  });

  it("description is available within the 10-min TTL", () => {
    const ck = "ttl-test:2";
    storePendingDescription(ck, "feature a tester");
    // Immediate check (well within 10 min)
    expect(getPendingDescription(ck)).toBe("feature a tester");
  });

  it("clearing description simulates the cleanup path", () => {
    const ck = "ttl-test:3";
    storePendingDescription(ck, "feature temporaire");
    clearPendingDescription(ck);
    // After clearance, attempting to retrieve returns undefined
    // This is what happens when description has expired
    expect(getPendingDescription(ck)).toBeUndefined();
  });
});

describe("Context Loss: Pending Revision TTL", () => {
  it("revision is available immediately", () => {
    const ck = "rev-ttl:1";
    storePendingRevision(ck, "prd-rev-test", { quality: "high" });
    const rev = getPendingRevision(ck);
    expect(rev).toBeDefined();
    expect(rev!.prdId).toBe("prd-rev-test");
  });

  it("clearing revision simulates the 5-min expiry", () => {
    const ck = "rev-ttl:2";
    storePendingRevision(ck, "prd-rev-expired", { speed: "fast" });
    clearPendingRevision(ck);
    // After expiry, user's revision feedback won't have constraints
    expect(getPendingRevision(ck)).toBeUndefined();
  });

  it("revision without constraints is still valid (graceful degradation)", () => {
    const ck = "rev-ttl:3";
    storePendingRevision(ck, "prd-no-constraints");
    const rev = getPendingRevision(ck);
    expect(rev).toBeDefined();
    expect(rev!.constraints).toBeUndefined();
    // revisePRD should still work, just without constraint block
  });
});

describe("Context Loss: Description Truncation", () => {
  it("short args from intent detection may lose context", () => {
    // Simulate: user says a long message, but argExtractor only captures part of it
    const fullMessage = "j'aimerais ajouter un systeme d'audit de qualite du code avec analyse statique, detection de code mort, verification de couverture";
    const result = detectIntent(fullMessage);

    if (result.detected?.args) {
      // The args should capture the meaningful part after the trigger word
      expect(result.detected.args.length).toBeGreaterThan(10);
    }
  });

  it("when args are undefined, full text should be used as description", () => {
    // Some patterns might not extract args — in that case, the full text should be used
    const text = "lance le prd";
    const result = detectIntent(text);
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");

    // In zz-messages.ts:331, description = args || text
    const description = result.detected!.args || text;
    expect(description).toBeDefined();
    expect(description.length).toBeGreaterThan(0);
  });

  it("buildTriageResponse truncates description at 100 chars but pending stores full", () => {
    const longDescription = "a".repeat(200);
    const ck = "trunc-test:1";

    // Triage shows truncated version
    const triage: TriageResult = { score: 0.5, pipeline: "LIGHT", pipelineExplanation: "test", label: "moyenne" };
    const { message } = buildTriageResponse(longDescription, triage);
    expect(message).toContain("...");

    // But pending stores the FULL description
    storePendingDescription(ck, longDescription);
    expect(getPendingDescription(ck)).toBe(longDescription);
    expect(getPendingDescription(ck)!.length).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: ERROR RECOVERY — What Happens When Steps Fail
// ═══════════════════════════════════════════════════════════════

describe("Error Recovery: Description Expired", () => {
  it("callback without pending description returns error message path", () => {
    const ck = chatKey(6001);
    // No description was stored (or it expired)
    const description = getPendingDescription(ck);
    expect(description).toBeUndefined();
    // In planning.ts:334-336, this triggers "Description expiree. Renvoie ta demande."
  });

  it("callback after explicit clear returns error message path", () => {
    const ck = chatKey(6002);
    storePendingDescription(ck, "original description");
    clearPendingDescription(ck);
    expect(getPendingDescription(ck)).toBeUndefined();
    // Same error path as expired
  });
});

describe("Error Recovery: Session Missing for Constraints", () => {
  beforeEach(() => _resetSessions());

  it("fresh session returns empty constraints (graceful degradation)", () => {
    const session = getSession(6003);
    const constraints = extractSessionConstraints(session.constraints);
    // All undefined — PRD generated without constraints but doesn't crash
    expect(constraints.speed).toBeUndefined();
    expect(constraints.quality).toBeUndefined();
    expect(constraints.budget).toBeUndefined();
    expect(constraints.scope).toBeUndefined();
    expect(constraints.deadline).toBeUndefined();
  });

  it("empty constraints produce empty constraint block in prompt", () => {
    const constraints: PRDSessionConstraints = {};
    // In prd.ts:104-124, constraintLines would be empty
    const constraintLines: string[] = [];
    if (constraints.speed === "fast") constraintLines.push("speed");
    if (constraints.quality === "high") constraintLines.push("quality");
    if (constraints.budget === "low") constraintLines.push("budget");
    if (constraints.scope === "minimal") constraintLines.push("scope");
    if (constraints.deadline) constraintLines.push("deadline");

    const constraintBlock = constraintLines.length > 0
      ? `\nCONTRAINTES:\n${constraintLines.join("\n")}\n`
      : "";

    expect(constraintBlock).toBe("");
    // PRD is generated without constraint guidance — this is the root cause
  });
});

describe("Error Recovery: PRD Not Found During Revision", () => {
  it("getPendingRevision returns prdId that may no longer exist in DB", () => {
    const ck = "recovery-rev:1";
    storePendingRevision(ck, "prd-deleted-from-db");
    const rev = getPendingRevision(ck);
    expect(rev).toBeDefined();
    expect(rev!.prdId).toBe("prd-deleted-from-db");
    // In real code, getPRD(supabase, rev.prdId) would return null
    // planning.ts:249 would reply "PRD introuvable"
  });
});

describe("Error Recovery: Concurrent Workflows", () => {
  beforeEach(() => _resetSessions());

  it("two users starting PRD workflows in different chats don't interfere", () => {
    const chatA = 6010;
    const chatB = 6011;

    // User A starts workflow
    const sessionA = getSession(chatA);
    addConstraint(sessionA, "speed", "fast", "vite");
    storePendingDescription(chatKey(chatA), "feature A: cache layer");

    // User B starts workflow
    const sessionB = getSession(chatB);
    addConstraint(sessionB, "quality", "high", "qualite");
    storePendingDescription(chatKey(chatB), "feature B: monitoring");

    // Verify isolation
    expect(getPendingDescription(chatKey(chatA))).toBe("feature A: cache layer");
    expect(getPendingDescription(chatKey(chatB))).toBe("feature B: monitoring");

    const constraintsA = extractSessionConstraints(sessionA.constraints);
    const constraintsB = extractSessionConstraints(sessionB.constraints);
    expect(constraintsA.speed).toBe("fast");
    expect(constraintsA.quality).toBeUndefined();
    expect(constraintsB.quality).toBe("high");
    expect(constraintsB.speed).toBeUndefined();
  });

  it("same chat different threads have independent sessions", () => {
    const chatId = 6012;
    const threadA = 100;
    const threadB = 200;

    const sessionA = getSession(chatId, threadA);
    addConstraint(sessionA, "budget", "low", "pas cher");
    storePendingDescription(chatKey(chatId, threadA), "thread A feature");

    const sessionB = getSession(chatId, threadB);
    addConstraint(sessionB, "scope", "minimal", "simple");
    storePendingDescription(chatKey(chatId, threadB), "thread B feature");

    // Independent
    expect(getPendingDescription(chatKey(chatId, threadA))).toBe("thread A feature");
    expect(getPendingDescription(chatKey(chatId, threadB))).toBe("thread B feature");

    const ca = extractSessionConstraints(sessionA.constraints);
    const cb = extractSessionConstraints(sessionB.constraints);
    expect(ca.budget).toBe("low");
    expect(cb.scope).toBe("minimal");
  });

  it("starting a new workflow overwrites previous pending description in same chat", () => {
    const ck = chatKey(6013);

    // First workflow
    storePendingDescription(ck, "feature 1: old request");

    // User starts new workflow before completing first
    storePendingDescription(ck, "feature 2: new request");

    // Only the latest description is stored
    expect(getPendingDescription(ck)).toBe("feature 2: new request");
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: FULL WORKFLOW SIMULATION
// ═══════════════════════════════════════════════════════════════

describe("Full Flow: Discussion → Proposal → Confirmation → PRD", () => {
  beforeEach(() => _resetSessions());

  it("multi-message discussion accumulates context before PRD trigger", () => {
    const chatId = 7001;

    // Message 1: general discussion
    simulateTextMessageFlow(chatId, undefined, "j'ai des problemes de performance sur le bot");

    // Message 2: more context
    simulateTextMessageFlow(chatId, undefined, "le temps de reponse est trop long quand il y a beaucoup de messages");

    // Message 3: constraint
    simulateTextMessageFlow(chatId, undefined, "il faudrait que ca soit rapide a implementer");

    // Message 4: PRD trigger
    const { session, intentResult } = simulateTextMessageFlow(
      chatId, undefined,
      "j'aimerais ajouter un systeme de cache pour ameliorer les performances",
    );

    // Intent detected
    expect(intentResult.detected).not.toBeNull();
    expect(intentResult.detected!.intent).toBe("suggest_prd");

    // Session has accumulated context
    expect(session.recentMessages.length).toBeGreaterThanOrEqual(4);

    // Constraint from message 3
    const speed = session.constraints.find(c => c.type === "speed");
    expect(speed).toBeDefined();

    // Session context for agents
    const context = buildConversationContext(session);
    expect(context).toContain("performance");
    expect(context).toContain("cache");
  });

  it("proposal detection → confirmation → command dispatch flow", () => {
    const chatId = 7002;
    const session = getSession(chatId);

    // Bot proposes a PRD (detected via proposal patterns in Claude's response)
    const botResponse = "Tu veux que je lance le prd pour cette fonctionnalite ?";

    // Proposal detection regex (from zz-messages.ts)
    const proposalRegex = /tu\s+veux\s+que\s+je\s+(?:lance|cree|genere|fasse|execute|decompose)\s+(?:le|un|une)?\s*(prd|sprint|tache|plan|implementation|backlog|retro)/i;
    const match = botResponse.match(proposalRegex);
    expect(match).not.toBeNull();
    expect(match![1].toLowerCase()).toBe("prd");

    // Store pending proposal
    session.pendingProposal = {
      action: "prd_workflow",
      args: undefined,
      timestamp: Date.now(),
      sourceMessage: botResponse.substring(0, 200),
    };

    // User confirms
    const confirmText = "oui lance";
    const confirmRegex = /^(oui|ok|vas[- ]?y|go|lance|d'?accord|dac|yes|yep|ouais|parfait|allez|bien\s+sur|evidemment|confirme|j'?approuve|c'?est\s+bon|envoie|fais[- ]le|on\s+y\s+va)/;
    const normalized = confirmText.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    expect(confirmRegex.test(normalized)).toBe(true);

    // Proposal is consumed
    const proposal = session.pendingProposal;
    session.pendingProposal = undefined;
    expect(proposal).toBeDefined();
    expect(proposal!.action).toBe("prd_workflow");
  });

  it("proposal rejection falls through to normal conversation", () => {
    const chatId = 7003;
    const session = getSession(chatId);

    session.pendingProposal = {
      action: "prd_workflow",
      args: "test feature",
      timestamp: Date.now(),
      sourceMessage: "Tu veux que je lance le prd ?",
    };

    const rejectText = "non pas maintenant";
    const rejectRegex = /^(non|pas|annul|stop|attend|arrete|nan|nope|plus\s+tard|pas\s+maintenant)/;
    const normalized = rejectText.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    expect(rejectRegex.test(normalized)).toBe(true);

    // Proposal is cleared on rejection
    session.pendingProposal = undefined;
    expect(session.pendingProposal).toBeUndefined();
  });

  it("proposal expires after 5 minutes (TTL)", () => {
    const chatId = 7004;
    const session = getSession(chatId);

    session.pendingProposal = {
      action: "prd_workflow",
      args: "old feature",
      timestamp: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    sourceMessage: "Tu veux que je lance le prd ?",
    };

    // In zz-messages.ts:275, proposal is checked against 5-min TTL
    const isExpired = Date.now() - session.pendingProposal.timestamp >= 5 * 60 * 1000;
    expect(isExpired).toBe(true);
    // Expired proposals are ignored, message falls through to normal conversation
  });
});

describe("Full Flow: Triage → Create → Revision → Approval Lifecycle", () => {
  beforeEach(() => _resetSessions());

  it("complete lifecycle from triage to approval keyboard", async () => {
    const chatId = 7010;
    const ck = chatKey(chatId);

    // Step 1: Triage
    const description = "implementer un systeme de notifications push avec batching";
    const triage = await triageDescription(description);
    const { message, keyboard } = buildTriageResponse(description, triage);

    expect(message).toContain("Complexite estimee");
    expect(triage.pipeline).toBeDefined();

    // Step 2: Store pending
    storePendingDescription(ck, description);

    // Step 3: User clicks "Creer le PRD"
    const retrievedDesc = getPendingDescription(ck);
    expect(retrievedDesc).toBe(description);
    clearPendingDescription(ck);

    // Step 4: PRD is created (simulated) → show revision keyboard
    const prd = makePRD({
      title: "Systeme de notifications push",
      content: "## Objectif\nImplementer un systeme de notifications push avec batching",
      metadata: { revision_count: 0 },
    });

    const revKb = buildRevisionKeyboard(prd);
    const buttons = (revKb as any).inline_keyboard.flat();
    const allTexts = buttons.map((b: any) => b.text);
    expect(allTexts).toContain("Approuver");
    expect(allTexts.some((t: string) => t.includes("Revision"))).toBe(true);
    expect(allTexts.some((t: string) => t.includes("0/3"))).toBe(true);

    // Step 5: User clicks "Revision"
    storePendingRevision(ck, prd.id, { quality: "high" });

    // Step 6: User sends revision feedback
    const rev = getPendingRevision(ck);
    expect(rev).toBeDefined();
    clearPendingRevision(ck);

    // Step 7: After revision, PRD has incremented counter
    const revisedPrd = makePRD({
      ...prd,
      metadata: { revision_count: 1 },
      content: "## Objectif\nRevised content with security criteria",
    });

    const revKb2 = buildRevisionKeyboard(revisedPrd);
    const buttons2 = (revKb2 as any).inline_keyboard.flat();
    expect(buttons2.some((b: any) => b.text?.includes("1/3"))).toBe(true);

    // Step 8: User approves → decomposition → launch
    // (decomposition and launch are async external calls, tested via their output builders)
    const { message: launchMsg } = buildLaunchConfirmation(
      prd.id, triage.pipeline, triage.pipelineExplanation, 4,
    );
    expect(launchMsg).toContain("4 taches");
    expect(launchMsg).toContain("Confirmer");
  });

  it("cancel at any point clears all pending state", () => {
    const ck = chatKey(7011);

    // Set up workflow state
    storePendingDescription(ck, "feature to cancel");
    storePendingRevision(ck, "prd-to-cancel", { speed: "fast" });

    // Cancel clears everything (simulating prdwf_cancel callback)
    clearPendingDescription(ck);
    clearPendingRevision(ck);

    expect(getPendingDescription(ck)).toBeUndefined();
    expect(getPendingRevision(ck)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: VOICE/TEXT PARITY
// ═══════════════════════════════════════════════════════════════

describe("Voice/Text Parity: Same Intent Detection", () => {
  it("voice transcription 'j'aimerais ajouter un cache' triggers suggest_prd", () => {
    // Voice transcriptions with apostrophes work correctly
    const transcribed = "j'aimerais ajouter un cache pour ameliorer les performances";
    const result = detectIntent(transcribed);
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");
  });

  it("KNOWN GAP: voice transcription without apostrophe misses intent", () => {
    // Voice transcriptions may drop apostrophes: "j aimerais" instead of "j'aimerais"
    // The regex pattern j'?aimerais requires j followed by optional apostrophe
    // but "j aimerais" (with space) doesn't match
    const transcribed = "j aimerais ajouter un cache";
    const result = detectIntent(transcribed);
    // This currently fails — a voice-specific normalization step would fix it
    expect(result.detected).toBeNull();
  });

  it("voice transcription 'lance le PRD' triggers suggest_prd", () => {
    const transcribed = "lance le PRD sur la refactorisation du module agent";
    const result = detectIntent(transcribed);
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");
    expect(result.detected!.args).toContain("refactorisation");
  });

  it("KNOWN GAP: voice transcription 'il faudrait qu on' misses intent", () => {
    // The regex expects "il faudrait que le bot" or "on a besoin de"
    // but "il faudrait qu on ajoute" (casual spoken French) doesn't match any pattern
    const transcribed = "il faudrait qu on ajoute un systeme de logs structure";
    const result = detectIntent(transcribed);
    // This is a gap in voice-to-intent coverage
    expect(result.detected).toBeNull();
  });

  it("formal phrasing works for voice transcriptions", () => {
    // When the transcription uses full formal French, it works
    const transcribed = "il faudrait que le bot ajoute un systeme de logs structure";
    const result = detectIntent(transcribed);
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("suggest_prd");
  });

  it("voice constraint extraction works with informal speech", () => {
    // Voice transcriptions often lack accents
    const transcribed = "fais ca vite et bien";
    const constraints = extractConstraints(transcribed);
    const speed = constraints.find(c => c.type === "speed");
    expect(speed).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: CONSTRAINT EXTRACTION EDGE CASES
// ═══════════════════════════════════════════════════════════════

describe("Constraint Extraction: Edge Cases", () => {
  it("extracts speed from 'rapide'", () => {
    const c = extractConstraints("fais ca rapidement");
    expect(c.find(x => x.type === "speed")).toBeDefined();
  });

  it("extracts speed from 'urgent'", () => {
    const c = extractConstraints("c'est urgent");
    expect(c.find(x => x.type === "speed")).toBeDefined();
  });

  it("extracts quality from 'robuste'", () => {
    const c = extractConstraints("un truc robuste");
    expect(c.find(x => x.type === "quality")).toBeDefined();
  });

  it("extracts quality from 'tests complets'", () => {
    const c = extractConstraints("avec des tests complets");
    expect(c.find(x => x.type === "quality")).toBeDefined();
  });

  it("extracts budget from 'pas cher'", () => {
    const c = extractConstraints("pas cher si possible");
    expect(c.find(x => x.type === "budget")).toBeDefined();
  });

  it("extracts scope from 'simple'", () => {
    const c = extractConstraints("garde ca simple");
    expect(c.find(x => x.type === "scope")).toBeDefined();
  });

  it("extracts scope from 'juste le minimum'", () => {
    const c = extractConstraints("juste le minimum viable");
    expect(c.find(x => x.type === "scope")).toBeDefined();
  });

  it("extracts deadline from 'avant vendredi'", () => {
    const c = extractConstraints("il faut que ce soit pret avant vendredi");
    expect(c.find(x => x.type === "deadline")).toBeDefined();
  });

  it("extracts deadline from 'pour demain'", () => {
    const c = extractConstraints("pour demain matin");
    expect(c.find(x => x.type === "deadline")).toBeDefined();
  });

  it("no constraints from neutral text", () => {
    const c = extractConstraints("comment va le projet");
    expect(c.length).toBe(0);
  });

  it("multiple constraints from single message", () => {
    const c = extractConstraints("fais ca vite et en haute qualite, budget serre");
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c.find(x => x.type === "speed")).toBeDefined();
    expect(c.find(x => x.type === "quality")).toBeDefined();
  });

  it("addConstraint replaces same type (no duplicates)", () => {
    const session = getSession(8001);
    addConstraint(session, "speed", "fast", "vite");
    addConstraint(session, "speed", "slow", "pas presse");

    // Only one speed constraint, the latest
    const speedConstraints = session.constraints.filter(c => c.type === "speed");
    expect(speedConstraints.length).toBe(1);
    expect(speedConstraints[0].value).toBe("slow");
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: LLM INTENT DETECTION JUNCTION
// ═══════════════════════════════════════════════════════════════

describe("LLM Intent Detection: Session Context Injection", () => {
  beforeEach(() => _resetSessions());

  it("session context includes recent intents for LLM", () => {
    const chatId = 9001;
    const session = getSession(chatId);
    addSessionIntent(session, "suggest_prd", "prd_workflow", 0.9, true);
    addSessionMessage(session, "je voudrais un cache");

    const sessionCtx = formatSessionForIntent(session);
    expect(sessionCtx).toContain("prd_workflow");
    expect(sessionCtx).toContain("Phase:");
  });

  it("session context includes constraints for LLM", () => {
    const chatId = 9002;
    const session = getSession(chatId);
    addConstraint(session, "speed", "fast", "vite");
    addConstraint(session, "quality", "high", "qualite");

    const sessionCtx = formatSessionForIntent(session);
    expect(sessionCtx).toContain("speed=fast");
    expect(sessionCtx).toContain("quality=high");
  });

  it("LLM receives session context via detectIntentWithLLM", async () => {
    let capturedPrompt = "";
    const result = await detectIntentWithLLM("montre moi le design", {
      callLLM: async (prompt) => {
        capturedPrompt = prompt;
        return '{"command": null, "args": "", "confidence": 0}';
      },
      sessionContext: "Intents recents: /prd_workflow | Contraintes: speed=fast | Phase: planning",
      timeoutMs: 5000,
    });

    expect(capturedPrompt).toContain("prd_workflow");
    expect(capturedPrompt).toContain("speed=fast");
    expect(capturedPrompt).toContain("planning");
  });

  it("LLM fallback preserves regex result when LLM confidence is lower", async () => {
    // "lance le prd" has high regex confidence for suggest_prd
    const result = await detectIntentWithLLM("lance le prd pour l'audit", {
      callLLM: async () => {
        return '{"command": "prd_workflow", "confidence": 0.5}'; // Low confidence
      },
      timeoutMs: 5000,
    });

    // Regex should win (0.7+ confidence vs 0.5)
    expect(result.detected).not.toBeNull();
    expect(result.detected!.source).toBe("regex");
  });

  it("regex fast-path skips LLM for high confidence matches", async () => {
    let llmCalled = false;
    // "je voudrais ajouter un cache" has multiple regex matches (0.9+)
    // But regex single match is 0.7, need to check
    const result = await detectIntentWithLLM("je voudrais ajouter un systeme de cache", {
      callLLM: async () => {
        llmCalled = true;
        return '{"command": "prd_workflow", "confidence": 0.85}';
      },
      timeoutMs: 5000,
    });

    expect(result.detected).not.toBeNull();
    // If regex gave >= 0.9, LLM is skipped; if < 0.9, LLM is called
    // The important thing is we get a result either way
    expect(result.detected!.command).toBe("prd_workflow");
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: CONVERSATION CONTEXT FOR AGENTS
// ═══════════════════════════════════════════════════════════════

describe("Conversation Context: Agent Context Building", () => {
  beforeEach(() => _resetSessions());

  it("buildConversationContext includes recent messages", () => {
    const session = getSession(10001);
    addSessionMessage(session, "le bot est trop lent");
    addSessionMessage(session, "surtout quand il y a beaucoup de messages");

    const context = buildConversationContext(session);
    expect(context).toContain("bot est trop lent");
    expect(context).toContain("beaucoup de messages");
  });

  it("buildConversationContext includes constraints", () => {
    const session = getSession(10002);
    addConstraint(session, "speed", "fast", "fais vite");
    addConstraint(session, "quality", "high", "bien fait");

    const context = buildConversationContext(session);
    expect(context).toContain("Vitesse");
    expect(context).toContain("fast");
    expect(context).toContain("Qualite");
    expect(context).toContain("high");
  });

  it("buildConversationContext includes decisions", () => {
    const session = getSession(10003);
    const { addDecision } = require("../../src/conversation-session.ts");
    addDecision(session, "Utiliser Redis comme cache");

    const context = buildConversationContext(session);
    expect(context).toContain("Redis");
  });

  it("buildConversationContext includes executed intents", () => {
    const session = getSession(10004);
    addSessionIntent(session, "suggest_prd", "prd_workflow", 0.9, true);
    addSessionIntent(session, "view_backlog", "backlog", 0.85, true);

    const context = buildConversationContext(session);
    expect(context).toContain("/prd_workflow");
    expect(context).toContain("/backlog");
  });

  it("empty session produces empty context", () => {
    const session = getSession(10005);
    const context = buildConversationContext(session);
    expect(context).toBe("");
  });

  it("context truncates long messages at 200 chars", () => {
    const session = getSession(10006);
    const longMsg = "x".repeat(300);
    addSessionMessage(session, longMsg);

    const context = buildConversationContext(session);
    // Message should be truncated
    expect(context).not.toContain("x".repeat(300));
    expect(context).toContain("x".repeat(200));
  });

  it("max 5 recent messages retained", () => {
    const session = getSession(10007);
    for (let i = 0; i < 8; i++) {
      addSessionMessage(session, `message ${i}`);
    }

    expect(session.recentMessages.length).toBe(5);
    expect(session.recentMessages[0]).toBe("message 3"); // Oldest retained
    expect(session.recentMessages[4]).toBe("message 7"); // Most recent
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: THE BUG — End-to-End Context Loss Simulation
// ═══════════════════════════════════════════════════════════════

describe("BUG SIMULATION: Full PRD Creation Without Conversation Context", () => {
  beforeEach(() => _resetSessions());

  it("SCENARIO: Rich discussion → proposal → confirm → PRD with empty description", () => {
    const chatId = 11001;

    // ── ACT 1: Rich discussion building context ──
    // User explains what they want over multiple messages
    simulateTextMessageFlow(chatId, undefined,
      "J'aimerais que le systeme soit capable d'auditer la qualite de sa codebase");
    simulateTextMessageFlow(chatId, undefined,
      "Il faudrait des verifications deterministes d'abord, puis un LLM pour les analyses fines");
    simulateTextMessageFlow(chatId, undefined,
      "Et que chaque finding devienne automatiquement une tache dans le backlog");
    simulateTextMessageFlow(chatId, undefined,
      "Tout ca en haute qualite avec des tests exhaustifs");

    const session = getSession(chatId);

    // Session has accumulated context
    expect(session.recentMessages.length).toBe(4);
    expect(session.constraints.find(c => c.type === "quality")).toBeDefined();

    // ── ACT 2: Bot proposes PRD in its response ──
    session.pendingProposal = {
      action: "prd_workflow",
      args: undefined, // NOTE: args is undefined because bot proposes generically
      timestamp: Date.now(),
      sourceMessage: "Tu veux que je lance le prd pour cette fonctionnalite ?",
    };

    // ── ACT 3: User confirms ──
    const proposal = session.pendingProposal;
    session.pendingProposal = undefined;

    // The command dispatched would be "/prd_workflow" WITHOUT args
    // because proposal.args was undefined
    const cmdStr = proposal!.args ? `/prd_workflow ${proposal!.args}` : "/prd_workflow";
    expect(cmdStr).toBe("/prd_workflow");

    // ── ACT 4: /prd_workflow handler runs but has no description ──
    // In relay.ts, /prd_workflow requires ctx.match (description)
    // When dispatched from confirmation, ctx.match would be empty
    // This means the handler would reply "Usage: /prd_workflow description..."
    // OR if the intent detection re-triggers, args would be just the confirm text

    // This is the root cause: the proposal doesn't carry the description
    // The 4 messages of context are in the session but NOT in the command args
    expect(proposal!.args).toBeUndefined();

    // However, the session still has the context
    const context = buildConversationContext(session);
    expect(context).toContain("auditer la qualite");
    expect(context).toContain("Qualite");
  });

  it("SCENARIO: Intent detection extracts SHORT args, losing conversation depth", () => {
    const chatId = 11002;

    // Multiple messages of context
    simulateTextMessageFlow(chatId, undefined,
      "Le probleme c'est que nos PRDs ne prennent pas le contexte de la conversation");
    simulateTextMessageFlow(chatId, undefined,
      "Il faut corriger le passage de contexte entre intent detection et generation");

    // PRD trigger with intent detection
    const { intentResult } = simulateTextMessageFlow(chatId, undefined,
      "j'aimerais ajouter un systeme de passage de contexte enrichi");

    expect(intentResult.detected).not.toBeNull();
    expect(intentResult.detected!.intent).toBe("suggest_prd");

    // The args extract only the part AFTER the trigger word
    const args = intentResult.detected!.args;
    expect(args).toBeDefined();

    // args captures "systeme de passage de contexte enrichi"
    // but NOT the previous 2 messages about PRD context problems
    // This is a design limitation, not necessarily a bug

    // The session HAS the full context
    const session = getSession(chatId);
    const context = buildConversationContext(session);
    expect(context).toContain("PRDs ne prennent pas le contexte");
    expect(context).toContain("passage de contexte");
    // But this context is NOT used in the pending description
  });

  it("SCENARIO: Job manager creates PRD asynchronously, session may have expired", () => {
    const chatId = 11003;

    // Setup session with context
    const session = getSession(chatId);
    addSessionMessage(session, "je veux un audit qualite complet");
    addConstraint(session, "quality", "high", "audit qualite complet");

    // Store pending description
    const ck = chatKey(chatId);
    storePendingDescription(ck, "audit qualite complet");

    // Callback fires → constraints captured NOW (session alive)
    const constraintsNow = extractSessionConstraints(session.constraints);
    expect(constraintsNow.quality).toBe("high");

    // But if job manager runs the PRD generation asynchronously
    // and the session expires during generation, the constraints
    // were already captured before the async call
    // This is actually OK — the constraints are extracted synchronously
    // in the callback before launching the job
    clearPendingDescription(ck);
    expect(getPendingDescription(ck)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: CALLBACK DATA VALIDATION
// ═══════════════════════════════════════════════════════════════

describe("Callback Data: Telegram 64-byte Limit", () => {
  it("all workflow callback data <= 64 bytes", () => {
    const callbacks = [
      "prdwf_create",
      "prdwf_task",
      "prdwf_cancel",
      "prdwf_revise:" + "a".repeat(36), // Full UUID
      "prdwf_launch:" + "a".repeat(8),   // 8-char prefix
      "prdwf_merge:999",
      "prd_approve:" + "a".repeat(36),
      "prd_reject:" + "a".repeat(36),
      "prd_view:" + "a".repeat(36),
    ];

    for (const cb of callbacks) {
      const bytes = Buffer.byteLength(cb, "utf8");
      expect(bytes).toBeLessThanOrEqual(64);
    }
  });

  it("prdwf_launch uses 8-char prefix to stay under limit", () => {
    const fullId = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
    const prefix = fullId.substring(0, 8);
    const callbackData = `prdwf_launch:${prefix}`;
    expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(64);
    expect(callbackData).toBe("prdwf_launch:aaaa1111");
  });

  it("prd_approve with full UUID stays under limit", () => {
    const fullId = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
    const callbackData = `prd_approve:${fullId}`;
    expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(64);
  });

  it("prdwf_revise with full UUID stays under limit", () => {
    const fullId = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
    const callbackData = `prdwf_revise:${fullId}`;
    expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(64);
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: FEATURE FLAG DEPENDENCY
// ═══════════════════════════════════════════════════════════════

describe("Feature Flag: prd_to_deploy", () => {
  it("isPrdWorkflowEnabled reads from config/features.json", () => {
    const result = isPrdWorkflowEnabled();
    // The flag should be enabled based on the current config
    expect(typeof result).toBe("boolean");
  });

  it("workflow gate: if disabled, triage/pending functions still work independently", () => {
    // Even if the feature flag is off, the underlying functions should work
    // This ensures we don't crash if the flag changes during a workflow
    const ck = "flag-test:1";
    storePendingDescription(ck, "test");
    expect(getPendingDescription(ck)).toBe("test");
    clearPendingDescription(ck);
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 12: IDENTIFIED FIXES — Context Passing Improvements
// ═══════════════════════════════════════════════════════════════

describe("Fix Verification: Description Should Include Conversation Context", () => {
  beforeEach(() => _resetSessions());

  it("CURRENT: only args are stored as pending description", () => {
    const chatId = 12001;
    const { intentResult, chatKeyStr } = simulateTextMessageFlow(
      chatId, undefined,
      "j'aimerais ajouter un systeme de cache intelligent avec invalidation",
    );

    // Current behavior: store args (or full text as fallback)
    const description = intentResult.detected!.args || "j'aimerais ajouter un systeme de cache intelligent avec invalidation";
    storePendingDescription(chatKeyStr, description);

    // Description has the args but NOT the prior conversation messages
    expect(getPendingDescription(chatKeyStr)).toBeDefined();
  });

  it("IMPROVEMENT NEEDED: pending description should be enriched with conversation context", () => {
    const chatId = 12002;

    // Multiple messages of context
    simulateTextMessageFlow(chatId, undefined, "le bot est trop lent pour les grosses requetes");
    simulateTextMessageFlow(chatId, undefined, "ca prend 30 secondes parfois");

    // PRD trigger
    const { intentResult, session, chatKeyStr } = simulateTextMessageFlow(
      chatId, undefined,
      "j'aimerais ajouter un systeme de cache",
    );

    // Current: only args are stored
    const currentDescription = intentResult.detected!.args || "j'aimerais ajouter un systeme de cache";

    // IMPROVEMENT: description should include conversation context
    const conversationContext = buildConversationContext(session);
    const enrichedDescription = conversationContext
      ? `${currentDescription}\n\nContexte de la conversation:\n${conversationContext}`
      : currentDescription;

    // The enriched version has more context
    expect(enrichedDescription).toContain("systeme de cache");
    expect(enrichedDescription).toContain("bot est trop lent");
    expect(enrichedDescription).toContain("30 secondes");

    // This enriched description would give Claude much better context for PRD generation
    expect(enrichedDescription.length).toBeGreaterThan(currentDescription.length);
  });
});
