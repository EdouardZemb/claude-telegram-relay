/**
 * Unit Tests — AR2 Gate (Expert-Persona Feature Request Validator)
 *
 * AR2 = Alternative Radicale 2 : expert-as-persona GO/NO-GO gate before maturation.
 * Part of SPEC: lorsque-l-on-discute-d-une-nouvelle (V3 post-maturation pipeline).
 *
 * V-criteria:
 * V1: runAR2Gate returns GO verdict for valid feature request
 * V2: runAR2Gate returns NO_GO verdict when expert advises against
 * V3: runAR2Gate extracts rationale from LLM response
 * V4: runAR2Gate falls back to GO on malformed LLM response (fail-open)
 * V5: compressContext is a no-op for short text (under threshold)
 * V6: compressContext truncates long text and appends truncation marker
 * V7: persistAR2Result writes JSON file for subject hash (async)
 * V8: loadAR2Result reads back the persisted result (async)
 * V9: loadAR2Result returns null for unknown subject
 * V10: runAR2Gate calls LLM with expert persona prompt containing subject
 * V11: AR2Result includes timestamp
 * V12: compressContext preserves recent content (rolling: keeps tail)
 * V13: runAR2Gate conditions array is populated when present in LLM response
 * V14: runAR2Gate returns cached result within TTL (no LLM call)
 * V15: runAR2Gate calls LLM when cache is expired
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "fs";
import {
  AR2_RESULTS_FILE,
  compressContext,
  loadAR2Result,
  persistAR2Result,
  runAR2Gate,
} from "../../src/ar2-gate.ts";

// ── Test helpers ─────────────────────────────────────────────────

function makeGoLLM(): (prompt: string) => Promise<string> {
  return async () =>
    JSON.stringify({ verdict: "GO", rationale: "Feature bien definie et alignee avec roadmap" });
}

function makeNoGoLLM(): (prompt: string) => Promise<string> {
  return async () =>
    JSON.stringify({
      verdict: "NO_GO",
      rationale: "Scope trop vague, necessite clarification utilisateur",
    });
}

function makeGoWithConditionsLLM(): (prompt: string) => Promise<string> {
  return async () =>
    JSON.stringify({
      verdict: "GO",
      rationale: "Feature pertinente sous conditions",
      conditions: ["Valider avec 3 utilisateurs", "Prototype avant implementation complete"],
    });
}

function makeMalformedLLM(): (prompt: string) => Promise<string> {
  return async () => "Pas de JSON ici, juste du texte libre";
}

function makeCapturingLLM(): { callLLM: (prompt: string) => Promise<string>; captured: string[] } {
  const captured: string[] = [];
  return {
    callLLM: async (prompt: string) => {
      captured.push(prompt);
      return JSON.stringify({ verdict: "GO", rationale: "OK" });
    },
    captured,
  };
}

// ── V1: runAR2Gate returns GO verdict ────────────────────────────

describe("AR2 Gate — GO verdict (V1)", () => {
  it("returns verdict GO for valid feature", async () => {
    const result = await runAR2Gate("exporter en CSV", "", makeGoLLM());
    expect(result.verdict).toBe("GO");
  });

  it("result has non-empty rationale", async () => {
    const result = await runAR2Gate("notifications push", "", makeGoLLM());
    expect(result.rationale.length).toBeGreaterThan(0);
  });
});

// ── V2: runAR2Gate returns NO_GO verdict ─────────────────────────

describe("AR2 Gate — NO_GO verdict (V2)", () => {
  it("returns verdict NO_GO when expert advises against", async () => {
    const result = await runAR2Gate("quelque chose de vague", "", makeNoGoLLM());
    expect(result.verdict).toBe("NO_GO");
  });

  it("NO_GO result has rationale explaining the rejection", async () => {
    const result = await runAR2Gate("feature floue", "", makeNoGoLLM());
    expect(result.rationale).toContain("clarification");
  });
});

// ── V3: runAR2Gate extracts rationale ───────────────────────────

describe("AR2 Gate — rationale extraction (V3)", () => {
  it("extracts rationale from LLM JSON response", async () => {
    const result = await runAR2Gate("dark mode", "", makeGoLLM());
    expect(result.rationale).toBe("Feature bien definie et alignee avec roadmap");
  });
});

// ── V4: runAR2Gate fails open on malformed response ──────────────

describe("AR2 Gate — fail-open on malformed response (V4)", () => {
  it("returns GO when LLM response is not valid JSON", async () => {
    const result = await runAR2Gate("feature test", "", makeMalformedLLM());
    expect(result.verdict).toBe("GO");
  });

  it("fail-open result has a rationale", async () => {
    const result = await runAR2Gate("feature test", "", makeMalformedLLM());
    expect(result.rationale.length).toBeGreaterThan(0);
  });
});

// ── V5: compressContext no-op for short text ─────────────────────

describe("compressContext — no-op for short text (V5)", () => {
  it("returns unchanged text when under threshold", () => {
    const short = "Contexte court";
    expect(compressContext(short)).toBe(short);
  });

  it("returns empty string unchanged", () => {
    expect(compressContext("")).toBe("");
  });
});

// ── V6: compressContext truncates long text ──────────────────────

describe("compressContext — truncates long text (V6)", () => {
  it("truncates text exceeding maxTokens", () => {
    // Approx 4 chars per token
    const longText = "a".repeat(4 * 17001); // > 17000 tokens
    const compressed = compressContext(longText);
    expect(compressed.length).toBeLessThan(longText.length);
  });

  it("appends truncation marker", () => {
    const longText = "b".repeat(4 * 17001);
    const compressed = compressContext(longText);
    expect(compressed).toContain("[...contexte compresse...]");
  });
});

// ── V12: compressContext preserves recent content ────────────────

describe("compressContext — preserves tail (rolling) (V12)", () => {
  it("keeps the last part of the context (most recent)", () => {
    const marker = "MESSAGE_RECENT_IMPORTANT";
    const prefix = "x".repeat(4 * 16000); // lots of old context
    const longText = prefix + marker;
    const compressed = compressContext(longText);
    expect(compressed).toContain(marker);
  });
});

// ── V7: persistAR2Result writes JSON (async) ─────────────────────

describe("persistAR2Result — writes JSON (V7)", () => {
  beforeEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  it("creates the results file", async () => {
    await persistAR2Result("test-feature", {
      verdict: "GO",
      rationale: "Test rationale",
      timestamp: Date.now(),
    });
    expect(existsSync(AR2_RESULTS_FILE)).toBe(true);
  });

  it("writes the result with correct verdict", async () => {
    await persistAR2Result("test-feature", {
      verdict: "NO_GO",
      rationale: "Not aligned",
      timestamp: Date.now(),
    });
    const loaded = await loadAR2Result("test-feature");
    expect(loaded?.verdict).toBe("NO_GO");
  });
});

// ── V8: loadAR2Result reads persisted result (async) ─────────────

describe("loadAR2Result — reads persisted result (V8)", () => {
  beforeEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  it("reads back the verdict", async () => {
    await persistAR2Result("my-feature", {
      verdict: "GO",
      rationale: "All good",
      timestamp: 12345,
    });
    const result = await loadAR2Result("my-feature");
    expect(result?.verdict).toBe("GO");
    expect(result?.rationale).toBe("All good");
    expect(result?.timestamp).toBe(12345);
  });

  it("reads back conditions when present", async () => {
    await persistAR2Result("conditional-feature", {
      verdict: "GO",
      rationale: "With conditions",
      conditions: ["condition A"],
      timestamp: 99999,
    });
    const result = await loadAR2Result("conditional-feature");
    expect(result?.conditions).toEqual(["condition A"]);
  });
});

// ── V9: loadAR2Result returns null for unknown subject ───────────

describe("loadAR2Result — null for unknown subject (V9)", () => {
  beforeEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  it("returns null when file does not exist", async () => {
    expect(await loadAR2Result("unknown")).toBeNull();
  });

  it("returns null for subject not in file", async () => {
    await persistAR2Result("other-feature", {
      verdict: "GO",
      rationale: "other",
      timestamp: 1,
    });
    expect(await loadAR2Result("unknown-subject")).toBeNull();
  });
});

// ── V10: runAR2Gate calls LLM with expert persona prompt ─────────

describe("AR2 Gate — LLM prompt contains subject (V10)", () => {
  it("includes the feature subject in the prompt", async () => {
    const { callLLM, captured } = makeCapturingLLM();
    await runAR2Gate("systeme de notifications avancees", "", callLLM);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toContain("systeme de notifications avancees");
  });

  it("prompt uses expert persona language", async () => {
    const { callLLM, captured } = makeCapturingLLM();
    await runAR2Gate("dark mode", "", callLLM);
    expect(captured[0].toLowerCase()).toMatch(/expert|évaluation|analyse/);
  });
});

// ── V11: AR2Result includes timestamp ────────────────────────────

describe("AR2 Gate — result includes timestamp (V11)", () => {
  it("timestamp is a recent unix ms value", async () => {
    const before = Date.now();
    const result = await runAR2Gate("feature with timestamp", "", makeGoLLM());
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});

// ── V13: conditions array when present ───────────────────────────

describe("AR2 Gate — conditions populated (V13)", () => {
  it("conditions array is populated from LLM response", async () => {
    const result = await runAR2Gate("feature with conditions", "", makeGoWithConditionsLLM());
    expect(result.conditions).toBeDefined();
    expect(result.conditions!.length).toBe(2);
    expect(result.conditions![0]).toContain("utilisateurs");
  });

  it("conditions is undefined when not in LLM response", async () => {
    const result = await runAR2Gate("simple feature", "", makeGoLLM());
    expect(result.conditions).toBeUndefined();
  });
});

// ── V14: cache TTL — returns cached result within TTL ────────────

describe("AR2 Gate — cache TTL (V14)", () => {
  beforeEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  it("returns cached result without calling LLM when within TTL", async () => {
    // Pre-seed a recent cached result
    await persistAR2Result("cached-feature", {
      verdict: "NO_GO",
      rationale: "Cached verdict",
      timestamp: Date.now(), // fresh timestamp
    });

    let llmCalled = false;
    const trackingLLM = async (_prompt: string): Promise<string> => {
      llmCalled = true;
      return JSON.stringify({ verdict: "GO", rationale: "Fresh LLM result" });
    };

    const result = await runAR2Gate("cached-feature", "", trackingLLM);
    expect(llmCalled).toBe(false);
    expect(result.verdict).toBe("NO_GO");
    expect(result.rationale).toBe("Cached verdict");
  });
});

// ── V15: cache TTL — calls LLM when cache is expired ─────────────

describe("AR2 Gate — expired cache (V15)", () => {
  beforeEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(AR2_RESULTS_FILE)) {
      rmSync(AR2_RESULTS_FILE);
    }
  });

  it("calls LLM when cached result is older than TTL", async () => {
    // Pre-seed an expired cached result (6 minutes ago)
    const SIX_MINUTES_MS = 6 * 60 * 1000;
    await persistAR2Result("expired-feature", {
      verdict: "NO_GO",
      rationale: "Stale cached verdict",
      timestamp: Date.now() - SIX_MINUTES_MS,
    });

    let llmCalled = false;
    const trackingLLM = async (_prompt: string): Promise<string> => {
      llmCalled = true;
      return JSON.stringify({ verdict: "GO", rationale: "Fresh LLM result" });
    };

    const result = await runAR2Gate("expired-feature", "", trackingLLM);
    expect(llmCalled).toBe(true);
    expect(result.verdict).toBe("GO");
    expect(result.rationale).toBe("Fresh LLM result");
  });
});
