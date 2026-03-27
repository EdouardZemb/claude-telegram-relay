/**
 * Unit Tests — NLU Feature Request Intent Detection & Routing
 *
 * V-criteria from exploration EXPLORE-routeur-nlu-feature-intent-sdd.md:
 * V1: Regex detects French feature request patterns (il faudrait pouvoir, ce serait bien, etc.)
 * V2: feature_request has priority over create_task when "tache" is absent
 * V3: create_task still works when "tache" is explicitly mentioned
 * V4: feature_request routes to explore command
 * V5: LLM fallback detects feature requests for non-regex formulations
 * V6: Feature flag nlu_feature_request gates the behavior
 * V7: Confirmation InlineKeyboard is shown (never auto-dispatch)
 * V8: Callback handling for confirm/cancel
 * V9: Arg extraction captures the feature subject
 * V10: No false positives on casual conversation
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import {
  handleFeatureRequestCallback,
  isFeatureRequestIntent,
} from "../../src/commands/command-router.ts";
import { _resetForTesting, setFeature } from "../../src/feature-flags.ts";
import { detectIntent, detectIntentWithLLM } from "../../src/intent-detection.ts";

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
});

function setFlag(flag: string, value: boolean): void {
  // Directly update the in-memory cache via setFeature (async but no Supabase = instant cache update)
  // We use void to ignore the promise since without Supabase it's synchronous cache-only
  void setFeature(flag, value);
}

// Minimal Context mock
function _makeCtx(chatId = 1001, threadId?: number): Context {
  return {
    chat: { id: chatId },
    from: { id: 456, first_name: "Test" },
    message: threadId ? { message_thread_id: threadId, text: "test" } : { text: "test" },
    callbackQuery: undefined,
    reply: async () => ({ message_id: 1 }),
    answerCallbackQuery: async () => {},
    editMessageText: async () => {},
  } as unknown as Context;
}

function makeCallbackCtx(data: string, chatId = 2001, threadId?: number): Context {
  return {
    chat: undefined,
    from: { id: 456 },
    message: undefined,
    callbackQuery: {
      data,
      from: { id: 456 },
      message: {
        chat: { id: chatId },
        message_thread_id: threadId,
      },
    },
    reply: async () => ({ message_id: 1 }),
    answerCallbackQuery: async () => {},
    editMessageText: async () => {},
  } as unknown as Context;
}

// ── V1: Regex detects French feature request patterns ──────────

describe("feature_request intent — regex detection (V1)", () => {
  it("detects 'il faudrait pouvoir exporter en CSV'", () => {
    const result = detectIntent("il faudrait pouvoir exporter en CSV");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'ce serait bien d'avoir un dark mode'", () => {
    const result = detectIntent("ce serait bien d'avoir un dark mode");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'on pourrait ajouter des notifications push'", () => {
    const result = detectIntent("on pourrait ajouter des notifications push");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'j'aimerais pouvoir filtrer par date'", () => {
    const result = detectIntent("j'aimerais pouvoir filtrer par date");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'j'aimerais que le bot reponde plus vite'", () => {
    const result = detectIntent("j'aimerais que le bot reponde plus vite");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'pourquoi pas ajouter un mode sombre'", () => {
    const result = detectIntent("pourquoi pas ajouter un mode sombre");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'et si on ajoutait un dashboard'", () => {
    const result = detectIntent("et si on ajoutait un dashboard");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'le bot devrait supporter le multi-langue'", () => {
    const result = detectIntent("le bot devrait supporter le multi-langue");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'il manque un systeme de tags'", () => {
    const result = detectIntent("il manque un systeme de tags");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'ca manque de filtres avances'", () => {
    const result = detectIntent("ca manque de filtres avances");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'nouvelle fonctionnalite de recherche'", () => {
    const result = detectIntent("nouvelle fonctionnalite de recherche");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'on devrait implementer un cache'", () => {
    const result = detectIntent("on devrait implementer un cache");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects 'il faudrait creer un systeme de plugins'", () => {
    const result = detectIntent("il faudrait creer un systeme de plugins");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("detects with accented characters", () => {
    const result = detectIntent("il faudrait pouvoir générer des rapports");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
  });
});

// ── V2: Priority over create_task when "tache" absent ──────────

describe("feature_request priority over create_task (V2)", () => {
  it("'il faudrait ajouter un dark mode' -> feature_request (not task)", () => {
    const result = detectIntent("il faudrait ajouter un dark mode");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("'faudrait creer un systeme de cache' -> feature_request (not task)", () => {
    const result = detectIntent("faudrait creer un systeme de cache");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });

  it("'on doit ajouter des tests' -> feature_request (not task)", () => {
    const result = detectIntent("on doit ajouter des tests");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("feature_request");
    expect(result.detected!.command).toBe("idea");
  });
});

// ── V3: create_task still works with explicit "tache" ──────────

describe("create_task preserved with explicit 'tache' (V3)", () => {
  it("'cree une tache pour refactorer le module' -> task", () => {
    const result = detectIntent("cree une tache pour refactorer le module");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("task");
  });

  it("'ajoute une tache de test' -> task", () => {
    const result = detectIntent("ajoute une tache de test");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("task");
  });

  it("'nouvelle tache: corriger le bug' -> task", () => {
    const result = detectIntent("nouvelle tache: corriger le bug");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("task");
  });
});

// ── V4: feature_request routes to explore ──────────────────────

describe("feature_request routes to explore command (V4)", () => {
  it("command is 'explore'", () => {
    const result = detectIntent("ce serait bien d'avoir un systeme de plugins");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("idea");
  });

  it("suggestion includes /explore", () => {
    const result = detectIntent("il faudrait pouvoir exporter en PDF");
    expect(result.suggestion).not.toBeNull();
    expect(result.suggestion).toContain("/idea");
  });
});

// ── V5: LLM fallback detects feature requests ─────────────────

describe("LLM fallback for feature_request (V5)", () => {
  it("LLM detects feature request for non-regex formulation", async () => {
    const result = await detectIntentWithLLM("le bot devrait pouvoir envoyer des emails de recap", {
      callLLM: async () =>
        '{"command": "idea", "args": "envoyer des emails de recap", "confidence": 0.85}',
    });
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("idea");
  });

  it("LLM prompt includes feature_request instruction", async () => {
    let capturedPrompt = "";
    await detectIntentWithLLM("ce serait top d'avoir des webhooks", {
      callLLM: async (prompt) => {
        capturedPrompt = prompt;
        return '{"command": null, "args": "", "confidence": 0}';
      },
    });
    expect(capturedPrompt).toContain("feature_request");
  });
});

// ── V6: Feature flag gates the behavior ────────────────────────

describe("feature flag nlu_feature_request (V6)", () => {
  it("isFeatureRequestIntent returns true when flag enabled", () => {
    setFlag("nlu_feature_request", true);
    const result = detectIntent("il faudrait pouvoir exporter en CSV");
    expect(isFeatureRequestIntent(result.detected)).toBe(true);
  });

  it("isFeatureRequestIntent returns false when flag disabled", () => {
    setFlag("nlu_feature_request", false);
    const result = detectIntent("il faudrait pouvoir exporter en CSV");
    expect(isFeatureRequestIntent(result.detected)).toBe(false);
  });

  it("isFeatureRequestIntent returns false when detected is null", () => {
    expect(isFeatureRequestIntent(null)).toBe(false);
  });
});

// ── V7: Confirmation InlineKeyboard ────────────────────────────

describe("feature_request confirmation (V7)", () => {
  it("isFeatureRequestIntent identifies feature_request intent", () => {
    setFlag("nlu_feature_request", true);
    const detected = {
      intent: "feature_request",
      command: "idea",
      confidence: 0.7,
      args: "exporter en CSV",
      source: "regex" as const,
    };
    expect(isFeatureRequestIntent(detected)).toBe(true);
  });

  it("isFeatureRequestIntent rejects non-feature_request intents", () => {
    setFlag("nlu_feature_request", true);
    const detected = {
      intent: "create_task",
      command: "task",
      confidence: 0.7,
      source: "regex" as const,
    };
    expect(isFeatureRequestIntent(detected)).toBe(false);
  });
});

// ── V8: Callback handling ──────────────────────────────────────

describe("feature_request callback handling (V8)", () => {
  it("handleFeatureRequestCallback returns explore command on confirm", () => {
    const ctx = makeCallbackCtx("feature_request_confirm", 3001);
    // Simulate a pending feature request for this chat
    const result = handleFeatureRequestCallback(ctx, "feature_request_confirm", "dark mode");
    expect(result).not.toBeNull();
    expect(result).toContain("/idea");
    expect(result).toContain("dark mode");
  });

  it("handleFeatureRequestCallback returns null on cancel", () => {
    const ctx = makeCallbackCtx("feature_request_cancel", 3002);
    const result = handleFeatureRequestCallback(ctx, "feature_request_cancel", undefined);
    expect(result).toBeNull();
  });

  it("handleFeatureRequestCallback returns null for unrelated data", () => {
    const ctx = makeCallbackCtx("sdd_explore", 3003);
    const result = handleFeatureRequestCallback(ctx, "sdd_explore", undefined);
    expect(result).toBeNull();
  });
});

// ── V9: Arg extraction ─────────────────────────────────────────

describe("feature_request arg extraction (V9)", () => {
  it("extracts subject from 'il faudrait pouvoir exporter en CSV'", () => {
    const result = detectIntent("il faudrait pouvoir exporter en CSV");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.args).toBeDefined();
    expect(result.detected!.args).toContain("exporter en CSV");
  });

  it("extracts subject from 'ce serait bien d'avoir un dark mode'", () => {
    const result = detectIntent("ce serait bien d'avoir un dark mode");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.args).toBeDefined();
    expect(result.detected!.args).toContain("dark mode");
  });

  it("extracts subject from 'on pourrait ajouter des notifications push'", () => {
    const result = detectIntent("on pourrait ajouter des notifications push");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.args).toBeDefined();
    expect(result.detected!.args).toContain("notifications push");
  });

  it("extracts subject from 'le bot devrait supporter le multi-langue'", () => {
    const result = detectIntent("le bot devrait supporter le multi-langue");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.args).toBeDefined();
    expect(result.detected!.args).toContain("supporter le multi-langue");
  });

  it("extracts subject from 'il manque un systeme de tags'", () => {
    const result = detectIntent("il manque un systeme de tags");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.args).toBeDefined();
    expect(result.detected!.args).toContain("systeme de tags");
  });
});

// ── V10: No false positives on casual conversation ─────────────

describe("no false positives (V10)", () => {
  it("'bonjour comment vas-tu' -> no match", () => {
    const result = detectIntent("bonjour comment vas-tu");
    // Should be null or non-feature_request
    if (result.detected) {
      expect(result.detected.intent).not.toBe("feature_request");
    }
  });

  it("'merci pour l'info' -> no match", () => {
    const result = detectIntent("merci pour l'info");
    if (result.detected) {
      expect(result.detected.intent).not.toBe("feature_request");
    }
  });

  it("'c'est bien comme ca' -> no match", () => {
    const result = detectIntent("c'est bien comme ca");
    if (result.detected) {
      expect(result.detected.intent).not.toBe("feature_request");
    }
  });

  it("'oui je suis d'accord' -> no match", () => {
    const result = detectIntent("oui je suis d'accord");
    if (result.detected) {
      expect(result.detected.intent).not.toBe("feature_request");
    }
  });

  it("'montre le backlog' -> backlog, not feature_request", () => {
    const result = detectIntent("montre le backlog");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.intent).toBe("view_backlog");
    expect(result.detected!.intent).not.toBe("feature_request");
  });

  it("'il fait beau aujourd'hui' -> no match", () => {
    const result = detectIntent("il fait beau aujourd'hui");
    if (result.detected) {
      expect(result.detected.intent).not.toBe("feature_request");
    }
  });

  it("'ce serait bien' alone (without action) -> no match", () => {
    // Too vague — "ce serait bien" alone without "de/d'" should not trigger
    const result = detectIntent("ce serait bien");
    if (result.detected) {
      expect(result.detected.intent).not.toBe("feature_request");
    }
  });
});
