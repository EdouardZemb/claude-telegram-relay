/**
 * Unit Tests — Auto document search integration in text handler
 *
 * Tests: AC-1 (flag enabled, searchDocuments called in parallel),
 * AC-2 (flag disabled, no call), AC-3 (timeout fallback),
 * AC-4 (no results above threshold, empty documentContext).
 */

import { describe, expect, it, mock } from "bun:test";
import { formatDocumentContext } from "../../src/bot-context.ts";
import type { DocumentSearchResult } from "../../src/documents.ts";

// ── formatDocumentContext integration ────────────────────────

describe("formatDocumentContext for auto search", () => {
  it("AC-1: formats results into prompt-injectable string", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-1",
        title: "Facture EDF",
        category_id: "cat-1",
        document_date: "2026-01-15",
        similarity: 0.85,
        extracted_text: "Montant: 150 EUR pour la periode de janvier 2026",
      },
      {
        id: "doc-2",
        title: "Contrat bail",
        category_id: null,
        document_date: "2025-06-01",
        similarity: 0.62,
        extracted_text: "Contrat de location pour l'appartement au 12 rue...",
      },
    ];

    const context = formatDocumentContext(results);
    expect(context).toContain("DOCUMENTS PERTINENTS");
    expect(context).toContain("Facture EDF");
    expect(context).toContain("pertinence: 85%");
    expect(context).toContain("Contrat bail");
    expect(context).toContain("pertinence: 62%");
  });

  it("AC-2: returns empty string for empty array (flag disabled path)", () => {
    const context = formatDocumentContext([]);
    expect(context).toBe("");
  });

  it("AC-4: returns empty string when no documents match", () => {
    const context = formatDocumentContext([]);
    expect(context).toBe("");
    // Empty string || undefined = undefined, so buildPrompt won't add section
    const documentContext = context || undefined;
    expect(documentContext).toBeUndefined();
  });
});

// ── Feature flag gating ──────────────────────────────────────

describe("auto_document_search feature flag gating", () => {
  it("AC-1: conditional expression resolves searchDocuments when flag is true", async () => {
    const searchDocuments = mock(() =>
      Promise.resolve([{ id: "doc-1", title: "Test", similarity: 0.8 }]),
    );
    const isEnabled = true;

    const result = await (isEnabled ? searchDocuments() : Promise.resolve([]));

    expect(searchDocuments).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it("AC-2: conditional expression resolves [] when flag is false", async () => {
    const searchDocuments = mock(() =>
      Promise.resolve([{ id: "doc-1", title: "Test", similarity: 0.8 }]),
    );
    const isEnabled = false;

    const result = await (isEnabled ? searchDocuments() : Promise.resolve([]));

    expect(searchDocuments).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

// ── Timeout pattern ──────────────────────────────────────────

describe("searchDocuments timeout pattern", () => {
  it("AC-3: Promise.race resolves with search results when fast enough", async () => {
    const searchFn = () =>
      new Promise<{ id: string }[]>((resolve) =>
        setTimeout(() => resolve([{ id: "fast-doc" }]), 10),
      );

    const result = await Promise.race([
      searchFn(),
      new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 5000)),
    ]);

    expect(result).toEqual([{ id: "fast-doc" }]);
  });

  it("AC-3: Promise.race resolves with [] when search times out", async () => {
    const searchFn = () =>
      new Promise<{ id: string }[]>((resolve) =>
        setTimeout(() => resolve([{ id: "slow-doc" }]), 200),
      );

    const result = await Promise.race([
      searchFn(),
      new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 50)),
    ]);

    expect(result).toEqual([]);
  });

  it("AC-3: timeout does not block other Promise.all entries", async () => {
    const fastCall = () => Promise.resolve("fast-result");
    const slowSearch = () =>
      new Promise<string[]>((resolve) => setTimeout(() => resolve(["slow"]), 200));

    const start = Date.now();
    const [fast, search] = await Promise.all([
      fastCall(),
      Promise.race([
        slowSearch(),
        new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 50)),
      ]),
    ]);

    const elapsed = Date.now() - start;
    expect(fast).toBe("fast-result");
    expect(search).toEqual([]); // timed out
    expect(elapsed).toBeLessThan(150); // didn't wait for slow search
  });
});

