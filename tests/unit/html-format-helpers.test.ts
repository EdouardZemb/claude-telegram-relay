/**
 * Unit Tests — src/html-format-helpers.ts
 *
 * TDD tests for shared HTML formatting helpers for Telegram.
 */

import { describe, expect, it } from "bun:test";
import {
  bulletList,
  collapsibleSection,
  kvLine,
  progressBar,
  sectionTitle,
  separator,
  statusIcon,
} from "../../src/html-format-helpers";

// ── sectionTitle ─────────────────────────────────────────────

describe("sectionTitle", () => {
  it("wraps text in <b> tags with separator line", () => {
    const result = sectionTitle("Mon titre");
    expect(result).toContain("<b>Mon titre</b>");
    expect(result).toContain("─");
    // Should have two lines: title + separator
    const lines = result.split("\n");
    expect(lines.length).toBe(2);
  });

  it("escapes HTML in text", () => {
    const result = sectionTitle("Test <script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("handles empty string", () => {
    const result = sectionTitle("");
    expect(result).toContain("<b></b>");
  });
});

// ── separator ────────────────────────────────────────────────

describe("separator", () => {
  it("returns a line of Unicode box-drawing characters", () => {
    const result = separator();
    expect(result).toMatch(/^─+$/);
    expect(result.length).toBeGreaterThanOrEqual(10);
  });
});

// ── progressBar ──────────────────────────────────────────────

describe("progressBar", () => {
  it("returns 0% bar correctly", () => {
    const result = progressBar(0, 10);
    expect(result).toContain("0%");
    // Should have empty blocks
    expect(result).toContain("░");
  });

  it("returns 100% bar correctly", () => {
    const result = progressBar(10, 10);
    expect(result).toContain("100%");
    // Should have full blocks
    expect(result).toContain("█");
  });

  it("returns 50% bar correctly", () => {
    const result = progressBar(5, 10);
    expect(result).toContain("50%");
    expect(result).toContain("█");
    expect(result).toContain("░");
  });

  it("handles total 0 without error", () => {
    const result = progressBar(0, 0);
    expect(result).toContain("0%");
  });

  it("supports custom width", () => {
    const wide = progressBar(5, 10, 20);
    const narrow = progressBar(5, 10, 5);
    // The wide bar should have more characters
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it("clamps values above total", () => {
    const result = progressBar(15, 10);
    expect(result).toContain("100%");
  });
});

// ── kvLine ───────────────────────────────────────────────────

describe("kvLine", () => {
  it("formats key-value with italic key and code value", () => {
    const result = kvLine("Statut", "actif");
    expect(result).toContain("<i>Statut:</i>");
    expect(result).toContain("<code>actif</code>");
  });

  it("handles numeric values", () => {
    const result = kvLine("Compte", 42);
    expect(result).toContain("<code>42</code>");
  });

  it("escapes HTML in both key and value", () => {
    const result = kvLine("K<ey", "V<alue");
    expect(result).toContain("K&lt;ey");
    expect(result).toContain("V&lt;alue");
  });
});

// ── statusIcon ───────────────────────────────────────────────

describe("statusIcon", () => {
  it("returns distinct icons for each severity", () => {
    const ok = statusIcon("ok");
    const warning = statusIcon("warning");
    const critical = statusIcon("critical");
    const info = statusIcon("info");

    // All should be non-empty
    expect(ok.length).toBeGreaterThan(0);
    expect(warning.length).toBeGreaterThan(0);
    expect(critical.length).toBeGreaterThan(0);
    expect(info.length).toBeGreaterThan(0);

    // All should be different from each other
    const icons = new Set([ok, warning, critical, info]);
    expect(icons.size).toBe(4);
  });
});

// ── bulletList ───────────────────────────────────────────────

describe("bulletList", () => {
  it("formats items with Unicode bullet points", () => {
    const result = bulletList(["Premier", "Deuxieme"]);
    const lines = result.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^[•▸▹\-\s]+Premier$/);
    expect(lines[1]).toMatch(/^[•▸▹\-\s]+Deuxieme$/);
  });

  it("returns empty string for empty array", () => {
    expect(bulletList([])).toBe("");
  });

  it("escapes HTML in items", () => {
    const result = bulletList(["<b>bold</b>"]);
    expect(result).toContain("&lt;b&gt;");
  });
});

// ── collapsibleSection ───────────────────────────────────────

describe("collapsibleSection", () => {
  it("wraps content in expandable blockquote", () => {
    const result = collapsibleSection("Details", "Some long content here");
    expect(result).toContain("<blockquote expandable>");
    expect(result).toContain("</blockquote>");
    expect(result).toContain("<b>Details</b>");
    expect(result).toContain("Some long content here");
  });

  it("escapes HTML in title", () => {
    const result = collapsibleSection("<Test>", "content");
    expect(result).toContain("&lt;Test&gt;");
  });

  it("preserves content as-is (pre-formatted HTML)", () => {
    const result = collapsibleSection("Title", "<b>bold</b>");
    expect(result).toContain("<b>bold</b>");
  });
});

// ── Integration: composability ────────────────────────────────

describe("composability", () => {
  it("helpers compose together naturally", () => {
    const lines = [
      sectionTitle("Sprint S25"),
      kvLine("Progression", "80%"),
      progressBar(8, 10),
      separator(),
      bulletList(["Item 1", "Item 2"]),
    ];
    const result = lines.join("\n");

    expect(result).toContain("<b>Sprint S25</b>");
    expect(result).toContain("<i>Progression:</i>");
    expect(result).toContain("█");
    expect(result).toContain("─");
  });
});
