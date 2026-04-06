/**
 * Tests for browser-delegation module.
 * Pattern matching tested via matchesBrowsePatterns (no feature-flag dependency).
 * Feature-flag integration tested via detectBrowseIntent (flag-off default only).
 */

import { describe, expect, it } from "bun:test";
import {
  BROWSE_MAX_INSTRUCTION_LENGTH,
  detectBrowseIntent,
  executeBrowseInstruction,
  matchesBrowsePatterns,
} from "../../src/browser-delegation.ts";

// ── Module exports shape ─────────────────────────────────────

describe("browser-delegation — exports", () => {
  it("exports detectBrowseIntent as a function", () => {
    expect(typeof detectBrowseIntent).toBe("function");
  });

  it("exports matchesBrowsePatterns as a function", () => {
    expect(typeof matchesBrowsePatterns).toBe("function");
  });

  it("exports executeBrowseInstruction as a function", () => {
    expect(typeof executeBrowseInstruction).toBe("function");
  });

  it("exports BROWSE_MAX_INSTRUCTION_LENGTH as a positive number", () => {
    expect(typeof BROWSE_MAX_INSTRUCTION_LENGTH).toBe("number");
    expect(BROWSE_MAX_INSTRUCTION_LENGTH).toBeGreaterThan(0);
  });
});

// ── matchesBrowsePatterns (pure, no feature-flag state) ──────

describe("matchesBrowsePatterns", () => {
  it("detects 'va sur' pattern", () => {
    expect(matchesBrowsePatterns("va sur sncf-connect.com")).toBe(true);
  });

  it("detects 'navigue vers' pattern", () => {
    expect(matchesBrowsePatterns("navigue vers leboncoin.fr")).toBe(true);
  });

  it("detects https:// URL", () => {
    expect(matchesBrowsePatterns("ouvre https://www.amazon.fr/s?k=vélos")).toBe(true);
  });

  it("detects www. prefix", () => {
    expect(matchesBrowsePatterns("va sur www.lemonde.fr")).toBe(true);
  });

  it("detects action + known site", () => {
    expect(matchesBrowsePatterns("cherche des vélos sur leboncoin")).toBe(true);
  });

  it("returns false for general knowledge question", () => {
    expect(matchesBrowsePatterns("quelle est la capitale de la France ?")).toBe(false);
  });

  it("returns false for recipe question", () => {
    expect(matchesBrowsePatterns("comment faire une béchamel ?")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(matchesBrowsePatterns("")).toBe(false);
  });
});

// ── detectBrowseIntent — feature flag disabled (default) ─────

describe("detectBrowseIntent — chrome_browse flag OFF (default)", () => {
  it("returns false when flag is not set, even for clear browse intent", () => {
    // chrome_browse defaults to false in config/features.json
    expect(detectBrowseIntent("va sur sncf-connect.com")).toBe(false);
    expect(detectBrowseIntent("https://leboncoin.fr")).toBe(false);
  });
});
