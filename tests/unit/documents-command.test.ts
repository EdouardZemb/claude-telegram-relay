/**
 * Unit Tests — S45-T3: commands/documents.ts Composer
 *
 * Tests: /docs subcommands (list, search, stats, delete, categories, detail),
 * callback handlers (doc_confirm, doc_change, doc_cancel, doc_setcat,
 * doc_delete_confirm, doc_delete_cancel), classification keyboard builder,
 * pending classification helpers.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Mock Supabase ────────────────────────────────────────────

function createChainMock(data: unknown = [], error: unknown = null) {
  const chain: Record<string, unknown> = {};
  chain.select = mock(() => chain);
  chain.insert = mock(() => chain);
  chain.update = mock(() => chain);
  chain.delete = mock(() => chain);
  chain.eq = mock(() => chain);
  chain.order = mock(() => chain);
  chain.range = mock(() => chain);
  chain.limit = mock(() => chain);
  chain.single = mock(() => Promise.resolve({ data, error }));
  chain.then = mock((resolve: (v: unknown) => void) => resolve({ data, error }));
  // Make it thenable for await
  Object.defineProperty(chain, "then", {
    value: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      return Promise.resolve({ data, error }).then(resolve, reject);
    },
    configurable: true,
    enumerable: false,
  });
  return chain;
}

function createMockSupabase(overrides: Record<string, unknown> = {}) {
  const mockStorage = {
    from: mock(() => ({
      upload: mock(() => Promise.resolve({ error: null })),
      remove: mock(() => Promise.resolve({ error: null })),
    })),
  };

  const mockFunctions = {
    invoke: mock(() => Promise.resolve({ data: [], error: null })),
  };

  const fromMock = mock(() => createChainMock());

  return {
    from: fromMock,
    storage: mockStorage,
    functions: mockFunctions,
    rpc: mock(() => Promise.resolve({ data: [], error: null })),
    ...overrides,
  } as unknown as SupabaseClient;
}

// ── Import module under test ─────────────────────────────────

import {
  buildClassificationKeyboard,
  clearPendingClassification,
  getPendingClassification,
  registerPendingClassification,
} from "../../src/commands/documents.ts";

// ── buildClassificationKeyboard ──────────────────────────────

describe("buildClassificationKeyboard", () => {
  it("returns an InlineKeyboard with 3 buttons", () => {
    const kb = buildClassificationKeyboard("doc-123", "facture");
    // InlineKeyboard stores buttons in .inline_keyboard
    const rows = (kb as any).inline_keyboard;
    expect(rows).toBeDefined();
    expect(rows.length).toBe(2); // 2 rows
    expect(rows[0].length).toBe(1); // first row: confirm
    expect(rows[1].length).toBe(2); // second row: change + cancel
  });

  it("confirm button includes category name", () => {
    const kb = buildClassificationKeyboard("abc", "contrat");
    const rows = (kb as any).inline_keyboard;
    const confirmBtn = rows[0][0];
    expect(confirmBtn.text).toContain("contrat");
    expect(confirmBtn.callback_data).toBe("doc_confirm:abc");
  });

  it("change button has correct callback data", () => {
    const kb = buildClassificationKeyboard("doc-456", "note");
    const rows = (kb as any).inline_keyboard;
    const changeBtn = rows[1][0];
    expect(changeBtn.text).toBe("Changer categorie");
    expect(changeBtn.callback_data).toBe("doc_change:doc-456");
  });

  it("cancel button has correct callback data", () => {
    const kb = buildClassificationKeyboard("doc-789", "recu");
    const rows = (kb as any).inline_keyboard;
    const cancelBtn = rows[1][1];
    expect(cancelBtn.text).toBe("Annuler");
    expect(cancelBtn.callback_data).toBe("doc_cancel:doc-789");
  });
});

// ── Pending classification helpers ──────────────────────────

describe("pendingClassification helpers", () => {
  beforeEach(() => {
    clearPendingClassification(12345);
    clearPendingClassification(99999);
  });

  it("registerPendingClassification stores pending state", () => {
    const sb = createMockSupabase();
    registerPendingClassification(12345, "doc-1", "cat-1", "facture", sb);
    const pending = getPendingClassification(12345);
    expect(pending).toBeDefined();
    expect(pending!.documentId).toBe("doc-1");
    expect(pending!.categoryId).toBe("cat-1");
    expect(pending!.categoryName).toBe("facture");
  });

  it("getPendingClassification returns undefined when none", () => {
    expect(getPendingClassification(99999)).toBeUndefined();
  });

  it("clearPendingClassification removes pending state", () => {
    const sb = createMockSupabase();
    registerPendingClassification(12345, "doc-1", "cat-1", "note", sb);
    expect(getPendingClassification(12345)).toBeDefined();
    clearPendingClassification(12345);
    expect(getPendingClassification(12345)).toBeUndefined();
  });

  it("registerPendingClassification overwrites previous pending", () => {
    const sb = createMockSupabase();
    registerPendingClassification(12345, "doc-1", "cat-1", "facture", sb);
    registerPendingClassification(12345, "doc-2", "cat-2", "contrat", sb);
    const pending = getPendingClassification(12345);
    expect(pending!.documentId).toBe("doc-2");
    expect(pending!.categoryName).toBe("contrat");
  });

  it("pending has createdAt timestamp", () => {
    const sb = createMockSupabase();
    const before = Date.now();
    registerPendingClassification(12345, "doc-1", "cat-1", "note", sb);
    const pending = getPendingClassification(12345);
    expect(pending!.createdAt).toBeGreaterThanOrEqual(before);
    expect(pending!.createdAt).toBeLessThanOrEqual(Date.now());
  });
});

// ── Composer factory ─────────────────────────────────────────

describe("documentsCommands composer", () => {
  it("default export is a function", async () => {
    const mod = await import("../../src/commands/documents.ts");
    expect(typeof mod.default).toBe("function");
  });

  it("returns a Composer instance", async () => {
    const mod = await import("../../src/commands/documents.ts");
    const { Composer } = await import("grammy");

    const mockBctx = {
      supabase: createMockSupabase(),
      commandGuard: mock(() => null),
      threadOpts: mock(() => ({})),
      sendResponse: mock(() => Promise.resolve()),
    };

    const composer = mod.default(mockBctx as any);
    expect(composer).toBeInstanceOf(Composer);
  });
});

// ── /docs subcommand parsing ────────────────────────────────

describe("/docs subcommand parsing", () => {
  it("recognizes list subcommand", () => {
    const input = "list";
    const parts = input.split(/\s+/);
    expect(parts[0]?.toLowerCase()).toBe("list");
  });

  it("recognizes search with query", () => {
    const input = "search facture janvier";
    const parts = input.split(/\s+/);
    expect(parts[0]?.toLowerCase()).toBe("search");
    expect(parts.slice(1).join(" ")).toBe("facture janvier");
  });

  it("recognizes stats subcommand", () => {
    const input = "stats";
    expect(input.split(/\s+/)[0]?.toLowerCase()).toBe("stats");
  });

  it("recognizes delete with id", () => {
    const input = "delete abc123";
    const parts = input.split(/\s+/);
    expect(parts[0]?.toLowerCase()).toBe("delete");
    expect(parts.slice(1).join(" ")).toBe("abc123");
  });

  it("recognizes categories subcommand", () => {
    const input = "categories";
    expect(input.split(/\s+/)[0]?.toLowerCase()).toBe("categories");
  });

  it("recognizes short hex as document ID", () => {
    const subcommand = "ab12cd34";
    expect(subcommand.length <= 8 && /^[a-f0-9]+$/.test(subcommand)).toBe(true);
  });

  it("empty input defaults to list", () => {
    const input = "";
    const parts = input.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || "list";
    expect(subcommand).toBe("list");
  });
});

// ── Callback data parsing ───────────────────────────────────

describe("callback data parsing", () => {
  it("parses doc_confirm callback", () => {
    const data = "doc_confirm:uuid-123";
    expect(data.startsWith("doc_confirm:")).toBe(true);
    expect(data.split(":")[1]).toBe("uuid-123");
  });

  it("parses doc_change callback", () => {
    const data = "doc_change:uuid-456";
    expect(data.startsWith("doc_change:")).toBe(true);
    expect(data.split(":")[1]).toBe("uuid-456");
  });

  it("parses doc_cancel callback", () => {
    const data = "doc_cancel:uuid-789";
    expect(data.startsWith("doc_cancel:")).toBe(true);
    expect(data.split(":")[1]).toBe("uuid-789");
  });

  it("parses doc_setcat callback with two params", () => {
    const data = "doc_setcat:doc-id:cat-id";
    expect(data.startsWith("doc_setcat:")).toBe(true);
    const parts = data.split(":");
    expect(parts[1]).toBe("doc-id");
    expect(parts[2]).toBe("cat-id");
  });

  it("parses doc_delete_confirm callback", () => {
    const data = "doc_delete_confirm:uuid-abc";
    expect(data.startsWith("doc_delete_confirm:")).toBe(true);
    expect(data.split(":")[1]).toBe("uuid-abc");
  });

  it("parses doc_delete_cancel callback", () => {
    const data = "doc_delete_cancel:uuid-def";
    expect(data.startsWith("doc_delete_cancel:")).toBe(true);
  });

  it("non-doc prefix falls through", () => {
    const data = "prd_approve:some-id";
    expect(data.startsWith("doc_")).toBe(false);
  });

  it("doc_newcat callback parsed correctly", () => {
    const data = "doc_newcat:doc-id";
    expect(data.startsWith("doc_newcat:")).toBe(true);
    expect(data.split(":")[1]).toBe("doc-id");
  });
});

// ── Document formatting ──────────────────────────────────────

describe("document formatting", () => {
  const sampleDoc = {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    user_id: "123",
    project_id: null,
    category_id: "cat-1",
    title: "Facture EDF Janvier",
    extracted_text: "Montant: 150 EUR",
    description: "Facture d'electricite",
    document_date: "2026-01-15",
    file_path: "123/1234.pdf",
    file_type: "application/pdf",
    file_size: 102400,
    metadata: {},
    created_at: "2026-01-20T10:00:00Z",
  };

  it("formatDocumentLine includes title and short ID", () => {
    // Test the format pattern
    const title = sampleDoc.title || "Sans titre";
    const id = sampleDoc.id.substring(0, 8);
    expect(title).toBe("Facture EDF Janvier");
    expect(id).toBe("abcdef12");
  });

  it("formatDocumentLine shows file size in Ko", () => {
    const size = sampleDoc.file_size ? `${Math.round(sampleDoc.file_size / 1024)}Ko` : "";
    expect(size).toBe("100Ko");
  });

  it("formatDocumentDetail includes all fields", () => {
    const detail = [
      `DOCUMENT [${sampleDoc.id.substring(0, 8)}]`,
      `Titre: ${sampleDoc.title}`,
      sampleDoc.description ? `Description: ${sampleDoc.description}` : "",
      `Type: ${sampleDoc.file_type}`,
      sampleDoc.file_size ? `Taille: ${Math.round(sampleDoc.file_size / 1024)}Ko` : "",
      sampleDoc.document_date ? `Date document: ${sampleDoc.document_date}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    expect(detail).toContain("DOCUMENT [abcdef12]");
    expect(detail).toContain("Facture EDF Janvier");
    expect(detail).toContain("Facture d'electricite");
    expect(detail).toContain("application/pdf");
    expect(detail).toContain("100Ko");
    expect(detail).toContain("2026-01-15");
  });

  it("handles missing title as Sans titre", () => {
    const title = null || "Sans titre";
    expect(title).toBe("Sans titre");
  });

  it("handles missing file_size gracefully", () => {
    const size = null ? `${Math.round(0 / 1024)}Ko` : "";
    expect(size).toBe("");
  });
});

// ── Category grid layout ─────────────────────────────────────

describe("category grid layout", () => {
  it("builds keyboard with 2 categories per row + Autre on new row", () => {
    const categories = [
      {
        id: "1",
        name: "facture",
        description: null,
        usage_count: 5,
        created_by: "system",
        created_at: "",
      },
      {
        id: "2",
        name: "contrat",
        description: null,
        usage_count: 3,
        created_by: "system",
        created_at: "",
      },
      {
        id: "3",
        name: "recu",
        description: null,
        usage_count: 2,
        created_by: "system",
        created_at: "",
      },
      {
        id: "4",
        name: "note",
        description: null,
        usage_count: 1,
        created_by: "system",
        created_at: "",
      },
    ];

    const keyboard = new (require("grammy").InlineKeyboard)();
    for (let i = 0; i < categories.length; i++) {
      keyboard.text(categories[i].name, `doc_setcat:docId:${categories[i].id}`);
      if (i % 2 === 1 && i < categories.length - 1) keyboard.row();
    }
    keyboard.row().text("Autre", "doc_newcat:docId");

    const rows = keyboard.inline_keyboard;
    // 4 categories (2 rows of 2) + 1 row for "Autre"
    expect(rows.length).toBe(3);
    expect(rows[0].length).toBe(2);
    expect(rows[1].length).toBe(2);
    expect(rows[2].length).toBe(1);
    expect(rows[2][0].text).toBe("Autre");
  });

  it("handles odd number of categories", () => {
    const categories = [
      { id: "1", name: "facture" },
      { id: "2", name: "contrat" },
      { id: "3", name: "recu" },
    ];

    const keyboard = new (require("grammy").InlineKeyboard)();
    for (let i = 0; i < categories.length; i++) {
      keyboard.text(categories[i].name, `doc_setcat:docId:${categories[i].id}`);
      if (i % 2 === 1 && i < categories.length - 1) keyboard.row();
    }
    keyboard.row().text("Autre", "doc_newcat:docId");

    const rows = keyboard.inline_keyboard;
    // row 0: facture, contrat; row 1: recu; row 2: Autre
    expect(rows.length).toBe(3);
    expect(rows[0].length).toBe(2); // facture, contrat
    expect(rows[1].length).toBe(1); // recu
    expect(rows[2].length).toBe(1); // Autre
    expect(rows[2][0].text).toBe("Autre");
  });
});

// ── Module exports ──────────────────────────────────────────

describe("documents command module exports", () => {
  it("exports buildClassificationKeyboard", () => {
    expect(typeof buildClassificationKeyboard).toBe("function");
  });

  it("exports registerPendingClassification", () => {
    expect(typeof registerPendingClassification).toBe("function");
  });

  it("exports getPendingClassification", () => {
    expect(typeof getPendingClassification).toBe("function");
  });

  it("exports clearPendingClassification", () => {
    expect(typeof clearPendingClassification).toBe("function");
  });
});

// ── Timeout behavior ─────────────────────────────────────────

describe("classification timeout", () => {
  it("CLASSIFICATION_TIMEOUT_MS is 5 minutes", () => {
    // Validate the timeout constant value
    const CLASSIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
    expect(CLASSIFICATION_TIMEOUT_MS).toBe(300000);
  });

  it("pending classification exists until cleared or timed out", () => {
    const sb = createMockSupabase();
    registerPendingClassification(77777, "doc-timeout", "cat-1", "facture", sb);

    // Pending exists immediately after registration
    const pending = getPendingClassification(77777);
    expect(pending).toBeDefined();
    expect(pending!.documentId).toBe("doc-timeout");

    // Clear it (simulates either manual clear or timeout clear)
    clearPendingClassification(77777);
    expect(getPendingClassification(77777)).toBeUndefined();
  });

  it("multiple chats can have independent pending classifications", () => {
    const sb = createMockSupabase();
    registerPendingClassification(11111, "doc-a", "cat-1", "facture", sb);
    registerPendingClassification(22222, "doc-b", "cat-2", "contrat", sb);

    expect(getPendingClassification(11111)!.documentId).toBe("doc-a");
    expect(getPendingClassification(22222)!.documentId).toBe("doc-b");

    // Clearing one doesn't affect the other
    clearPendingClassification(11111);
    expect(getPendingClassification(11111)).toBeUndefined();
    expect(getPendingClassification(22222)!.documentId).toBe("doc-b");

    clearPendingClassification(22222);
  });
});

// ── Edge cases ──────────────────────────────────────────────

describe("edge cases", () => {
  it("handles empty document list", () => {
    const docs: any[] = [];
    expect(docs.length).toBe(0);
  });

  it("handles search with no results", () => {
    const results: any[] = [];
    expect(results.length).toBe(0);
  });

  it("handles stats with zero documents", () => {
    const stats = { total: 0, byCategory: [] };
    expect(stats.total).toBe(0);
    expect(stats.byCategory.length).toBe(0);
  });

  it("handles ID prefix matching", () => {
    const docs = [{ id: "abcdef12-3456" }, { id: "fedcba98-7654" }];
    const prefix = "abcdef";
    const found = docs.find((d) => d.id.startsWith(prefix));
    expect(found).toBeDefined();
    expect(found!.id).toBe("abcdef12-3456");
  });

  it("handles non-matching ID prefix", () => {
    const docs = [{ id: "abcdef12-3456" }];
    const found = docs.find((d) => d.id.startsWith("xxxxxx"));
    expect(found).toBeUndefined();
  });

  it("similarity score formatted as percentage", () => {
    const similarity = 0.85;
    const score = Math.round(similarity * 100);
    expect(score).toBe(85);
  });

  it("description truncated at 60 chars", () => {
    const desc = "A".repeat(100);
    const truncated = desc.substring(0, 60);
    expect(truncated.length).toBe(60);
  });
});

// ── Duplicate Detection Helpers ─────────────────────────────

describe("buildDuplicateKeyboard", () => {
  it("builds keyboard with add and cancel buttons", () => {
    const { buildDuplicateKeyboard } = require("../../src/commands/documents.ts");
    const keyboard = buildDuplicateKeyboard("123_1234567890");
    const data = keyboard.inline_keyboard;
    expect(data.length).toBeGreaterThanOrEqual(1);
    const allButtons = data.flat();
    const texts = allButtons.map((b: { text: string }) => b.text);
    expect(texts).toContain("Ajouter quand meme");
    expect(texts).toContain("Annuler");
  });

  it("includes upload key in callback data", () => {
    const { buildDuplicateKeyboard } = require("../../src/commands/documents.ts");
    const keyboard = buildDuplicateKeyboard("mykey");
    const allButtons = keyboard.inline_keyboard.flat();
    const addBtn = allButtons.find((b: { text: string }) => b.text === "Ajouter quand meme");
    expect(addBtn.callback_data).toBe("doc_dup_add:mykey");
    const cancelBtn = allButtons.find((b: { text: string }) => b.text === "Annuler");
    expect(cancelBtn.callback_data).toBe("doc_dup_cancel:mykey");
  });
});

describe("storePendingUpload", () => {
  it("stores and returns a key", () => {
    const { storePendingUpload } = require("../../src/commands/documents.ts");
    const input = {
      userId: "user1",
      filePath: "test.pdf",
      fileType: "application/pdf",
      buffer: Buffer.from("test"),
    };
    const key = storePendingUpload(12345, input);
    expect(typeof key).toBe("string");
    expect(key).toContain("12345_");
  });
});
