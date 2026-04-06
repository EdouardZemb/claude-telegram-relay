/**
 * Tests for browser-delegation module.
 * Pattern matching tested via matchesBrowsePatterns (no feature-flag dependency).
 * Feature-flag integration tested via detectBrowseIntent (flag-off default only).
 * executeBrowseInstruction tested via mock of spawnClaude.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ── Mock spawnClaude before importing browser-delegation ───────
let spawnClaudeMockResult = { stdout: "Browse result", stderr: "", exitCode: 0 };
// biome-ignore lint/suspicious/noExplicitAny: test mock
let spawnClaudeCalls: any[] = [];

mock.module("../../src/agent.ts", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  spawnClaude: async (opts: any) => {
    spawnClaudeCalls.push(opts);
    return spawnClaudeMockResult;
  },
}));

// ── Set required env vars so getConfig() works without mocking config.ts ───
// Save originals for cleanup
const savedEnv: Record<string, string | undefined> = {};
const ENV_DEFAULTS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_USER_ID: "123",
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_ANON_KEY: "test-anon-key",
  NOVNC_URL: "http://localhost:6080/vnc.html",
};

for (const [key, val] of Object.entries(ENV_DEFAULTS)) {
  savedEnv[key] = process.env[key];
  process.env[key] = val;
}

import {
  BROWSE_MAX_INSTRUCTION_LENGTH,
  detectBrowseIntent,
  executeBrowseInstruction,
  matchesBrowsePatterns,
} from "../../src/browser-delegation.ts";
import { _resetConfigForTesting } from "../../src/config.ts";

afterEach(() => {
  // Restore all env vars and reset config after each test
  for (const [key, val] of Object.entries(ENV_DEFAULTS)) {
    process.env[key] = val;
  }
  _resetConfigForTesting();
});

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

  it("BROWSE_MAX_INSTRUCTION_LENGTH is 500", () => {
    expect(BROWSE_MAX_INSTRUCTION_LENGTH).toBe(500);
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

  it("detects 'ouvre' + 'site' combination", () => {
    expect(matchesBrowsePatterns("ouvre le site de la SNCF")).toBe(true);
  });

  it("detects 'ouvre' + 'page' combination", () => {
    expect(matchesBrowsePatterns("ouvre la page d'accueil")).toBe(true);
  });

  it("detects 'ouvre' + 'url' combination", () => {
    expect(matchesBrowsePatterns("ouvre cette url")).toBe(true);
  });

  it("detects 'visite' + 'site' combination", () => {
    expect(matchesBrowsePatterns("visite ce site web")).toBe(true);
  });

  it("detects 'cherche' + 'web' pattern", () => {
    expect(matchesBrowsePatterns("cherche sur le web")).toBe(true);
  });

  it("detects 'recherche' + 'en ligne' pattern", () => {
    expect(matchesBrowsePatterns("recherche en ligne")).toBe(true);
  });

  it("detects 'trouve' + 'internet' pattern", () => {
    expect(matchesBrowsePatterns("trouve sur internet")).toBe(true);
  });

  it("detects known site 'amazon' with action", () => {
    expect(matchesBrowsePatterns("cherche un livre sur amazon")).toBe(true);
  });

  it("detects known site 'google' with action", () => {
    expect(matchesBrowsePatterns("recherche sur google")).toBe(true);
  });

  it("detects known site 'linkedin' with action", () => {
    expect(matchesBrowsePatterns("ouvre linkedin")).toBe(true);
  });

  it("detects known site 'twitter' with action", () => {
    expect(matchesBrowsePatterns("navigue vers twitter")).toBe(true);
  });

  it("detects known site 'facebook' with action", () => {
    expect(matchesBrowsePatterns("visite facebook")).toBe(true);
  });

  it("detects known site 'instagram' with action", () => {
    expect(matchesBrowsePatterns("ouvre instagram")).toBe(true);
  });

  it("detects reversed pattern: site name first then action", () => {
    expect(matchesBrowsePatterns("leboncoin cherche appartement")).toBe(true);
  });

  it("detects reversed pattern: sncf prix", () => {
    expect(matchesBrowsePatterns("sncf prix billet paris lyon")).toBe(true);
  });

  it("detects http:// URL (not just https)", () => {
    expect(matchesBrowsePatterns("ouvre http://example.com")).toBe(true);
  });

  it("returns false for coding question", () => {
    expect(matchesBrowsePatterns("comment tester un module TypeScript ?")).toBe(false);
  });

  it("returns false for task management", () => {
    expect(matchesBrowsePatterns("crée une tâche pour demain")).toBe(false);
  });

  it("is case-insensitive for patterns", () => {
    expect(matchesBrowsePatterns("VA SUR www.google.com")).toBe(true);
    expect(matchesBrowsePatterns("NAVIGUE VERS leboncoin.fr")).toBe(true);
  });
});

// ── detectBrowseIntent — feature flag disabled (default) ─────

describe("detectBrowseIntent — chrome_browse flag OFF (default)", () => {
  it("returns false when flag is not set, even for clear browse intent", () => {
    // chrome_browse defaults to false in config/features.json
    expect(detectBrowseIntent("va sur sncf-connect.com")).toBe(false);
    expect(detectBrowseIntent("https://leboncoin.fr")).toBe(false);
  });

  it("returns false for empty string when flag is off", () => {
    expect(detectBrowseIntent("")).toBe(false);
  });

  it("returns false for www pattern when flag is off", () => {
    expect(detectBrowseIntent("www.google.com")).toBe(false);
  });
});

// ── executeBrowseInstruction ────────────────────────────────────

describe("executeBrowseInstruction", () => {
  beforeEach(() => {
    spawnClaudeCalls = [];
    spawnClaudeMockResult = { stdout: "Browse result", stderr: "", exitCode: 0 };
    process.env.NOVNC_URL = "http://localhost:6080/vnc.html";
    _resetConfigForTesting();
  });

  it("returns response from spawnClaude stdout", async () => {
    spawnClaudeMockResult = { stdout: "Page loaded successfully", stderr: "", exitCode: 0 };
    const result = await executeBrowseInstruction("va sur google.com");
    expect(result.response).toBe("Page loaded successfully");
  });

  it("returns vncUrl from config", async () => {
    process.env.NOVNC_URL = "http://myhost:6080/vnc.html";
    _resetConfigForTesting();
    const result = await executeBrowseInstruction("va sur google.com");
    expect(result.vncUrl).toBe("http://myhost:6080/vnc.html");
  });

  it("returns empty vncUrl when config throws", async () => {
    // Remove required env var to make getConfig() throw
    delete process.env.TELEGRAM_BOT_TOKEN;
    _resetConfigForTesting();
    const result = await executeBrowseInstruction("va sur google.com");
    expect(result.vncUrl).toBe("");
    // Restore for other tests
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    _resetConfigForTesting();
  });

  it("passes chrome: true to spawnClaude", async () => {
    await executeBrowseInstruction("va sur google.com");
    expect(spawnClaudeCalls.length).toBe(1);
    expect(spawnClaudeCalls[0].chrome).toBe(true);
  });

  it("passes effort: high to spawnClaude", async () => {
    await executeBrowseInstruction("va sur google.com");
    expect(spawnClaudeCalls[0].effort).toBe("high");
  });

  it("passes timeout of 180000ms to spawnClaude", async () => {
    await executeBrowseInstruction("va sur google.com");
    expect(spawnClaudeCalls[0].timeout).toBe(180_000);
  });

  it("truncates instruction to BROWSE_MAX_INSTRUCTION_LENGTH", async () => {
    const longInstruction = "A".repeat(1000);
    await executeBrowseInstruction(longInstruction);
    const sentPrompt = spawnClaudeCalls[0].prompt;
    // The instruction part should be truncated to 500 chars, plus the captcha suffix
    expect(sentPrompt.startsWith("A".repeat(500))).toBe(true);
    expect(sentPrompt).not.toContain("A".repeat(501));
  });

  it("includes captcha instruction in prompt", async () => {
    await executeBrowseInstruction("va sur google.com");
    const sentPrompt = spawnClaudeCalls[0].prompt;
    expect(sentPrompt).toContain("captcha");
    expect(sentPrompt).toContain("noVNC");
  });

  it("returns fallback message when stdout is empty", async () => {
    spawnClaudeMockResult = { stdout: "", stderr: "", exitCode: 0 };
    const result = await executeBrowseInstruction("va sur google.com");
    expect(result.response).toBe("Aucun résultat du navigateur.");
  });

  it("returns fallback message when stdout is whitespace only", async () => {
    spawnClaudeMockResult = { stdout: "   \n  ", stderr: "", exitCode: 0 };
    const result = await executeBrowseInstruction("va sur google.com");
    expect(result.response).toBe("Aucun résultat du navigateur.");
  });

  it("trims whitespace from stdout response", async () => {
    spawnClaudeMockResult = { stdout: "  result text  \n", stderr: "", exitCode: 0 };
    const result = await executeBrowseInstruction("va sur google.com");
    expect(result.response).toBe("result text");
  });

  it("still returns response when exitCode is non-zero", async () => {
    spawnClaudeMockResult = { stdout: "partial result", stderr: "error occurred", exitCode: 1 };
    const result = await executeBrowseInstruction("va sur google.com");
    expect(result.response).toBe("partial result");
  });

  it("returns BrowseDelegationResult with correct shape", async () => {
    const result = await executeBrowseInstruction("va sur google.com");
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("vncUrl");
    expect(typeof result.response).toBe("string");
    expect(typeof result.vncUrl).toBe("string");
  });
});
