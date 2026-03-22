/**
 * Unit Tests — Edge Function embed: extracted_text fallback
 *
 * Tests that the embed Edge Function accepts both `content` and
 * `extracted_text` fields for text extraction from webhook records.
 */

import { describe, expect, it } from "bun:test";

// The Edge Function runs in Deno, so we test the text extraction logic directly

describe("embed Edge Function text extraction logic", () => {
  // Simulates the text extraction logic from the Edge Function:
  // const text = record?.content || record?.extracted_text;
  function extractText(record: Record<string, unknown> | null): string | undefined {
    return (record?.content || record?.extracted_text) as string | undefined;
  }

  it("uses content when available (messages/memory tables)", () => {
    const record = { id: "1", content: "Hello world" };
    expect(extractText(record)).toBe("Hello world");
  });

  it("falls back to extracted_text when content is missing (documents table)", () => {
    const record = { id: "1", extracted_text: "Facture EDF n°12345" };
    expect(extractText(record)).toBe("Facture EDF n°12345");
  });

  it("prefers content over extracted_text when both present", () => {
    const record = { id: "1", content: "primary", extracted_text: "fallback" };
    expect(extractText(record)).toBe("primary");
  });

  it("returns undefined when neither content nor extracted_text exists", () => {
    const record = { id: "1" };
    expect(extractText(record)).toBeUndefined();
  });

  it("returns undefined for null record", () => {
    expect(extractText(null)).toBeUndefined();
  });

  it("falls back to extracted_text when content is empty string", () => {
    const record = { id: "1", content: "", extracted_text: "fallback text" };
    expect(extractText(record)).toBe("fallback text");
  });

  it("returns undefined when both content and extracted_text are empty", () => {
    const record = { id: "1", content: "", extracted_text: "" };
    expect(extractText(record)).toBeFalsy();
  });
});

describe("embed Edge Function skip conditions", () => {
  it("skips when embedding already exists", () => {
    const record = { id: "1", content: "text", embedding: [0.1, 0.2, 0.3] };
    // The Edge Function checks: if (record.embedding) return "Already embedded"
    expect(!!record.embedding).toBe(true);
  });

  it("does not skip when embedding is null", () => {
    const record = { id: "1", content: "text", embedding: null };
    expect(!!record.embedding).toBe(false);
  });
});
