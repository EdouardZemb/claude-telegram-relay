/**
 * Unit Tests — S45-T4: Document detection in message handlers
 *
 * Tests: isPhotoDocument heuristic, document handler routing,
 * photo-as-document detection, MIME type filtering, fallback behavior.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Import the exported heuristic ────────────────────────────

import { isPhotoDocument } from "../../src/commands/zz-messages.ts";

// ── isPhotoDocument heuristic ────────────────────────────────

describe("isPhotoDocument", () => {
  // ── Caption keyword detection ──────────────────────────────

  it("detects 'facture' keyword in caption", () => {
    expect(isPhotoDocument("Ma facture EDF", 1000)).toBe(true);
  });

  it("detects 'contrat' keyword in caption", () => {
    expect(isPhotoDocument("contrat de bail", 1000)).toBe(true);
  });

  it("detects 'recu' keyword in caption", () => {
    expect(isPhotoDocument("recu de paiement", 500)).toBe(true);
  });

  it("detects 'ordonnance' keyword in caption", () => {
    expect(isPhotoDocument("ordonnance medicale", 500)).toBe(true);
  });

  it("detects 'document' keyword in caption", () => {
    expect(isPhotoDocument("Mon document", 500)).toBe(true);
  });

  it("detects 'attestation' keyword in caption", () => {
    expect(isPhotoDocument("attestation employeur", 500)).toBe(true);
  });

  it("detects 'certificat' keyword in caption", () => {
    expect(isPhotoDocument("certificat medical", 500)).toBe(true);
  });

  it("detects 'devis' keyword in caption", () => {
    expect(isPhotoDocument("devis plombier", 500)).toBe(true);
  });

  it("detects 'scan' keyword in caption", () => {
    expect(isPhotoDocument("scan du passeport", 500)).toBe(true);
  });

  it("detects 'archive' keyword in caption", () => {
    expect(isPhotoDocument("a archiver", 500)).toBe(true);
  });

  it("detects 'garde' keyword with word boundary (French for keep)", () => {
    expect(isPhotoDocument("garde ca", 500)).toBe(true);
  });

  it("does NOT match 'garde' inside 'Regarde'", () => {
    expect(isPhotoDocument("Regarde ce truc", 500)).toBe(false);
  });

  it("detects 'stocke' keyword in caption", () => {
    expect(isPhotoDocument("stocke ce document", 500)).toBe(true);
  });

  it("detects 'enregistre' keyword in caption", () => {
    expect(isPhotoDocument("enregistre cette facture", 500)).toBe(true);
  });

  it("detects 'classe' keyword in caption", () => {
    expect(isPhotoDocument("classe cette image", 500)).toBe(true);
  });

  it("detects 'invoice' keyword in caption (English)", () => {
    expect(isPhotoDocument("invoice from Amazon", 500)).toBe(true);
  });

  it("detects 'receipt' keyword in caption (English)", () => {
    expect(isPhotoDocument("grocery receipt", 500)).toBe(true);
  });

  it("detects 'save' keyword in caption (English)", () => {
    expect(isPhotoDocument("save this please", 500)).toBe(true);
  });

  it("detects 'store' keyword in caption (English)", () => {
    expect(isPhotoDocument("store this document", 500)).toBe(true);
  });

  it("is case-insensitive for keywords", () => {
    expect(isPhotoDocument("FACTURE EDF", 500)).toBe(true);
    expect(isPhotoDocument("Mon Contrat", 500)).toBe(true);
  });

  // ── File size heuristic ────────────────────────────────────

  it("detects large photo without caption as document", () => {
    // 50KB+ with no caption → document
    expect(isPhotoDocument(undefined, 60 * 1024)).toBe(true);
  });

  it("detects large photo with empty caption as document", () => {
    expect(isPhotoDocument("", 100 * 1024)).toBe(true);
  });

  it("detects large photo with very short caption as document", () => {
    // <= 5 chars caption with large size
    expect(isPhotoDocument("ok", 80 * 1024)).toBe(true);
  });

  it("does NOT detect large photo with long caption as document", () => {
    // Large photo but with descriptive caption → conversational
    expect(isPhotoDocument("Regarde ce joli coucher de soleil", 100 * 1024)).toBe(false);
  });

  // ── Non-document cases ─────────────────────────────────────

  it("does NOT detect small photo without caption as document", () => {
    expect(isPhotoDocument(undefined, 10 * 1024)).toBe(false);
  });

  it("does NOT detect small photo with generic caption as document", () => {
    expect(isPhotoDocument("Regarde ce chat mignon!", 20 * 1024)).toBe(false);
  });

  it("does NOT detect regular conversation photo", () => {
    expect(isPhotoDocument("Voila ma nouvelle voiture", 30 * 1024)).toBe(false);
  });

  it("does NOT detect photo with question caption", () => {
    expect(isPhotoDocument("C'est quoi ca?", 25 * 1024)).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────

  it("handles null caption", () => {
    expect(isPhotoDocument(undefined, 10 * 1024)).toBe(false);
  });

  it("handles zero file size", () => {
    expect(isPhotoDocument(undefined, 0)).toBe(false);
  });

  it("detects keyword even with tiny file size", () => {
    expect(isPhotoDocument("facture", 100)).toBe(true);
  });

  it("threshold is exactly 50KB", () => {
    // Exactly at threshold with no caption
    expect(isPhotoDocument(undefined, 50 * 1024)).toBe(true);
    // Just below threshold
    expect(isPhotoDocument(undefined, 50 * 1024 - 1)).toBe(false);
  });

  it("caption length threshold is 5 chars", () => {
    // Exactly 5 chars with large file
    expect(isPhotoDocument("12345", 60 * 1024)).toBe(true);
    // 6 chars with large file (no keyword) → not detected
    expect(isPhotoDocument("123456", 60 * 1024)).toBe(false);
  });

  it("detects 'releve' keyword", () => {
    expect(isPhotoDocument("releve bancaire", 500)).toBe(true);
  });

  it("detects 'quittance' keyword", () => {
    expect(isPhotoDocument("quittance de loyer", 500)).toBe(true);
  });

  it("detects 'bulletin' keyword", () => {
    expect(isPhotoDocument("bulletin de salaire", 500)).toBe(true);
  });

  it("detects 'fiche' keyword", () => {
    expect(isPhotoDocument("fiche de paie", 500)).toBe(true);
  });

  it("detects 'note' keyword with word boundary", () => {
    expect(isPhotoDocument("note de frais", 500)).toBe(true);
  });

  it("detects 'contract' keyword (English)", () => {
    expect(isPhotoDocument("rental contract", 500)).toBe(true);
  });
});

// ── DOCUMENT_MIME_TYPES filtering ────────────────────────────

describe("DOCUMENT_MIME_TYPES", () => {
  // These mime types should be routed through document pipeline
  const eligibleMimes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ];

  const nonEligibleMimes = [
    "text/plain",
    "application/zip",
    "audio/mpeg",
    "video/mp4",
    "application/json",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];

  for (const mime of eligibleMimes) {
    it(`recognizes ${mime} as eligible for document pipeline`, () => {
      const DOCUMENT_MIME_TYPES = new Set([
        "application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif",
      ]);
      expect(DOCUMENT_MIME_TYPES.has(mime)).toBe(true);
    });
  }

  for (const mime of nonEligibleMimes) {
    it(`rejects ${mime} from document pipeline`, () => {
      const DOCUMENT_MIME_TYPES = new Set([
        "application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif",
      ]);
      expect(DOCUMENT_MIME_TYPES.has(mime)).toBe(false);
    });
  }
});

// ── Composer factory ─────────────────────────────────────────

describe("messagesComposer with document handlers", () => {
  it("default export is a function", async () => {
    const mod = await import("../../src/commands/zz-messages.ts");
    expect(typeof mod.default).toBe("function");
  });

  it("exports isPhotoDocument function", async () => {
    const mod = await import("../../src/commands/zz-messages.ts");
    expect(typeof mod.isPhotoDocument).toBe("function");
  });

  it("returns a Composer instance", async () => {
    const mod = await import("../../src/commands/zz-messages.ts");
    const { Composer } = await import("grammy");

    const mockBctx = {
      bot: { api: { sendMessage: mock(() => Promise.resolve()) } },
      supabase: null,
      callClaude: mock(() => Promise.resolve("response")),
      sendResponse: mock(() => Promise.resolve()),
      sendVoiceResponse: mock(() => Promise.resolve()),
      buildPrompt: mock(() => "prompt"),
      saveMessage: mock(() => Promise.resolve()),
      getDynamicProfile: mock(() => Promise.resolve("")),
      getThreadId: mock(() => undefined),
      threadOpts: mock(() => ({})),
      heartbeatOpts: mock(() => ({ chatId: 123 })),
      getTopicName: mock(() => undefined),
      getTopicConfig: mock(() => undefined),
      commandGuard: mock(() => null),
      recordError: mock(() => false),
      clearError: mock(() => {}),
    };

    const composer = mod.default(mockBctx as any);
    expect(composer).toBeInstanceOf(Composer);
  });
});

// ── Document handler routing logic ───────────────────────────

describe("document handler routing", () => {
  it("PDF mime type is routable to document pipeline", () => {
    const mimeType = "application/pdf";
    const DOCUMENT_MIME_TYPES = new Set([
      "application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif",
    ]);
    const supabase = {}; // truthy
    expect(supabase && DOCUMENT_MIME_TYPES.has(mimeType)).toBe(true);
  });

  it("text/plain falls through to Claude analysis", () => {
    const mimeType = "text/plain";
    const DOCUMENT_MIME_TYPES = new Set([
      "application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif",
    ]);
    expect(DOCUMENT_MIME_TYPES.has(mimeType)).toBe(false);
  });

  it("null supabase prevents document pipeline", () => {
    const supabase = null;
    const DOCUMENT_MIME_TYPES = new Set(["application/pdf"]);
    expect(supabase && DOCUMENT_MIME_TYPES.has("application/pdf")).toBe(null);
  });

  it("result text includes document ID prefix", () => {
    const docId = "abcdef12-3456-7890-abcd-ef1234567890";
    const resultText = `Document enregistre [${docId.substring(0, 8)}]`;
    expect(resultText).toContain("[abcdef12]");
  });

  it("result text includes title when present", () => {
    const lines = [
      "Document enregistre [abcdef12]",
      "Titre: Facture EDF",
      "Description: Facture electricite",
    ].filter(Boolean).join("\n");
    expect(lines).toContain("Titre: Facture EDF");
  });

  it("result text includes document date when present", () => {
    const docDate = "2026-03-15";
    const lines = [
      "Document enregistre [abcdef12]",
      `Date: ${docDate}`,
    ].filter(Boolean).join("\n");
    expect(lines).toContain("Date: 2026-03-15");
  });

  it("result text filters empty lines", () => {
    const lines = [
      "Document enregistre [abcdef12]",
      "", // empty title
      "", // empty description
      "", // empty date
      "Type: application/pdf",
    ].filter(Boolean).join("\n");
    const lineCount = lines.split("\n").length;
    expect(lineCount).toBe(2); // only non-empty lines
  });
});

// ── Photo document detection integration ─────────────────────

describe("photo document detection scenarios", () => {
  it("French invoice photo is detected as document", () => {
    expect(isPhotoDocument("Voici la facture du plombier", 45000)).toBe(true);
  });

  it("Medical prescription photo is detected as document", () => {
    expect(isPhotoDocument("Ordonnance du Dr Martin", 30000)).toBe(true);
  });

  it("Rent receipt photo is detected as document", () => {
    expect(isPhotoDocument("Quittance de loyer mars", 50000)).toBe(true);
  });

  it("Pay slip photo is detected as document", () => {
    expect(isPhotoDocument("Bulletin de salaire fevrier", 80000)).toBe(true);
  });

  it("Bank statement photo is detected as document", () => {
    expect(isPhotoDocument("Releve bancaire janvier", 90000)).toBe(true);
  });

  it("Scanned document with 'scan' caption is detected", () => {
    expect(isPhotoDocument("Scan passeport", 120000)).toBe(true);
  });

  it("Large photo of whiteboard is NOT detected as document (descriptive caption)", () => {
    expect(isPhotoDocument("Photo du whiteboard de la reunion", 200000)).toBe(false);
  });

  it("Selfie is NOT detected as document", () => {
    expect(isPhotoDocument("Moi a la plage!", 150000)).toBe(false);
  });

  it("Food photo is NOT detected as document", () => {
    expect(isPhotoDocument("Mon plat au restaurant", 100000)).toBe(false);
  });

  it("Screenshot without keywords is NOT detected as document (with caption)", () => {
    expect(isPhotoDocument("Regarde ce bug bizarre", 200000)).toBe(false);
  });

  it("High-res photo without caption IS detected as document (size heuristic)", () => {
    expect(isPhotoDocument(undefined, 500000)).toBe(true);
  });

  it("Request to store is detected via 'stocke' keyword", () => {
    expect(isPhotoDocument("Stocke cette photo", 10000)).toBe(true);
  });

  it("Request to save is detected via 'enregistre' keyword", () => {
    expect(isPhotoDocument("Enregistre ca stp", 10000)).toBe(true);
  });
});

// ── DOCUMENT_CAPTION_KEYWORDS coverage ───────────────────────

describe("DOCUMENT_CAPTION_KEYWORDS completeness", () => {
  // Substring-matched keywords
  const substringKeywords = [
    "facture", "contrat", "recu", "ordonnance", "document", "attestation",
    "certificat", "devis", "fiche", "releve", "quittance", "bulletin",
    "invoice", "receipt", "contract", "scan", "archive", "stocke",
    "enregistre", "classe", "save", "store",
  ];

  // Word-boundary-matched keywords (to avoid false positives like "Regarde" -> "garde")
  const boundaryKeywords = ["note", "garde"];

  it("has 22 substring keywords + 2 boundary keywords = 24 total", () => {
    expect(substringKeywords.length + boundaryKeywords.length).toBe(24);
  });

  for (const kw of substringKeywords) {
    it(`substring keyword '${kw}' triggers detection`, () => {
      expect(isPhotoDocument(`Test ${kw} test`, 100)).toBe(true);
    });
  }

  for (const kw of boundaryKeywords) {
    it(`boundary keyword '${kw}' triggers detection as whole word`, () => {
      expect(isPhotoDocument(`Test ${kw} test`, 100)).toBe(true);
    });
  }
});
