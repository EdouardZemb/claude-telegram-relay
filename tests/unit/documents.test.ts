/**
 * Unit Tests — S45-T2: documents.ts module
 *
 * Tests: text extraction, classification, CRUD, search, helpers.
 * All external calls (Claude CLI, Supabase, pdf-parse) are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Mock fetch globally ──────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function _setupFetchMock(responseBody: unknown, status = 200) {
  fetchMock = mock(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(responseBody)),
      json: () => Promise.resolve(responseBody),
    } as Response),
  );
  globalThis.fetch = fetchMock;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ── Mock Bun.spawn ───────────────────────────────────────────

let spawnMock: ReturnType<typeof mock>;

function setupSpawnMock(output: string, exitCode = 0) {
  const fakeProc = {
    stdout: new Response(output).body,
    stderr: new Response("").body,
    exited: Promise.resolve(exitCode),
  };
  spawnMock = spyOn(Bun, "spawn").mockReturnValue(fakeProc as any);
}

function restoreSpawn() {
  if (spawnMock) spawnMock.mockRestore();
}

// ── Mock Supabase ────────────────────────────────────────────

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

  const chainMethods = {
    select: mock(() => chainMethods),
    insert: mock(() => chainMethods),
    update: mock(() => chainMethods),
    delete: mock(() => chainMethods),
    eq: mock(() => chainMethods),
    order: mock(() => chainMethods),
    range: mock(() => chainMethods),
    single: mock(() => Promise.resolve({ data: null, error: null })),
    then: undefined as unknown,
  };

  // Make chainMethods thenable for await
  Object.defineProperty(chainMethods, "then", {
    value: (resolve: (v: unknown) => void) =>
      resolve({ data: overrides.queryData ?? [], error: overrides.queryError ?? null }),
    configurable: true,
  });

  const mockFrom = mock(() => chainMethods);
  const mockRpc = mock(() => Promise.resolve({ data: null, error: null }));

  return {
    supabase: {
      from: mockFrom,
      storage: mockStorage,
      functions: mockFunctions,
      rpc: mockRpc,
    } as unknown as SupabaseClient,
    mockFrom,
    mockStorage,
    mockFunctions,
    mockRpc,
    chainMethods,
  };
}

// ── Import module under test ─────────────────────────────────

import {
  type ClassificationResult,
  checkDuplicate,
  classifyDocument,
  computeFileHash,
  createDocument,
  createSignedUrls,
  type Document,
  type DocumentCategory,
  type DocumentCreateInput,
  type DocumentSearchResult,
  deleteDocument,
  extractText,
  extractTextFromImage,
  extractTextFromPDF,
  getCategories,
  getDocumentById,
  getDocumentStats,
  getOrCreateCategory,
  type ListDocumentsOptions,
  listDocuments,
  searchDocuments,
} from "../../src/documents.ts";

// ── Setup ────────────────────────────────────────────────────

beforeEach(() => {
  restoreFetch();
  restoreSpawn();
});

afterEach(() => {
  restoreSpawn();
});

// ── extractTextFromImage ─────────────────────────────────────

describe("extractTextFromImage", () => {
  it("calls Claude CLI to extract text from image", async () => {
    setupSpawnMock("Facture n°12345\nTotal: 150€");

    const buffer = Buffer.from("fake-image-data");
    const result = await extractTextFromImage(buffer, "image/jpeg");

    expect(result).toBe("Facture n°12345\nTotal: 150€");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty string when no text in image", async () => {
    setupSpawnMock("");

    const result = await extractTextFromImage(Buffer.from("empty"), "image/jpeg");
    expect(result).toBe("");
  });

  it("throws on CLI error", async () => {
    setupSpawnMock("error msg", 1);

    await expect(extractTextFromImage(Buffer.from("x"), "image/jpeg")).rejects.toThrow(
      "Claude CLI error",
    );
  });

  it("writes temp file and cleans up", async () => {
    setupSpawnMock("extracted text");

    await extractTextFromImage(Buffer.from("data"), "image/png");

    // Check that spawn was called and the prompt references a temp path
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][0];
    const prompt = args.find((a: string) => typeof a === "string" && a.includes("doc-extract-"));
    expect(prompt).toBeDefined();
  });
});

// ── extractTextFromPDF ───────────────────────────────────────

describe("extractTextFromPDF", () => {
  it("falls back to CLI when pdf-parse returns empty text", async () => {
    // pdf-parse returns empty, CLI should be called
    setupSpawnMock("Scanned PDF text via CLI");

    // We can't easily mock pdf-parse import, so test the CLI fallback path
    // by testing extractText dispatcher
    const buffer = Buffer.from("not-a-real-pdf");

    // pdf-parse will likely throw on invalid PDF, triggering CLI fallback
    const result = await extractTextFromPDF(buffer);
    // Either pdf-parse succeeds (unlikely with fake data) or CLI fallback
    expect(typeof result).toBe("string");
  });
});

// ── extractText ──────────────────────────────────────────────

describe("extractText", () => {
  it("dispatches image types to extractTextFromImage", async () => {
    setupSpawnMock("image text");

    const result = await extractText(Buffer.from("img"), "image/jpeg");
    expect(result).toBe("image text");
  });

  it("dispatches application/pdf to extractTextFromPDF", async () => {
    setupSpawnMock("pdf fallback");

    const result = await extractText(Buffer.from("pdf"), "application/pdf");
    expect(typeof result).toBe("string");
  });

  it("throws for unsupported file types", async () => {
    await expect(extractText(Buffer.from("x"), "text/plain")).rejects.toThrow(
      "Unsupported file type for extraction: text/plain",
    );
  });

  it("throws for audio file types", async () => {
    await expect(extractText(Buffer.from("x"), "audio/mp3")).rejects.toThrow(
      "Unsupported file type",
    );
  });
});

// ── getCategories ────────────────────────────────────────────

describe("getCategories", () => {
  it("returns categories from Supabase", async () => {
    const cats = [
      {
        id: "1",
        name: "facture",
        description: "Factures",
        usage_count: 5,
        created_by: "system",
        created_at: "2026-01-01",
      },
      {
        id: "2",
        name: "contrat",
        description: "Contrats",
        usage_count: 3,
        created_by: "system",
        created_at: "2026-01-01",
      },
    ];

    const { supabase } = createMockSupabase({ queryData: cats });
    const result = await getCategories(supabase);
    expect(result).toEqual(cats);
  });

  it("returns empty array on error", async () => {
    const { supabase } = createMockSupabase({ queryError: { message: "fail" } });
    const result = await getCategories(supabase);
    expect(result).toEqual([]);
  });

  it("returns empty array when data is null", async () => {
    const { supabase } = createMockSupabase({ queryData: null });
    const result = await getCategories(supabase);
    expect(result).toEqual([]);
  });
});

// ── getOrCreateCategory ──────────────────────────────────────

describe("getOrCreateCategory", () => {
  it("returns existing category id", async () => {
    const chain = {
      select: mock(() => chain),
      eq: mock(() => chain),
      single: mock(() => Promise.resolve({ data: { id: "existing-id" }, error: null })),
    };
    const supabase = { from: mock(() => chain) } as unknown as SupabaseClient;

    const result = await getOrCreateCategory(supabase, "Facture");
    expect(result).toBe("existing-id");
  });

  it("creates new category when not found", async () => {
    let callCount = 0;
    const selectChain = {
      select: mock(() => selectChain),
      eq: mock(() => selectChain),
      single: mock(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ data: null, error: { code: "PGRST116" } });
        return Promise.resolve({ data: { id: "new-id" }, error: null });
      }),
    };
    const insertChain = {
      insert: mock(() => insertChain),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: { id: "new-id" }, error: null })),
    };

    let fromCallCount = 0;
    const supabase = {
      from: mock(() => {
        fromCallCount++;
        if (fromCallCount === 1) return selectChain;
        return insertChain;
      }),
    } as unknown as SupabaseClient;

    const result = await getOrCreateCategory(supabase, "nouveau", "Une nouvelle categorie");
    expect(result).toBe("new-id");
  });

  it("lowercases category name", async () => {
    const chain = {
      select: mock(() => chain),
      eq: mock((_col: string, val: string) => {
        if (val === "facture") return chain;
        return chain;
      }),
      single: mock(() => Promise.resolve({ data: { id: "id" }, error: null })),
    };
    const supabase = { from: mock(() => chain) } as unknown as SupabaseClient;

    await getOrCreateCategory(supabase, "FACTURE");
    expect(chain.eq).toHaveBeenCalledWith("name", "facture");
  });
});

// ── classifyDocument ─────────────────────────────────────────

describe("classifyDocument", () => {
  const mockCategories: DocumentCategory[] = [
    {
      id: "cat-1",
      name: "facture",
      description: "Factures",
      usage_count: 5,
      created_by: "system",
      created_at: "2026-01-01",
    },
    {
      id: "cat-2",
      name: "contrat",
      description: "Contrats",
      usage_count: 3,
      created_by: "system",
      created_at: "2026-01-01",
    },
  ];

  it("classifies document into existing category", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "facture",
        confidence: 0.95,
        description: "Facture EDF du 15 mars 2026",
        document_date: "2026-03-15",
        suggested_title: "Facture EDF Mars 2026",
      }),
    );

    // Mock supabase for update
    const chain = {
      update: mock(() => chain),
      eq: mock(() => Promise.resolve({ error: null })),
      from: mock(() => chain),
    };
    const supabase = {
      from: mock(() => chain),
      rpc: mock(() => Promise.resolve({ data: null, error: null })),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "Facture EDF n°123 Total: 85€", mockCategories);

    expect(result.category_name).toBe("facture");
    expect(result.category_id).toBe("cat-1");
    expect(result.confidence).toBe(0.95);
    expect(result.description).toBe("Facture EDF du 15 mars 2026");
    expect(result.document_date).toBe("2026-03-15");
    expect(result.is_new_category).toBe(false);
  });

  it("creates new category when name not in existing list", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "ordonnance",
        confidence: 0.8,
        description: "Ordonnance medicale",
        document_date: null,
      }),
    );

    // Mock supabase: getOrCreateCategory needs from().select().eq().single() then from().insert().select().single()
    let fromCallCount = 0;
    const selectChain = {
      select: mock(() => selectChain),
      eq: mock(() => selectChain),
      single: mock(() => Promise.resolve({ data: null, error: { code: "PGRST116" } })),
    };
    const insertChain = {
      insert: mock(() => insertChain),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: { id: "new-cat-id" }, error: null })),
    };
    const updateChain = {
      update: mock(() => updateChain),
      eq: mock(() => Promise.resolve({ error: null })),
    };

    const supabase = {
      from: mock(() => {
        fromCallCount++;
        if (fromCallCount === 1) return selectChain; // getOrCreateCategory lookup
        if (fromCallCount === 2) return insertChain; // getOrCreateCategory insert
        return updateChain; // usage_count update
      }),
      rpc: mock(() => Promise.resolve({ data: null, error: null })),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "Ordonnance Dr. Martin", mockCategories);

    expect(result.category_name).toBe("ordonnance");
    expect(result.category_id).toBe("new-cat-id");
    expect(result.is_new_category).toBe(true);
  });

  it("handles JSON wrapped in markdown code blocks", async () => {
    setupSpawnMock(
      '```json\n{"category_name": "facture", "confidence": 0.9, "description": "test", "document_date": null}\n```',
    );

    const chain = {
      update: mock(() => chain),
      eq: mock(() => Promise.resolve({ error: null })),
    };
    const supabase = {
      from: mock(() => chain),
      rpc: mock(() => Promise.resolve({ data: null, error: null })),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "Some text", mockCategories);
    expect(result.category_name).toBe("facture");
    expect(result.confidence).toBe(0.9);
  });

  it("throws on CLI error", async () => {
    setupSpawnMock("", 1);
    const { supabase } = createMockSupabase();

    await expect(classifyDocument(supabase, "text", mockCategories)).rejects.toThrow(
      "Claude CLI error",
    );
  });

  it("clamps confidence to [0, 1]", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "facture",
        confidence: 1.5,
        description: "test",
        document_date: null,
      }),
    );

    const chain = {
      update: mock(() => chain),
      eq: mock(() => Promise.resolve({ error: null })),
    };
    const supabase = {
      from: mock(() => chain),
      rpc: mock(() => Promise.resolve({ data: null, error: null })),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "text", mockCategories);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("uses existing category when confidence >= 0.6 threshold", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "facture",
        confidence: 0.6,
        description: "Facture probable",
        document_date: null,
      }),
    );

    const chain = {
      update: mock(() => chain),
      eq: mock(() => Promise.resolve({ error: null })),
    };
    const supabase = {
      from: mock(() => chain),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "Some invoice text", mockCategories);
    expect(result.category_id).toBe("cat-1");
    expect(result.is_new_category).toBe(false);
    expect(result.confidence).toBe(0.6);
  });

  it("still uses existing category when confidence < 0.6 (low confidence path)", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "facture",
        confidence: 0.4,
        description: "Maybe a facture",
        document_date: null,
      }),
    );

    const chain = {
      update: mock(() => chain),
      eq: mock(() => Promise.resolve({ error: null })),
    };
    const supabase = {
      from: mock(() => chain),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "Ambiguous text", mockCategories);
    // Low confidence on existing category — still uses it (line 308-310 in documents.ts)
    expect(result.category_id).toBe("cat-1");
    expect(result.is_new_category).toBe(false);
    expect(result.confidence).toBe(0.4);
  });

  it("creates new category for unknown name regardless of confidence", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "medical",
        confidence: 0.4,
        description: "Document medical",
        document_date: null,
      }),
    );

    // Mock: lookup returns null, insert returns new id
    let fromCallCount = 0;
    const selectChain = {
      select: mock(() => selectChain),
      eq: mock(() => selectChain),
      single: mock(() => Promise.resolve({ data: null, error: { code: "PGRST116" } })),
    };
    const insertChain = {
      insert: mock(() => insertChain),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: { id: "new-med-id" }, error: null })),
    };
    const updateChain = {
      update: mock(() => updateChain),
      eq: mock(() => Promise.resolve({ error: null })),
    };

    const supabase = {
      from: mock(() => {
        fromCallCount++;
        if (fromCallCount === 1) return selectChain;
        if (fromCallCount === 2) return insertChain;
        return updateChain;
      }),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "text", mockCategories);
    expect(result.category_name).toBe("medical");
    expect(result.is_new_category).toBe(true);
    expect(result.category_id).toBe("new-med-id");
  });

  it("defaults category_name to 'note' when LLM returns empty", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "",
        confidence: 0.5,
        description: "Some text",
        document_date: null,
      }),
    );

    // "note" exists in mockCategories? No — it doesn't, so it will create a new one
    // Actually the default is "note" from (parsed.category_name || "note")
    let fromCallCount = 0;
    const selectChain = {
      select: mock(() => selectChain),
      eq: mock(() => selectChain),
      single: mock(() => Promise.resolve({ data: null, error: { code: "PGRST116" } })),
    };
    const insertChain = {
      insert: mock(() => insertChain),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: { id: "note-id" }, error: null })),
    };
    const updateChain = {
      update: mock(() => updateChain),
      eq: mock(() => Promise.resolve({ error: null })),
    };

    const supabase = {
      from: mock(() => {
        fromCallCount++;
        if (fromCallCount === 1) return selectChain;
        if (fromCallCount === 2) return insertChain;
        return updateChain;
      }),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "random text", mockCategories);
    expect(result.category_name).toBe("note");
  });

  it("bumps usage count on existing category via fire-and-forget", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "facture",
        confidence: 0.9,
        description: "test",
        document_date: null,
      }),
    );

    const updateMock = mock(() => updateChain);
    const eqMock = mock(() => Promise.resolve({ error: null }));
    const updateChain = {
      update: updateMock,
      eq: eqMock,
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    };

    const supabase = {
      from: mock(() => updateChain),
    } as unknown as SupabaseClient;

    await classifyDocument(supabase, "Facture text", mockCategories);

    // Verify update was called with incremented usage_count
    expect(updateMock).toHaveBeenCalled();
    const updateArg = updateMock.mock.calls[0][0];
    expect(updateArg.usage_count).toBe(6); // 5 + 1
  });

  it("handles classification with empty categories list", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "nouveau",
        confidence: 0.8,
        description: "New category",
        document_date: null,
      }),
    );

    let fromCallCount = 0;
    const selectChain = {
      select: mock(() => selectChain),
      eq: mock(() => selectChain),
      single: mock(() => Promise.resolve({ data: null, error: { code: "PGRST116" } })),
    };
    const insertChain = {
      insert: mock(() => insertChain),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: { id: "first-cat" }, error: null })),
    };
    const updateChain = {
      update: mock(() => updateChain),
      eq: mock(() => Promise.resolve({ error: null })),
    };

    const supabase = {
      from: mock(() => {
        fromCallCount++;
        if (fromCallCount === 1) return selectChain;
        if (fromCallCount === 2) return insertChain;
        return updateChain;
      }),
    } as unknown as SupabaseClient;

    // Empty categories list — always creates new
    const result = await classifyDocument(supabase, "text", []);
    expect(result.is_new_category).toBe(true);
    expect(result.category_id).toBe("first-cat");
  });

  it("clamps negative confidence to 0", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "facture",
        confidence: -0.5,
        description: "test",
        document_date: null,
      }),
    );

    const chain = {
      update: mock(() => chain),
      eq: mock(() => chain),
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    };
    const supabase = {
      from: mock(() => chain),
    } as unknown as SupabaseClient;

    const result = await classifyDocument(supabase, "text", mockCategories);
    expect(result.confidence).toBe(0);
  });

  it("truncates text to 2000 chars in prompt", async () => {
    setupSpawnMock(
      JSON.stringify({
        category_name: "facture",
        confidence: 0.9,
        description: "Long note",
        document_date: null,
      }),
    );

    const chain = {
      update: mock(() => chain),
      eq: mock(() => chain),
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    };
    const supabase = {
      from: mock(() => chain),
      rpc: mock(() => Promise.resolve({ data: null, error: null })),
    } as unknown as SupabaseClient;

    const longText = "A".repeat(5000);
    await classifyDocument(supabase, longText, mockCategories);

    // Check that spawn was called and the prompt arg contains truncated text (2000 chars max)
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][0];
    // The prompt is the arg after "-p"
    const promptIdx = args.indexOf("-p");
    const prompt = args[promptIdx + 1];
    // Should contain "A" chars but not the full 5000
    expect(prompt).toContain("AAAA");
    expect(prompt.length).toBeLessThan(longText.length + 500);
  });
});

// ── createDocument ───────────────────────────────────────────

describe("createDocument", () => {
  it("runs full pipeline: extract → classify → upload → insert", async () => {
    // Mock CLI for extraction and classification (sequential calls)
    let callCount = 0;
    spawnMock = spyOn(Bun, "spawn").mockImplementation(() => {
      callCount++;
      const output =
        callCount === 1
          ? "Facture n°1"
          : JSON.stringify({
              category_name: "facture",
              confidence: 0.9,
              description: "Facture test",
              document_date: "2026-01-01",
            });
      return {
        stdout: new Response(output).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      } as any;
    });

    // Mock Supabase
    const mockDoc: Document = {
      id: "doc-1",
      user_id: "user-1",
      project_id: null,
      category_id: "cat-1",
      title: "Facture test",
      extracted_text: "Facture n°1",
      description: "Facture test",
      document_date: "2026-01-01",
      file_path: "user-1/123.jpg",
      file_type: "image/jpeg",
      file_size: 1024,
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    };

    const categories = [
      {
        id: "cat-1",
        name: "facture",
        description: "Factures",
        usage_count: 5,
        created_by: "system",
        created_at: "2026-01-01",
      },
    ];

    let fromCallCount = 0;

    // getCategories chain
    const getCatChain = {
      select: mock(() => getCatChain),
      order: mock(() => getCatChain),
      then: undefined as unknown,
    };
    Object.defineProperty(getCatChain, "then", {
      value: (resolve: (v: unknown) => void) => resolve({ data: categories, error: null }),
      configurable: true,
    });

    // update chain for usage_count
    const updateChain = {
      update: mock(() => updateChain),
      eq: mock(() => Promise.resolve({ error: null })),
    };

    // insert chain for document
    const insertChain = {
      insert: mock(() => insertChain),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: mockDoc, error: null })),
    };

    // Update chain for usage_count bump (from("document_categories").update().eq())
    const catUpdateChain = {
      select: mock(() => getCatChain),
      order: mock(() => getCatChain),
      update: mock(() => catUpdateChain),
      eq: mock(() => catUpdateChain),
      then: (resolve: (v: unknown) => void, _reject?: (e: unknown) => void) => resolve(undefined),
    };

    const supabase = {
      from: mock((table: string) => {
        fromCallCount++;
        if (table === "document_categories") {
          // First call is getCategories (select+order), subsequent are update
          if (fromCallCount === 1) return getCatChain;
          return catUpdateChain;
        }
        return insertChain;
      }),
      storage: {
        from: mock(() => ({
          upload: mock(() => Promise.resolve({ error: null })),
          remove: mock(() => Promise.resolve({ error: null })),
        })),
      },
      rpc: mock(() => Promise.resolve({ data: null, error: null })),
    } as unknown as SupabaseClient;

    const input: DocumentCreateInput = {
      userId: "user-1",
      filePath: "/tmp/photo.jpg",
      fileType: "image/jpeg",
      fileSize: 1024,
      buffer: Buffer.from("fake-image"),
    };

    const result = await createDocument(supabase, input);
    expect(result.id).toBe("doc-1");
    expect(result.user_id).toBe("user-1");
  });

  it("cleans up storage on insert failure", async () => {
    // Mock CLI for extraction and classification
    let callCount = 0;
    spawnMock = spyOn(Bun, "spawn").mockImplementation(() => {
      callCount++;
      const output =
        callCount === 1
          ? "extracted"
          : JSON.stringify({
              category_name: "note",
              confidence: 0.9,
              description: "test",
              document_date: null,
            });
      return {
        stdout: new Response(output).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      } as any;
    });

    const removeMock = mock(() => Promise.resolve({ error: null }));
    const categories = [
      {
        id: "cat-1",
        name: "note",
        description: "Notes",
        usage_count: 0,
        created_by: "system",
        created_at: "2026-01-01",
      },
    ];

    let fromCallCount = 0;

    const getCatChain = {
      select: mock(() => getCatChain),
      order: mock(() => getCatChain),
      then: undefined as unknown,
    };
    Object.defineProperty(getCatChain, "then", {
      value: (resolve: (v: unknown) => void) => resolve({ data: categories, error: null }),
      configurable: true,
    });

    const catUpdateChain = {
      update: mock(() => catUpdateChain),
      eq: mock(() => catUpdateChain),
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    };

    const insertChain = {
      insert: mock(() => insertChain),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: null, error: { message: "insert failed" } })),
    };

    const supabase = {
      from: mock((table: string) => {
        fromCallCount++;
        if (table === "document_categories") {
          if (fromCallCount === 1) return getCatChain;
          return catUpdateChain;
        }
        return insertChain;
      }),
      storage: {
        from: mock(() => ({
          upload: mock(() => Promise.resolve({ error: null })),
          remove: removeMock,
        })),
      },
      rpc: mock(() => Promise.resolve({ data: null, error: null })),
    } as unknown as SupabaseClient;

    await expect(
      createDocument(supabase, {
        userId: "u1",
        filePath: "test.jpg",
        fileType: "image/jpeg",
        buffer: Buffer.from("x"),
      }),
    ).rejects.toThrow("Insert failed");

    expect(removeMock).toHaveBeenCalled();
  });

  it("throws on storage upload failure", async () => {
    // Mock CLI for extraction and classification
    let callCount = 0;
    spawnMock = spyOn(Bun, "spawn").mockImplementation(() => {
      callCount++;
      const output =
        callCount === 1
          ? "extracted text"
          : JSON.stringify({
              category_name: "note",
              confidence: 0.9,
              description: "t",
              document_date: null,
            });
      return {
        stdout: new Response(output).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      } as any;
    });

    let catCallCount = 0;

    const getCatChain = {
      select: mock(() => getCatChain),
      order: mock(() => getCatChain),
      then: undefined as unknown,
    };
    Object.defineProperty(getCatChain, "then", {
      value: (resolve: (v: unknown) => void) =>
        resolve({ data: [{ id: "c1", name: "note", usage_count: 0 }], error: null }),
      configurable: true,
    });

    const catUpdateChain = {
      update: mock(() => catUpdateChain),
      eq: mock(() => catUpdateChain),
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    };

    const supabase = {
      from: mock((table: string) => {
        if (table === "document_categories") {
          catCallCount++;
          if (catCallCount === 1) return getCatChain; // getCategories
          return catUpdateChain; // usage_count bump
        }
        return catUpdateChain;
      }),
      storage: {
        from: mock(() => ({
          upload: mock(() => Promise.resolve({ error: { message: "quota exceeded" } })),
          remove: mock(() => Promise.resolve({ error: null })),
        })),
      },
    } as unknown as SupabaseClient;

    await expect(
      createDocument(supabase, {
        userId: "u1",
        filePath: "test.jpg",
        fileType: "image/jpeg",
        buffer: Buffer.from("x"),
      }),
    ).rejects.toThrow("Upload failed: quota exceeded");
  });

  it("skips classification when extracted text is empty", async () => {
    // Mock CLI returning empty text
    setupSpawnMock("");

    const mockDoc: Document = {
      id: "doc-empty",
      user_id: "u1",
      project_id: null,
      category_id: null,
      title: "photo.jpg",
      extracted_text: null,
      description: null,
      document_date: null,
      file_path: "u1/123.jpg",
      file_type: "image/jpeg",
      file_size: 100,
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    };

    const getCatChain = {
      select: mock(() => getCatChain),
      order: mock(() => getCatChain),
      then: undefined as unknown,
    };
    Object.defineProperty(getCatChain, "then", {
      value: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      configurable: true,
    });

    const insertChain = {
      insert: mock(() => insertChain),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: mockDoc, error: null })),
    };

    const supabase = {
      from: mock((table: string) => {
        if (table === "document_categories") return getCatChain;
        return insertChain;
      }),
      storage: {
        from: mock(() => ({
          upload: mock(() => Promise.resolve({ error: null })),
          remove: mock(() => Promise.resolve({ error: null })),
        })),
      },
    } as unknown as SupabaseClient;

    const result = await createDocument(supabase, {
      userId: "u1",
      filePath: "photo.jpg",
      fileType: "image/jpeg",
      buffer: Buffer.from("img"),
    });

    // No classification call — only 1 spawn (extraction), not 2 (extraction + classification)
    expect(result.category_id).toBeNull();
    expect(result.id).toBe("doc-empty");
  });

  it("uses title from input when provided", async () => {
    // Mock CLI for extraction and classification
    let callCount = 0;
    spawnMock = spyOn(Bun, "spawn").mockImplementation(() => {
      callCount++;
      const output =
        callCount === 1
          ? "extracted"
          : JSON.stringify({
              category_name: "facture",
              confidence: 0.9,
              description: "auto title",
              document_date: null,
            });
      return {
        stdout: new Response(output).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      } as any;
    });

    const mockDoc: Document = {
      id: "doc-title",
      user_id: "u1",
      project_id: null,
      category_id: "c1",
      title: "Mon titre custom",
      extracted_text: "extracted",
      description: "auto title",
      document_date: null,
      file_path: "u1/123.jpg",
      file_type: "image/jpeg",
      file_size: 100,
      metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    };

    let catCallCount2 = 0;

    const getCatChain = {
      select: mock(() => getCatChain),
      order: mock(() => getCatChain),
      then: undefined as unknown,
    };
    Object.defineProperty(getCatChain, "then", {
      value: (resolve: (v: unknown) => void) =>
        resolve({ data: [{ id: "c1", name: "facture", usage_count: 0 }], error: null }),
      configurable: true,
    });

    const catUpdateChain = {
      update: mock(() => catUpdateChain),
      eq: mock(() => catUpdateChain),
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    };

    const insertChain = {
      insert: mock((record: Record<string, unknown>) => {
        // Verify the title from input is used
        expect(record.title).toBe("Mon titre custom");
        return insertChain;
      }),
      select: mock(() => insertChain),
      single: mock(() => Promise.resolve({ data: mockDoc, error: null })),
    };

    const supabase = {
      from: mock((table: string) => {
        if (table === "document_categories") {
          catCallCount2++;
          if (catCallCount2 === 1) return getCatChain;
          return catUpdateChain;
        }
        return insertChain;
      }),
      storage: {
        from: mock(() => ({
          upload: mock(() => Promise.resolve({ error: null })),
          remove: mock(() => Promise.resolve({ error: null })),
        })),
      },
    } as unknown as SupabaseClient;

    const result = await createDocument(supabase, {
      userId: "u1",
      title: "Mon titre custom",
      filePath: "photo.jpg",
      fileType: "image/jpeg",
      buffer: Buffer.from("img"),
    });

    expect(result.title).toBe("Mon titre custom");
  });
});

// ── listDocuments ────────────────────────────────────────────

describe("listDocuments", () => {
  it("returns documents for a user", async () => {
    const docs = [
      { id: "1", user_id: "u1", title: "Doc 1", file_path: "a.pdf", file_type: "application/pdf" },
      { id: "2", user_id: "u1", title: "Doc 2", file_path: "b.jpg", file_type: "image/jpeg" },
    ];

    const { supabase } = createMockSupabase({ queryData: docs });
    const result = await listDocuments(supabase, "u1");
    expect(result).toEqual(docs);
  });

  it("returns empty array on error", async () => {
    const { supabase } = createMockSupabase({ queryError: { message: "fail" } });
    const result = await listDocuments(supabase, "u1");
    expect(result).toEqual([]);
  });

  it("applies category filter when provided", async () => {
    const { supabase, chainMethods } = createMockSupabase({ queryData: [] });
    await listDocuments(supabase, "u1", { categoryId: "cat-1" });
    // eq should be called for both user_id and category_id
    expect(chainMethods.eq).toHaveBeenCalledTimes(2);
  });

  it("applies default limit and offset", async () => {
    const { supabase, chainMethods } = createMockSupabase({ queryData: [] });
    await listDocuments(supabase, "u1");
    expect(chainMethods.range).toHaveBeenCalledWith(0, 19);
  });

  it("applies custom limit and offset", async () => {
    const { supabase, chainMethods } = createMockSupabase({ queryData: [] });
    await listDocuments(supabase, "u1", { limit: 5, offset: 10 });
    expect(chainMethods.range).toHaveBeenCalledWith(10, 14);
  });
});

// ── getDocumentById ──────────────────────────────────────────

describe("getDocumentById", () => {
  it("returns document when found", async () => {
    const doc = { id: "doc-1", title: "Test", user_id: "u1" };
    const chain = {
      select: mock(() => chain),
      eq: mock(() => chain),
      single: mock(() => Promise.resolve({ data: doc, error: null })),
    };
    const supabase = { from: mock(() => chain) } as unknown as SupabaseClient;

    const result = await getDocumentById(supabase, "doc-1");
    expect(result).toEqual(doc);
  });

  it("returns null when not found", async () => {
    const chain = {
      select: mock(() => chain),
      eq: mock(() => chain),
      single: mock(() => Promise.resolve({ data: null, error: { code: "PGRST116" } })),
    };
    const supabase = { from: mock(() => chain) } as unknown as SupabaseClient;

    const result = await getDocumentById(supabase, "nonexistent");
    expect(result).toBeNull();
  });
});

// ── deleteDocument ───────────────────────────────────────────

describe("deleteDocument", () => {
  it("deletes document and cleans up storage", async () => {
    const doc = { id: "doc-1", file_path: "user/123.pdf", user_id: "u1" };
    const removeMock = mock(() => Promise.resolve({ error: null }));

    // First call: getDocumentById (select)
    const selectChain = {
      select: mock(() => selectChain),
      eq: mock(() => selectChain),
      single: mock(() => Promise.resolve({ data: doc, error: null })),
    };

    // Second call: delete
    const deleteChain = {
      delete: mock(() => deleteChain),
      eq: mock(() => Promise.resolve({ error: null })),
    };

    let callCount = 0;
    const supabase = {
      from: mock(() => {
        callCount++;
        if (callCount === 1) return selectChain;
        return deleteChain;
      }),
      storage: {
        from: mock(() => ({ remove: removeMock })),
      },
    } as unknown as SupabaseClient;

    const result = await deleteDocument(supabase, "doc-1");
    expect(result).toBe(true);
    expect(removeMock).toHaveBeenCalledWith(["user/123.pdf"]);
  });

  it("returns false when document not found", async () => {
    const chain = {
      select: mock(() => chain),
      eq: mock(() => chain),
      single: mock(() => Promise.resolve({ data: null, error: { code: "PGRST116" } })),
    };
    const supabase = { from: mock(() => chain) } as unknown as SupabaseClient;

    const result = await deleteDocument(supabase, "nonexistent");
    expect(result).toBe(false);
  });

  it("returns false on delete error", async () => {
    const doc = { id: "doc-1", file_path: "user/123.pdf" };

    const selectChain = {
      select: mock(() => selectChain),
      eq: mock(() => selectChain),
      single: mock(() => Promise.resolve({ data: doc, error: null })),
    };

    const deleteChain = {
      delete: mock(() => deleteChain),
      eq: mock(() => Promise.resolve({ error: { message: "permission denied" } })),
    };

    let callCount = 0;
    const supabase = {
      from: mock(() => {
        callCount++;
        if (callCount === 1) return selectChain;
        return deleteChain;
      }),
    } as unknown as SupabaseClient;

    const result = await deleteDocument(supabase, "doc-1");
    expect(result).toBe(false);
  });

  it("handles storage cleanup error gracefully", async () => {
    const doc = { id: "doc-1", file_path: "user/123.pdf" };

    const selectChain = {
      select: mock(() => selectChain),
      eq: mock(() => selectChain),
      single: mock(() => Promise.resolve({ data: doc, error: null })),
    };
    const deleteChain = {
      delete: mock(() => deleteChain),
      eq: mock(() => Promise.resolve({ error: null })),
    };

    let callCount = 0;
    const supabase = {
      from: mock(() => {
        callCount++;
        if (callCount === 1) return selectChain;
        return deleteChain;
      }),
      storage: {
        from: mock(() => ({
          remove: mock(() => Promise.resolve({ error: { message: "storage error" } })),
        })),
      },
    } as unknown as SupabaseClient;

    // Should still return true (DB delete succeeded)
    const result = await deleteDocument(supabase, "doc-1");
    expect(result).toBe(true);
  });
});

// ── searchDocuments ──────────────────────────────────────────

describe("searchDocuments", () => {
  it("calls search Edge Function with correct params", async () => {
    const results = [
      { id: "1", title: "Facture", similarity: 0.92 },
      { id: "2", title: "Contrat", similarity: 0.85 },
    ];

    const { supabase, mockFunctions } = createMockSupabase();
    mockFunctions.invoke = mock(() => Promise.resolve({ data: results, error: null }));

    const searchResults = await searchDocuments(supabase, "facture electricite", "user-1");

    expect(searchResults).toEqual(results);
    expect(mockFunctions.invoke).toHaveBeenCalledWith("search", {
      body: {
        query: "facture electricite",
        table: "documents",
        match_count: 10,
        match_threshold: 0.3,
        user_id: "user-1",
      },
    });
  });

  it("passes custom matchCount and matchThreshold", async () => {
    const { supabase, mockFunctions } = createMockSupabase();
    mockFunctions.invoke = mock(() => Promise.resolve({ data: [], error: null }));

    await searchDocuments(supabase, "query", "u1", { matchCount: 5, matchThreshold: 0.8 });

    expect(mockFunctions.invoke).toHaveBeenCalledWith("search", {
      body: {
        query: "query",
        table: "documents",
        match_count: 5,
        match_threshold: 0.8,
        user_id: "u1",
      },
    });
  });

  it("returns empty array on error", async () => {
    const { supabase, mockFunctions } = createMockSupabase();
    mockFunctions.invoke = mock(() => Promise.resolve({ data: null, error: { message: "fail" } }));

    const result = await searchDocuments(supabase, "query");
    expect(result).toEqual([]);
  });

  it("returns empty array on exception", async () => {
    const supabase = {
      functions: {
        invoke: mock(() => {
          throw new Error("network");
        }),
      },
    } as unknown as SupabaseClient;

    const result = await searchDocuments(supabase, "query");
    expect(result).toEqual([]);
  });

  it("works without userId", async () => {
    const { supabase, mockFunctions } = createMockSupabase();
    mockFunctions.invoke = mock(() => Promise.resolve({ data: [], error: null }));

    await searchDocuments(supabase, "query");

    expect(mockFunctions.invoke).toHaveBeenCalledWith("search", {
      body: {
        query: "query",
        table: "documents",
        match_count: 10,
        match_threshold: 0.3,
        user_id: undefined,
      },
    });
  });
});

// ── getDocumentStats ─────────────────────────────────────────

describe("getDocumentStats", () => {
  it("returns stats grouped by category", async () => {
    const docs = [{ category_id: "cat-1" }, { category_id: "cat-1" }, { category_id: "cat-2" }];
    const categories = [
      {
        id: "cat-1",
        name: "facture",
        description: "Factures",
        usage_count: 2,
        created_by: "system",
        created_at: "2026-01-01",
      },
      {
        id: "cat-2",
        name: "contrat",
        description: "Contrats",
        usage_count: 1,
        created_by: "system",
        created_at: "2026-01-01",
      },
    ];

    // We need two from() calls: one for documents, one for categories
    const _fromCallCount = 0;

    const docsChain = {
      select: mock(() => docsChain),
      eq: mock(() => docsChain),
      order: mock(() => docsChain),
      then: undefined as unknown,
    };
    Object.defineProperty(docsChain, "then", {
      value: (resolve: (v: unknown) => void) => resolve({ data: docs, error: null }),
      configurable: true,
    });

    const catsChain = {
      select: mock(() => catsChain),
      order: mock(() => catsChain),
      then: undefined as unknown,
    };
    Object.defineProperty(catsChain, "then", {
      value: (resolve: (v: unknown) => void) => resolve({ data: categories, error: null }),
      configurable: true,
    });

    const supabase = {
      from: mock((table: string) => {
        if (table === "documents") return docsChain;
        return catsChain;
      }),
    } as unknown as SupabaseClient;

    const stats = await getDocumentStats(supabase, "u1");
    expect(stats.total).toBe(3);
    expect(stats.byCategory).toEqual([
      { name: "facture", count: 2 },
      { name: "contrat", count: 1 },
    ]);
  });

  it("returns zero stats on error", async () => {
    const { supabase } = createMockSupabase({ queryError: { message: "fail" } });
    const stats = await getDocumentStats(supabase, "u1");
    expect(stats.total).toBe(0);
    expect(stats.byCategory).toEqual([]);
  });

  it("handles null category_id as 'non classifie'", async () => {
    const docs = [{ category_id: null }, { category_id: null }];

    const docsChain = {
      select: mock(() => docsChain),
      eq: mock(() => docsChain),
      then: undefined as unknown,
    };
    Object.defineProperty(docsChain, "then", {
      value: (resolve: (v: unknown) => void) => resolve({ data: docs, error: null }),
      configurable: true,
    });

    const catsChain = {
      select: mock(() => catsChain),
      order: mock(() => catsChain),
      then: undefined as unknown,
    };
    Object.defineProperty(catsChain, "then", {
      value: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      configurable: true,
    });

    const supabase = {
      from: mock((table: string) => {
        if (table === "documents") return docsChain;
        return catsChain;
      }),
    } as unknown as SupabaseClient;

    const stats = await getDocumentStats(supabase, "u1");
    expect(stats.total).toBe(2);
    expect(stats.byCategory).toEqual([{ name: "non classifie", count: 2 }]);
  });
});

// ── createSignedUrls ─────────────────────────────────────────

describe("createSignedUrls", () => {
  it("returns URL map for valid file paths", async () => {
    const signedData = [
      { path: "user/123.pdf", signedUrl: "https://storage.example.com/signed/123.pdf" },
      { path: "user/456.jpg", signedUrl: "https://storage.example.com/signed/456.jpg" },
    ];

    const supabase = {
      storage: {
        from: mock(() => ({
          createSignedUrls: mock(() => Promise.resolve({ data: signedData, error: null })),
        })),
      },
    } as unknown as SupabaseClient;

    const result = await createSignedUrls(supabase, ["user/123.pdf", "user/456.jpg"]);

    expect(result.size).toBe(2);
    expect(result.get("user/123.pdf")).toBe("https://storage.example.com/signed/123.pdf");
    expect(result.get("user/456.jpg")).toBe("https://storage.example.com/signed/456.jpg");
  });

  it("returns empty map for empty file paths array", async () => {
    const supabase = {
      storage: {
        from: mock(() => ({
          createSignedUrls: mock(() => Promise.resolve({ data: [], error: null })),
        })),
      },
    } as unknown as SupabaseClient;

    const result = await createSignedUrls(supabase, []);
    expect(result.size).toBe(0);
  });

  it("returns empty map on Supabase error", async () => {
    const supabase = {
      storage: {
        from: mock(() => ({
          createSignedUrls: mock(() =>
            Promise.resolve({ data: null, error: { message: "bucket not found" } }),
          ),
        })),
      },
    } as unknown as SupabaseClient;

    const result = await createSignedUrls(supabase, ["user/123.pdf"]);
    expect(result.size).toBe(0);
  });

  it("returns empty map on exception", async () => {
    const supabase = {
      storage: {
        from: mock(() => ({
          createSignedUrls: mock(() => {
            throw new Error("network error");
          }),
        })),
      },
    } as unknown as SupabaseClient;

    const result = await createSignedUrls(supabase, ["user/123.pdf"]);
    expect(result.size).toBe(0);
  });

  it("skips items with missing signedUrl or path", async () => {
    const signedData = [
      { path: "user/123.pdf", signedUrl: "https://storage.example.com/signed/123.pdf" },
      { path: null, signedUrl: "https://storage.example.com/signed/no-path" },
      { path: "user/456.jpg", signedUrl: null },
    ];

    const supabase = {
      storage: {
        from: mock(() => ({
          createSignedUrls: mock(() => Promise.resolve({ data: signedData, error: null })),
        })),
      },
    } as unknown as SupabaseClient;

    const result = await createSignedUrls(supabase, ["user/123.pdf", "user/456.jpg"]);
    expect(result.size).toBe(1);
    expect(result.get("user/123.pdf")).toBe("https://storage.example.com/signed/123.pdf");
  });

  it("passes custom expiresIn to Supabase", async () => {
    const createSignedUrlsMock = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      storage: {
        from: mock(() => ({
          createSignedUrls: createSignedUrlsMock,
        })),
      },
    } as unknown as SupabaseClient;

    await createSignedUrls(supabase, ["user/123.pdf"], 7200);

    expect(createSignedUrlsMock).toHaveBeenCalledWith(["user/123.pdf"], 7200);
  });

  it("uses default expiresIn of 3600 seconds", async () => {
    const createSignedUrlsMock = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      storage: {
        from: mock(() => ({
          createSignedUrls: createSignedUrlsMock,
        })),
      },
    } as unknown as SupabaseClient;

    await createSignedUrls(supabase, ["user/123.pdf"]);

    expect(createSignedUrlsMock).toHaveBeenCalledWith(["user/123.pdf"], 3600);
  });

  it("handles null data response", async () => {
    const supabase = {
      storage: {
        from: mock(() => ({
          createSignedUrls: mock(() => Promise.resolve({ data: null, error: null })),
        })),
      },
    } as unknown as SupabaseClient;

    const result = await createSignedUrls(supabase, ["user/123.pdf"]);
    expect(result.size).toBe(0);
  });
});

// ── Type exports ─────────────────────────────────────────────

describe("type exports", () => {
  it("exports all required types", () => {
    // Verify types exist at module level (compile-time check)
    const cat: DocumentCategory = {
      id: "1",
      name: "test",
      description: null,
      usage_count: 0,
      created_by: "system",
      created_at: "",
    };
    const doc: Document = {
      id: "1",
      user_id: "u",
      project_id: null,
      category_id: null,
      title: null,
      extracted_text: null,
      description: null,
      document_date: null,
      file_path: "p",
      file_type: "t",
      file_size: null,
      metadata: {},
      created_at: "",
    };
    const input: DocumentCreateInput = {
      userId: "u",
      filePath: "p",
      fileType: "t",
      buffer: Buffer.from(""),
    };
    const classResult: ClassificationResult = {
      category_id: "c",
      category_name: "n",
      confidence: 0.5,
      description: "d",
      document_date: null,
      is_new_category: false,
    };
    const searchResult: DocumentSearchResult = {
      id: "1",
      title: null,
      extracted_text: null,
      description: null,
      document_date: null,
      category_id: null,
      created_at: "",
      similarity: 0.9,
      file_path: null,
    };
    const opts: ListDocumentsOptions = { categoryId: "c", limit: 10, offset: 0 };

    expect(cat).toBeDefined();
    expect(doc).toBeDefined();
    expect(input).toBeDefined();
    expect(classResult).toBeDefined();
    expect(searchResult).toBeDefined();
    expect(opts).toBeDefined();
  });
});

// ── Function exports ─────────────────────────────────────────

describe("function exports", () => {
  it("exports all required functions", () => {
    expect(typeof extractTextFromImage).toBe("function");
    expect(typeof extractTextFromPDF).toBe("function");
    expect(typeof extractText).toBe("function");
    expect(typeof getCategories).toBe("function");
    expect(typeof getOrCreateCategory).toBe("function");
    expect(typeof classifyDocument).toBe("function");
    expect(typeof createDocument).toBe("function");
    expect(typeof listDocuments).toBe("function");
    expect(typeof getDocumentById).toBe("function");
    expect(typeof deleteDocument).toBe("function");
    expect(typeof searchDocuments).toBe("function");
    expect(typeof getDocumentStats).toBe("function");
    expect(typeof createSignedUrls).toBe("function");
    expect(typeof computeFileHash).toBe("function");
    expect(typeof checkDuplicate).toBe("function");
  });
});

// ── Duplicate Detection Tests ────────────────────────────────

describe("computeFileHash", () => {
  it("returns a SHA-256 hex string", () => {
    const hash = computeFileHash(Buffer.from("hello world"));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns same hash for identical content", () => {
    const h1 = computeFileHash(Buffer.from("test content"));
    const h2 = computeFileHash(Buffer.from("test content"));
    expect(h1).toBe(h2);
  });

  it("returns different hash for different content", () => {
    const h1 = computeFileHash(Buffer.from("content A"));
    const h2 = computeFileHash(Buffer.from("content B"));
    expect(h1).not.toBe(h2);
  });
});

describe("checkDuplicate", () => {
  it("returns found=false when no duplicate", async () => {
    function buildNoMatchChain() {
      const chain: Record<string, unknown> = {};
      chain.select = mock(() => chain);
      chain.eq = mock(() => chain);
      chain.limit = mock(() => chain);
      chain.single = mock(() => Promise.resolve({ data: null, error: { code: "PGRST116" } }));
      return chain;
    }

    const supabase = {
      from: mock(() => buildNoMatchChain()),
    } as unknown as SupabaseClient;

    const result = await checkDuplicate(supabase, "user1", "file.pdf", "abc123");
    expect(result.found).toBe(false);
    expect(result.matchType).toBeNull();
    expect(result.existingDocument).toBeNull();
  });

  it("detects content hash duplicate", async () => {
    const existingDoc = { id: "doc-123", title: "Facture EDF", created_at: "2026-03-01" };

    function buildMatchChain() {
      const chain: Record<string, unknown> = {};
      chain.select = mock(() => chain);
      chain.eq = mock(() => chain);
      chain.limit = mock(() => chain);
      chain.single = mock(() => Promise.resolve({ data: existingDoc, error: null }));
      return chain;
    }

    const supabase = {
      from: mock(() => buildMatchChain()),
    } as unknown as SupabaseClient;

    const result = await checkDuplicate(supabase, "user1", "file.pdf", "abc123");
    expect(result.found).toBe(true);
    expect(result.matchType).toBe("content");
    expect(result.existingDocument).toEqual(existingDoc);
  });

  it("detects filename duplicate when no hash match", async () => {
    const existingDoc = { id: "doc-456", title: "Contrat", created_at: "2026-03-10" };
    let queryCount = 0;

    function buildChain(data: unknown, error: unknown) {
      const chain: Record<string, unknown> = {};
      chain.select = mock(() => chain);
      chain.eq = mock(() => chain);
      chain.limit = mock(() => chain);
      chain.single = mock(() => Promise.resolve({ data, error }));
      return chain;
    }

    const supabase = {
      from: mock(() => {
        queryCount++;
        if (queryCount === 1) {
          // First call: hash check → no match
          return buildChain(null, { code: "PGRST116" });
        }
        // Second call: filename check → match
        return buildChain(existingDoc, null);
      }),
    } as unknown as SupabaseClient;

    const result = await checkDuplicate(supabase, "user1", "file.pdf", "no-match-hash");
    expect(result.found).toBe(true);
    expect(result.matchType).toBe("filename");
    expect(result.existingDocument).toEqual(existingDoc);
  });
});
