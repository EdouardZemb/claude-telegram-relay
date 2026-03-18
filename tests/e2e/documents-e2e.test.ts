/**
 * E2E tests for document management flow.
 * Tests: /docs commands, callback query handling, photo/document handler routing.
 * Uses Grammy handleUpdate injection via E2E framework.
 *
 * External API calls (Anthropic Vision, Telegram file download, Supabase
 * Storage) are intercepted via fetch mock. Supabase REST calls go through
 * the real client when configured.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { E2EFramework } from "./framework";

// ── Fetch mock for Telegram file downloads + Anthropic API ──────

const originalFetch = globalThis.fetch;

function mockExternalFetch(): void {
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();

    // Telegram file download → fake image buffer
    if (url.includes("api.telegram.org/file/")) {
      return new Response(Buffer.from("fake-image-data-for-e2e"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    // Anthropic Vision/Classification API → fake responses
    if (url.includes("api.anthropic.com")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const isVision = body?.messages?.[0]?.content?.some?.(
        (c: { type: string }) => c.type === "image",
      );

      if (isVision) {
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: "Facture EDF montant 150 EUR date 18/03/2026",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Classification response
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                category_name: "facture",
                confidence: 0.9,
                description: "Facture electricite EDF",
                document_date: "2026-03-18",
                suggested_title: "Facture EDF Mars 2026",
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Supabase Storage upload → fake success (bucket may not exist)
    if (url.includes("/storage/v1/object/")) {
      return new Response(
        JSON.stringify({ Key: "documents/e2e/test.jpg" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Supabase Edge Functions (search) → fake empty results
    if (url.includes("/functions/v1/search")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // All other requests (Supabase REST, etc.) → real fetch
    return originalFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ── Helpers ─────────────────────────────────────────────────────

const hasSupabase = !!(
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
);

// Valid UUID for Supabase queries (non-existent document)
const FAKE_DOC_UUID = "00000000-0000-4000-a000-000000000001";

// ── Environment setup for E2E ───────────────────────────────────

// Save original to restore later
const origAnthropicKey = process.env.ANTHROPIC_API_KEY;

// ── Tests ───────────────────────────────────────────────────────

describe("E2E Document Flow", () => {
  let fw: E2EFramework;

  beforeAll(async () => {
    // Set fake Anthropic key so extractText uses fetch (mocked) instead of throwing
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "e2e-fake-key";

    mockExternalFetch();
    fw = new E2EFramework({ runId: `doc-e2e-${Date.now()}` });
    await fw.setup();
  });

  afterAll(async () => {
    // Restore original
    if (origAnthropicKey) {
      process.env.ANTHROPIC_API_KEY = origAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }

    restoreFetch();
    await fw.teardown();
  });

  // ── /docs command subcommands ─────────────────────────────────

  describe("/docs commands", () => {
    test("/docs without args returns a response", async () => {
      const reply = await fw.sendCommand("/docs");
      expect(reply.length).toBeGreaterThan(0);
      if (hasSupabase) {
        // Default subcommand is "list" → shows documents or empty state
        expect(reply).toBeTruthy();
      } else {
        fw.assertContains(reply, "supabase");
      }
    });

    test("/docs list returns document list or empty state", async () => {
      const reply = await fw.sendCommand("/docs list");
      expect(reply.length).toBeGreaterThan(0);
      if (hasSupabase) {
        const hasContent =
          reply.toLowerCase().includes("document") ||
          reply.toLowerCase().includes("aucun");
        expect(hasContent).toBe(true);
      } else {
        fw.assertContains(reply, "supabase");
      }
    });

    test("/docs search without query shows usage", async () => {
      const reply = await fw.sendCommand("/docs search");
      expect(reply.length).toBeGreaterThan(0);
      if (hasSupabase) {
        fw.assertContains(reply, "usage");
      } else {
        fw.assertContains(reply, "supabase");
      }
    });

    test("/docs search with query returns results or empty", async () => {
      const reply = await fw.sendCommand("/docs search facture");
      expect(reply.length).toBeGreaterThan(0);
      if (hasSupabase) {
        const hasContent =
          reply.toLowerCase().includes("facture") ||
          reply.toLowerCase().includes("aucun");
        expect(hasContent).toBe(true);
      } else {
        fw.assertContains(reply, "supabase");
      }
    });

    test("/docs stats returns statistics or empty state", async () => {
      const reply = await fw.sendCommand("/docs stats");
      expect(reply.length).toBeGreaterThan(0);
      if (hasSupabase) {
        const hasContent =
          reply.toLowerCase().includes("statistiques") ||
          reply.toLowerCase().includes("aucun");
        expect(hasContent).toBe(true);
      } else {
        fw.assertContains(reply, "supabase");
      }
    });

    test("/docs categories returns categories or empty state", async () => {
      const reply = await fw.sendCommand("/docs categories");
      expect(reply.length).toBeGreaterThan(0);
      if (hasSupabase) {
        const hasContent =
          reply.toLowerCase().includes("categories") ||
          reply.toLowerCase().includes("aucune");
        expect(hasContent).toBe(true);
      } else {
        fw.assertContains(reply, "supabase");
      }
    });

    test("/docs unknown shows usage help", async () => {
      const reply = await fw.sendCommand("/docs unknown");
      expect(reply.length).toBeGreaterThan(0);
      if (hasSupabase) {
        fw.assertContains(reply, "usage");
      } else {
        fw.assertContains(reply, "supabase");
      }
    });
  });

  // ── Photo handler routing ─────────────────────────────────────

  describe("Photo handler routing", () => {
    test.skipIf(!hasSupabase)(
      "photo with document caption triggers handler and responds",
      async () => {
        const reply = await fw.sendPhoto({
          caption: "facture EDF mars",
          fileSize: 100000,
        });
        // Handler fires — either "Document enregistre" or error fallback
        expect(reply.length).toBeGreaterThan(0);
      },
    );

    test.skipIf(!hasSupabase)(
      "photo with 'contrat' caption triggers handler",
      async () => {
        const reply = await fw.sendPhoto({
          caption: "contrat de bail",
          fileSize: 80000,
        });
        expect(reply.length).toBeGreaterThan(0);
      },
    );

    test.skipIf(!hasSupabase)(
      "large photo without caption triggers handler (size heuristic)",
      async () => {
        const reply = await fw.sendPhoto({ fileSize: 200000 });
        expect(reply.length).toBeGreaterThan(0);
      },
    );
  });

  // ── Document handler routing ──────────────────────────────────

  describe("Document handler routing", () => {
    test.skipIf(!hasSupabase)(
      "PDF document triggers handler and responds",
      async () => {
        const reply = await fw.sendDocument({
          fileName: "facture-edf.pdf",
          mimeType: "application/pdf",
          fileSize: 50000,
        });
        expect(reply.length).toBeGreaterThan(0);
      },
    );

    test.skipIf(!hasSupabase)(
      "JPEG image document triggers handler",
      async () => {
        const reply = await fw.sendDocument({
          fileName: "scan-ordonnance.jpg",
          mimeType: "image/jpeg",
          fileSize: 60000,
        });
        expect(reply.length).toBeGreaterThan(0);
      },
    );

    test.skipIf(!hasSupabase)(
      "unsupported MIME type falls through to analysis",
      async () => {
        // text/plain is not in DOCUMENT_MIME_TYPES
        // Falls through to Claude analysis (which may take time with CLI)
        const reply = await fw.sendDocument({
          fileName: "notes.txt",
          mimeType: "text/plain",
          fileSize: 1000,
        });
        // Should NOT contain "Document enregistre"
        if (reply.length > 0) {
          fw.assertNotContains(reply, "document enregistre");
        }
      },
      { timeout: 30000 },
    );
  });

  // ── Callback query handling ───────────────────────────────────

  describe("Callback query handling", () => {
    test.skipIf(!hasSupabase)(
      "doc_confirm callback answers with confirmation",
      async () => {
        await fw.sendCallbackQuery(
          `doc_confirm:${FAKE_DOC_UUID}`,
          "Document en attente",
        );
        const answers = fw.getLastCallbackAnswers();
        expect(answers.length).toBeGreaterThan(0);
        expect(answers[0]).toContain("Classification confirmee");
      },
    );

    test.skipIf(!hasSupabase)(
      "doc_cancel callback processes cancellation",
      async () => {
        await fw.sendCallbackQuery(
          `doc_cancel:${FAKE_DOC_UUID}`,
          "Document en attente",
        );
        const answers = fw.getLastCallbackAnswers();
        expect(answers.length).toBeGreaterThan(0);
        // Non-existent doc → deleteDocument returns false → error answer
        // OR doc exists → "Document annule."
        expect(answers[0]).toBeTruthy();
      },
    );

    test.skipIf(!hasSupabase)(
      "doc_change callback responds",
      async () => {
        await fw.sendCallbackQuery(
          `doc_change:${FAKE_DOC_UUID}`,
          "Document en attente",
        );
        const answers = fw.getLastCallbackAnswers();
        const edited = fw.getLastEditedMessages();
        // Either shows category picker or "Aucune categorie"
        expect(answers.length + edited.length).toBeGreaterThan(0);
      },
    );

    test.skipIf(!hasSupabase)(
      "doc_delete_confirm processes deletion",
      async () => {
        await fw.sendCallbackQuery(
          `doc_delete_confirm:${FAKE_DOC_UUID}`,
          "Confirmer suppression?",
        );
        const answers = fw.getLastCallbackAnswers();
        expect(answers.length).toBeGreaterThan(0);
      },
    );

    test.skipIf(!hasSupabase)(
      "doc_delete_cancel cancels deletion",
      async () => {
        const reply = await fw.sendCallbackQuery(
          `doc_delete_cancel:${FAKE_DOC_UUID}`,
          "Confirmer suppression?",
        );
        const answers = fw.getLastCallbackAnswers();
        expect(answers.length).toBeGreaterThan(0);
        expect(answers[0]).toContain("annulee");
        fw.assertContains(reply, "suppression annulee");
      },
    );

    test.skipIf(!hasSupabase)(
      "doc_confirm with empty ID returns error",
      async () => {
        await fw.sendCallbackQuery("doc_confirm:", "Document en attente");
        const answers = fw.getLastCallbackAnswers();
        expect(answers.length).toBeGreaterThan(0);
      },
    );

    test("non-doc callback does not crash", async () => {
      // Callback with non-doc_ prefix should not be handled by doc handler
      await fw.sendCallbackQuery("some_other_action:123", "Some message");
      // Just verify no crash — no specific response expected
      expect(true).toBe(true);
    });
  });
});
