/**
 * Unit Tests — Browser Delegation Service
 *
 * V-criteria:
 * V1: detectBrowseIntent returns true for URLs (http/https/www)
 * V2: detectBrowseIntent returns true for French browse verbs
 * V3: detectBrowseIntent returns false for conversational messages
 * V4: detectBrowseIntent returns true for English browse keywords
 * V5: browser-delegation exports browseClaude function
 * V6: zz-messages-pipeline no longer imports spawnClaude directly
 * V7: zz-messages-pipeline uses bctx.browseClaude (not direct spawnClaude)
 * V8: VNC_URL hardcoded constant removed from zz-messages-pipeline
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { detectBrowseIntent } from "../../src/commands/zz-messages-pipeline.ts";

const SRC = join(import.meta.dir, "..", "..", "src");

// ── V1: URL detection ─────────────────────────────────────────────

describe("detectBrowseIntent — URL patterns (V1)", () => {
  it("detects https:// URLs", () => {
    expect(detectBrowseIntent("va sur https://sncf-connect.com pour voir les trains")).toBe(true);
  });

  it("detects http:// URLs", () => {
    expect(detectBrowseIntent("ouvre http://leboncoin.fr")).toBe(true);
  });

  it("detects www. prefixed URLs", () => {
    expect(detectBrowseIntent("va sur www.amazon.fr chercher ce produit")).toBe(true);
  });
});

// ── V2: French browse verbs ───────────────────────────────────────

describe("detectBrowseIntent — French browse verbs (V2)", () => {
  it("detects 'va sur'", () => {
    expect(detectBrowseIntent("va sur sncf-connect.com")).toBe(true);
  });

  it("detects 'ouvre '", () => {
    expect(detectBrowseIntent("ouvre leboncoin et cherche des vélos")).toBe(true);
  });

  it("detects 'navigue vers'", () => {
    expect(detectBrowseIntent("navigue vers la page de contact")).toBe(true);
  });
});

// ── V3: Conversational messages — no false positives ─────────────

describe("detectBrowseIntent — conversational messages (V3)", () => {
  it("returns false for generic questions", () => {
    expect(detectBrowseIntent("quel est le temps qu'il fait aujourd'hui ?")).toBe(false);
  });

  it("returns false for coding questions", () => {
    expect(detectBrowseIntent("comment implémenter un semaphore en TypeScript ?")).toBe(false);
  });

  it("returns false for task management", () => {
    expect(detectBrowseIntent("ajoute une tâche pour refactorer le module memory")).toBe(false);
  });
});

// ── V4: English browse keywords ───────────────────────────────────

describe("detectBrowseIntent — English browse keywords (V4)", () => {
  it("detects 'go to '", () => {
    expect(detectBrowseIntent("go to github.com and find the issue")).toBe(true);
  });

  it("detects 'browse '", () => {
    expect(detectBrowseIntent("browse the latest news on techcrunch")).toBe(true);
  });
});

// ── V5: browser-delegation exports browseClaude ──────────────────

describe("browser-delegation module (V5)", () => {
  it("exports browseClaude as a function", async () => {
    const mod = await import("../../src/browser-delegation.ts");
    expect(typeof mod.browseClaude).toBe("function");
  });
});

// ── V6–V8: Structural checks on zz-messages-pipeline ─────────────

describe("zz-messages-pipeline — no direct spawnClaude import (V6-V8)", () => {
  const pipelineSrc = readFileSync(join(SRC, "commands", "zz-messages-pipeline.ts"), "utf-8");

  it("V6: does not import spawnClaude from agent.ts", () => {
    expect(pipelineSrc).not.toMatch(/import.*spawnClaude.*from.*agent/);
  });

  it("V7: uses bctx.browseClaude (not spawnClaude directly)", () => {
    expect(pipelineSrc).toContain("bctx.browseClaude");
  });

  it("V8: VNC_URL hardcoded constant is removed", () => {
    expect(pipelineSrc).not.toContain("192.168.1.129");
    expect(pipelineSrc).not.toContain("VNC_URL =");
  });
});