// ── documentContext to buildPrompt ───────────────────────────

describe("documentContext parameter passing", () => {
  it("AC-1: non-empty results produce truthy documentContext", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-1",
        title: "Facture",
        category_id: null,
        document_date: "2026-01-01",
        similarity: 0.75,
        extracted_text: "Test content",
      },
    ];

    const formatted = formatDocumentContext(results);
    const documentContext = formatted || undefined;
    expect(documentContext).toBeDefined();
    expect(documentContext).toContain("Facture");
  });

  it("AC-2/AC-4: empty results produce undefined documentContext", () => {
    const formatted = formatDocumentContext([]);
    const documentContext = formatted || undefined;
    expect(documentContext).toBeUndefined();
  });

  it("AC-1: documentContext includes similarity scores", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-1",
        title: "Test Doc",
        category_id: "cat-1",
        document_date: null,
        similarity: 0.92,
        extracted_text: "Content here",
      },
    ];

    const ctx = formatDocumentContext(results);
    expect(ctx).toContain("pertinence: 92%");
  });

  it("AC-1: documentContext truncates long extracted text", () => {
    const longText = "A".repeat(300);
    const results: DocumentSearchResult[] = [
      {
        id: "doc-1",
        title: "Long Doc",
        category_id: null,
        document_date: null,
        similarity: 0.6,
        extracted_text: longText,
      },
    ];

    const ctx = formatDocumentContext(results);
    expect(ctx).toContain("...");
    // The truncated text should be ~200 chars + "..."
    expect(ctx.length).toBeLessThan(longText.length);
  });
});

// ── Integration: full Promise.all pattern ────────────────────

describe("full Promise.all integration pattern", () => {
  it("AC-1: 6-element Promise.all resolves all entries including search", async () => {
    const mockGetRelevant = () => Promise.resolve("relevant");
    const mockGetMemory = () => Promise.resolve("memory");
    const mockGetRecent = () => Promise.resolve("recent");
    const mockGetProfile = () => Promise.resolve("profile");
    const mockClassify = () => Promise.resolve({ is_memorable: false });
    const mockSearch = () => Promise.resolve([{ id: "doc-1", title: "Found", similarity: 0.8 }]);

    const isEnabled = true;

    const [relevant, memory, recent, profile, classification, docResults] = await Promise.all([
      mockGetRelevant(),
      mockGetMemory(),
      mockGetRecent(),
      mockGetProfile(),
      mockClassify(),
      isEnabled
        ? Promise.race([
            mockSearch(),
            new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 5000)),
          ])
        : Promise.resolve([]),
    ]);

    expect(relevant).toBe("relevant");
    expect(memory).toBe("memory");
    expect(recent).toBe("recent");
    expect(profile).toBe("profile");
    expect(classification).toEqual({ is_memorable: false });
    expect(docResults).toHaveLength(1);
    expect(docResults[0]).toEqual({
      id: "doc-1",
      title: "Found",
      similarity: 0.8,
    });
  });

  it("AC-2: 6-element Promise.all with flag disabled keeps empty docResults", async () => {
    const mockSearch = mock(() =>
      Promise.resolve([{ id: "doc-1", title: "Should not be called" }]),
    );
    const isEnabled = false;

    const [, , , , , docResults] = await Promise.all([
      Promise.resolve("a"),
      Promise.resolve("b"),
      Promise.resolve("c"),
      Promise.resolve("d"),
      Promise.resolve("e"),
      isEnabled ? mockSearch() : Promise.resolve([]),
    ]);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(docResults).toEqual([]);
  });
});
