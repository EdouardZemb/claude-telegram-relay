import { describe, it, expect } from "bun:test";
import { formatDocumentContext } from "../../src/bot-context.ts";
import type { DocumentSearchResult } from "../../src/documents.ts";

describe("formatDocumentContext", () => {
  it("returns empty string for empty array (AC-1)", () => {
    expect(formatDocumentContext([])).toBe("");
  });

  it("formats 3 documents with header, numbering, title, category_id, date, score%, summary (AC-2)", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-1",
        title: "Facture EDF",
        extracted_text: "Montant total: 127.50 EUR",
        description: null,
        document_date: "2026-01-15",
        category_id: "a1b2c3d4",
        created_at: "2026-01-15T10:00:00Z",
        similarity: 0.87,
        file_path: "docs/facture.pdf",
      },
      {
        id: "doc-2",
        title: "Contrat de bail",
        extracted_text: "Bail de 3 ans pour le logement situe au 12 rue de la Paix",
        description: null,
        document_date: "2025-06-01",
        category_id: "e5f6g7h8",
        created_at: "2025-06-01T08:00:00Z",
        similarity: 0.72,
        file_path: "docs/bail.pdf",
      },
      {
        id: "doc-3",
        title: "Ordonnance medicale",
        extracted_text: "Prescription de paracetamol 1000mg",
        description: null,
        document_date: "2026-03-10",
        category_id: "i9j0k1l2",
        created_at: "2026-03-10T14:30:00Z",
        similarity: 0.55,
        file_path: "docs/ordo.pdf",
      },
    ];

    const result = formatDocumentContext(results);

    expect(result).toContain("--- DOCUMENTS PERTINENTS ---");
    expect(result).toContain("[1] Facture EDF");
    expect(result).toContain("[2] Contrat de bail");
    expect(result).toContain("[3] Ordonnance medicale");
    expect(result).toContain("cat: a1b2c3d4");
    expect(result).toContain("2026-01-15");
    expect(result).toContain("pertinence: 87%");
    expect(result).toContain("pertinence: 72%");
    expect(result).toContain("pertinence: 55%");
    expect(result).toContain("Montant total: 127.50 EUR");
  });

  it("truncates extracted_text to 200 chars with '...' (AC-3)", () => {
    const longText = "A".repeat(500);
    const results: DocumentSearchResult[] = [
      {
        id: "doc-long",
        title: "Long document",
        extracted_text: longText,
        description: null,
        document_date: "2026-01-01",
        category_id: null,
        created_at: "2026-01-01T00:00:00Z",
        similarity: 0.9,
        file_path: "docs/long.pdf",
      },
    ];

    const result = formatDocumentContext(results);
    const summaryLine = result.split("\n").find((l) => l.startsWith("    "))!;
    const summary = summaryLine.trim();

    // 200 chars + "..." = 203 chars max
    expect(summary.length).toBeLessThanOrEqual(203);
    expect(summary).toEndWith("...");
    expect(summary).toBe("A".repeat(200) + "...");
  });

  it("does not add '...' when text is <= 200 chars", () => {
    const shortText = "Short content here";
    const results: DocumentSearchResult[] = [
      {
        id: "doc-short",
        title: "Short doc",
        extracted_text: shortText,
        description: null,
        document_date: "2026-02-01",
        category_id: "cat-1",
        created_at: "2026-02-01T00:00:00Z",
        similarity: 0.65,
        file_path: "docs/short.pdf",
      },
    ];

    const result = formatDocumentContext(results);
    expect(result).toContain(shortText);
    expect(result).not.toContain("...");
  });

  it("handles null title with fallback", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-notitle",
        title: null,
        extracted_text: "Some content",
        description: null,
        document_date: "2026-01-01",
        category_id: null,
        created_at: "2026-01-01T00:00:00Z",
        similarity: 0.8,
        file_path: "docs/notitle.pdf",
      },
    ];

    const result = formatDocumentContext(results);
    expect(result).toContain("Document sans titre");
  });

  it("handles null document_date with fallback", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-nodate",
        title: "No date doc",
        extracted_text: "Content",
        description: null,
        document_date: null,
        category_id: null,
        created_at: "2026-01-01T00:00:00Z",
        similarity: 0.6,
        file_path: "docs/nodate.pdf",
      },
    ];

    const result = formatDocumentContext(results);
    expect(result).toContain("date inconnue");
  });

  it("handles null extracted_text gracefully", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-notext",
        title: "No text doc",
        extracted_text: null,
        description: null,
        document_date: "2026-01-01",
        category_id: "cat-1",
        created_at: "2026-01-01T00:00:00Z",
        similarity: 0.75,
        file_path: "docs/notext.pdf",
      },
    ];

    const result = formatDocumentContext(results);
    expect(result).toContain("[1] No text doc");
    // No summary line for null extracted_text
    const lines = result.split("\n");
    const summaryLines = lines.filter((l) => l.startsWith("    "));
    expect(summaryLines.length).toBe(0);
  });

  it("omits category when category_id is null", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-nocat",
        title: "No category",
        extracted_text: "Content",
        description: null,
        document_date: "2026-01-01",
        category_id: null,
        created_at: "2026-01-01T00:00:00Z",
        similarity: 0.5,
        file_path: "docs/nocat.pdf",
      },
    ];

    const result = formatDocumentContext(results);
    expect(result).not.toContain("cat:");
    expect(result).toContain("2026-01-01");
  });

  it("rounds similarity correctly", () => {
    const results: DocumentSearchResult[] = [
      {
        id: "doc-round",
        title: "Rounding test",
        extracted_text: "Content",
        description: null,
        document_date: "2026-01-01",
        category_id: null,
        created_at: "2026-01-01T00:00:00Z",
        similarity: 0.876,
        file_path: "docs/round.pdf",
      },
    ];

    const result = formatDocumentContext(results);
    expect(result).toContain("pertinence: 88%");
  });
});
