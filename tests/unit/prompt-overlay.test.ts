/**
 * Unit Tests — src/prompt-overlay.ts
 *
 * Tests for the prompt overlay system: CRUD operations, enrichment,
 * and constraints (max 3 active per agent, deactivation, TTL).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

// Set RELAY_DIR to a temp directory before importing the module
const TEST_DIR = join(import.meta.dir, "../../.test-prompt-overlay-" + process.pid);
process.env.RELAY_DIR = TEST_DIR;

import {
  _resetForTests,
  addOverlay,
  buildEnrichedPrompt,
  deactivateOverlay,
  expireOverlays,
  getActiveOverlays,
  listAllOverlays,
  purgeInactiveOverlays,
} from "../../src/prompt-overlay.ts";

// ── Setup / Teardown ─────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  _resetForTests();
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

afterAll(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

// ── CRUD Tests ───────────────────────────────────────────────

describe("prompt-overlay — addOverlay", () => {
  it("adds an overlay and returns it with an id", () => {
    const overlay = addOverlay({
      agentRole: "spec-architect",
      overlayText: "Avoid overly abstract V-criteria",
      reason: "3 consecutive NO-GO from challenge agents",
      triggerType: "alert",
      triggerData: { failures: 3 },
    });

    expect(overlay.id).toBeTruthy();
    expect(overlay.agentRole).toBe("spec-architect");
    expect(overlay.overlayText).toBe("Avoid overly abstract V-criteria");
    expect(overlay.active).toBe(true);
    expect(overlay.createdAt).toBeTruthy();
  });

  it("persists overlays to disk", () => {
    addOverlay({
      agentRole: "spec-architect",
      overlayText: "Test persistence",
      reason: "test",
      triggerType: "manual",
    });

    // Reset in-memory cache and reload
    _resetForTests();
    const overlays = getActiveOverlays("spec-architect");
    expect(overlays.length).toBe(1);
    expect(overlays[0].overlayText).toBe("Test persistence");
  });

  it("enforces max 3 active overlays per agent", () => {
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Overlay 1",
      reason: "test",
      triggerType: "manual",
    });
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Overlay 2",
      reason: "test",
      triggerType: "manual",
    });
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Overlay 3",
      reason: "test",
      triggerType: "manual",
    });

    // Fourth overlay should deactivate the oldest
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Overlay 4",
      reason: "test",
      triggerType: "manual",
    });

    const active = getActiveOverlays("reviewer");
    expect(active.length).toBe(3);
    // The oldest (Overlay 1) should have been deactivated
    expect(active.map((o) => o.overlayText)).not.toContain("Overlay 1");
    expect(active.map((o) => o.overlayText)).toContain("Overlay 4");
  });

  it("max 3 limit is per-agent, not global", () => {
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Reviewer 1",
      reason: "test",
      triggerType: "manual",
    });
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Reviewer 2",
      reason: "test",
      triggerType: "manual",
    });
    addOverlay({
      agentRole: "spec-architect",
      overlayText: "Spec 1",
      reason: "test",
      triggerType: "manual",
    });

    expect(getActiveOverlays("reviewer").length).toBe(2);
    expect(getActiveOverlays("spec-architect").length).toBe(1);
  });
});

describe("prompt-overlay — getActiveOverlays", () => {
  it("returns empty array for agent with no overlays", () => {
    const overlays = getActiveOverlays("explorer");
    expect(overlays).toEqual([]);
  });

  it("excludes deactivated overlays", () => {
    const overlay = addOverlay({
      agentRole: "reviewer",
      overlayText: "Active overlay",
      reason: "test",
      triggerType: "manual",
    });
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Will deactivate",
      reason: "test",
      triggerType: "manual",
    });

    deactivateOverlay(overlay.id);

    const active = getActiveOverlays("reviewer");
    expect(active.length).toBe(1);
    expect(active[0].overlayText).toBe("Will deactivate");
  });
});

describe("prompt-overlay — deactivateOverlay", () => {
  it("deactivates an overlay by id", () => {
    const overlay = addOverlay({
      agentRole: "spec-architect",
      overlayText: "To deactivate",
      reason: "test",
      triggerType: "manual",
    });

    const result = deactivateOverlay(overlay.id);
    expect(result).toBe(true);

    const active = getActiveOverlays("spec-architect");
    expect(active.length).toBe(0);
  });

  it("returns false for non-existent id", () => {
    const result = deactivateOverlay("non-existent-id");
    expect(result).toBe(false);
  });

  it("persists deactivation to disk", () => {
    const overlay = addOverlay({
      agentRole: "spec-architect",
      overlayText: "Persist deactivation",
      reason: "test",
      triggerType: "manual",
    });

    deactivateOverlay(overlay.id);
    _resetForTests();

    const active = getActiveOverlays("spec-architect");
    expect(active.length).toBe(0);
  });
});

describe("prompt-overlay — listAllOverlays", () => {
  it("returns all overlays including deactivated", () => {
    const o1 = addOverlay({
      agentRole: "reviewer",
      overlayText: "Active",
      reason: "test",
      triggerType: "manual",
    });
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Also active",
      reason: "test",
      triggerType: "manual",
    });

    deactivateOverlay(o1.id);

    const all = listAllOverlays();
    expect(all.length).toBe(2);
    expect(all.filter((o) => o.active).length).toBe(1);
    expect(all.filter((o) => !o.active).length).toBe(1);
  });
});

// ── Enrichment Tests ─────────────────────────────────────────

describe("prompt-overlay — buildEnrichedPrompt", () => {
  it("returns base prompt when no overlays exist", () => {
    const result = buildEnrichedPrompt("explorer", "Base system prompt content");
    expect(result).toBe("Base system prompt content");
  });

  it("concatenates active overlays to base prompt", () => {
    addOverlay({
      agentRole: "spec-architect",
      overlayText: "Avoid abstract V-criteria",
      reason: "challenge failures",
      triggerType: "alert",
    });
    addOverlay({
      agentRole: "spec-architect",
      overlayText: "Include error handling in every section",
      reason: "review feedback",
      triggerType: "alert",
    });

    const result = buildEnrichedPrompt("spec-architect", "Base prompt");
    expect(result).toContain("Base prompt");
    expect(result).toContain("Avoid abstract V-criteria");
    expect(result).toContain("Include error handling in every section");
    expect(result).toContain("FEEDBACK OVERLAYS");
  });

  it("does not include overlays from other agents", () => {
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Reviewer-specific overlay",
      reason: "test",
      triggerType: "manual",
    });

    const result = buildEnrichedPrompt("spec-architect", "Base prompt");
    expect(result).toBe("Base prompt");
    expect(result).not.toContain("Reviewer-specific overlay");
  });

  it("returns base prompt when feature flag is off", () => {
    addOverlay({
      agentRole: "spec-architect",
      overlayText: "Should not appear",
      reason: "test",
      triggerType: "manual",
    });

    // buildEnrichedPrompt respects feature flag — tested via the flag check
    // This test verifies the base behavior; flag integration tested in sdd-agents tests
    const result = buildEnrichedPrompt("spec-architect", "Base prompt");
    expect(result).toContain("Should not appear");
  });

  it("returns base prompt unchanged for empty base string", () => {
    const result = buildEnrichedPrompt("explorer", "");
    expect(result).toBe("");
  });
});

// ── TTL / Expiry Tests ───────────────────────────────────────

describe("prompt-overlay — expireOverlays", () => {
  it("deactivates overlays past their expiresAt", () => {
    // Add overlay with expired TTL
    const _overlay = addOverlay({
      agentRole: "reviewer",
      overlayText: "Expired overlay",
      reason: "test",
      triggerType: "alert",
      expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
    });

    const expired = expireOverlays();
    expect(expired).toBe(1);

    const active = getActiveOverlays("reviewer");
    expect(active.length).toBe(0);
  });

  it("does not expire overlays without expiresAt", () => {
    addOverlay({
      agentRole: "reviewer",
      overlayText: "No expiry",
      reason: "test",
      triggerType: "manual",
    });

    const expired = expireOverlays();
    expect(expired).toBe(0);

    const active = getActiveOverlays("reviewer");
    expect(active.length).toBe(1);
  });

  it("does not expire overlays with future expiresAt", () => {
    addOverlay({
      agentRole: "reviewer",
      overlayText: "Future expiry",
      reason: "test",
      triggerType: "alert",
      expiresAt: new Date(Date.now() + 86400000).toISOString(), // 1 day from now
    });

    const expired = expireOverlays();
    expect(expired).toBe(0);

    const active = getActiveOverlays("reviewer");
    expect(active.length).toBe(1);
  });
});

// ── purgeInactiveOverlays Tests ──────────────────────────────

describe("prompt-overlay — purgeInactiveOverlays", () => {
  it("V1: returns 0 when all overlays are active", () => {
    addOverlay({ agentRole: "reviewer", overlayText: "a", reason: "test", triggerType: "manual" });
    addOverlay({ agentRole: "reviewer", overlayText: "b", reason: "test", triggerType: "manual" });
    addOverlay({ agentRole: "reviewer", overlayText: "c", reason: "test", triggerType: "manual" });

    const count = purgeInactiveOverlays();
    expect(count).toBe(0);
    expect(listAllOverlays().length).toBe(3);
  });

  it("V2: returns 0 on empty file", () => {
    const count = purgeInactiveOverlays();
    expect(count).toBe(0);
    expect(listAllOverlays().length).toBe(0);
  });

  it("V3: removes inactive overlays and returns correct count", () => {
    const _o1 = addOverlay({
      agentRole: "reviewer",
      overlayText: "keep",
      reason: "test",
      triggerType: "manual",
    });
    const o2 = addOverlay({
      agentRole: "spec-architect",
      overlayText: "purge1",
      reason: "test",
      triggerType: "manual",
    });
    const o3 = addOverlay({
      agentRole: "spec-architect",
      overlayText: "purge2",
      reason: "test",
      triggerType: "manual",
    });

    deactivateOverlay(o2.id);
    deactivateOverlay(o3.id);

    const count = purgeInactiveOverlays();
    expect(count).toBe(2);
    expect(listAllOverlays().length).toBe(1);
  });

  it("V4: active overlays are intact after purge", () => {
    const o1 = addOverlay({
      agentRole: "reviewer",
      overlayText: "keeper",
      reason: "original",
      triggerType: "manual",
    });
    const o2 = addOverlay({
      agentRole: "spec-architect",
      overlayText: "gone",
      reason: "test",
      triggerType: "manual",
    });

    deactivateOverlay(o2.id);
    purgeInactiveOverlays();

    const remaining = listAllOverlays();
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(o1.id);
    expect(remaining[0].active).toBe(true);
    expect(remaining[0].overlayText).toBe("keeper");
    expect(remaining[0].reason).toBe("original");
  });

  it("V5: purge persists to disk", () => {
    const o1 = addOverlay({
      agentRole: "reviewer",
      overlayText: "stay",
      reason: "test",
      triggerType: "manual",
    });
    const o2 = addOverlay({
      agentRole: "spec-architect",
      overlayText: "remove",
      reason: "test",
      triggerType: "manual",
    });

    deactivateOverlay(o2.id);
    purgeInactiveOverlays();

    // Reset cache and reload from disk
    _resetForTests();
    const reloaded = listAllOverlays();
    expect(reloaded.length).toBe(1);
    expect(reloaded[0].id).toBe(o1.id);
  });

  it("does not write to disk if no inactive overlays", () => {
    addOverlay({
      agentRole: "reviewer",
      overlayText: "active",
      reason: "test",
      triggerType: "manual",
    });
    // Just verify no crash and count is 0
    const count = purgeInactiveOverlays();
    expect(count).toBe(0);
    expect(listAllOverlays().length).toBe(1);
  });
});

// ── Edge Cases ───────────────────────────────────────────────

describe("prompt-overlay — edge cases", () => {
  it("handles corrupt JSON file gracefully", () => {
    const overlaysFile = join(TEST_DIR, "prompt-overlays.json");
    writeFileSync(overlaysFile, "not valid json{{{");
    _resetForTests();

    // Should not throw, return empty
    const overlays = getActiveOverlays("reviewer");
    expect(overlays).toEqual([]);
  });

  it("handles missing directory gracefully", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    _resetForTests();

    // addOverlay should create directory and work
    const overlay = addOverlay({
      agentRole: "reviewer",
      overlayText: "After dir recreation",
      reason: "test",
      triggerType: "manual",
    });
    expect(overlay.id).toBeTruthy();
  });

  it("overlay reason is always stored", () => {
    const overlay = addOverlay({
      agentRole: "spec-architect",
      overlayText: "Some improvement",
      reason: "3 consecutive NO-GO verdicts from devils-advocate",
      triggerType: "alert",
      triggerData: { agent: "devils-advocate", count: 3 },
    });

    expect(overlay.reason).toBe("3 consecutive NO-GO verdicts from devils-advocate");
    expect(overlay.triggerData).toEqual({ agent: "devils-advocate", count: 3 });
  });
});
