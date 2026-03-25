/**
 * Unit Tests -- src/inline-menus.ts
 *
 * Tests for the progressive inline menu system:
 * - Category grouping from action-registry
 * - Keyboard builders (main menu, category sub-menus, back navigation)
 * - Onboarding keyboard for /start
 * - Constraint enforcement (<=5 rows, <=64 bytes callback_data)
 */

import { describe, expect, it } from "bun:test";
import {
  buildBacklogActionKeyboard,
  buildCategoryKeyboard,
  buildMainMenuKeyboard,
  buildNotifyPrefsKeyboard,
  buildOnboardingKeyboard,
  buildQualityNavKeyboard,
  getActionsForCategory,
  MENU_CATEGORIES,
} from "../../src/inline-menus.ts";

// ── V1: MENU_CATEGORIES definition ────────────────────────────

describe("MENU_CATEGORIES", () => {
  it("V1: defines 4-5 categories", () => {
    expect(MENU_CATEGORIES.length).toBeGreaterThanOrEqual(4);
    expect(MENU_CATEGORIES.length).toBeLessThanOrEqual(6);
  });

  it("V1: each category has id, label, description", () => {
    for (const cat of MENU_CATEGORIES) {
      expect(cat.id).toBeTruthy();
      expect(cat.label).toBeTruthy();
      expect(cat.description).toBeTruthy();
    }
  });

  it("V1: category ids are unique", () => {
    const ids = MENU_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── V2: getActionsForCategory ──────────────────────────────────

describe("getActionsForCategory", () => {
  it("V2: returns non-empty list for each category", () => {
    for (const cat of MENU_CATEGORIES) {
      const actions = getActionsForCategory(cat.id);
      expect(actions.length).toBeGreaterThan(0);
    }
  });

  it("V2: all registered actions are covered by at least one category", () => {
    const { getAllActions } = require("../../src/action-registry.ts");
    const allCommands = getAllActions().map((a: { command: string }) => a.command);
    const categorized = new Set<string>();
    for (const cat of MENU_CATEGORIES) {
      for (const a of getActionsForCategory(cat.id)) {
        categorized.add(a.command);
      }
    }
    for (const cmd of allCommands) {
      expect(categorized.has(cmd)).toBe(true);
    }
  });

  it("V2: returns empty for unknown category", () => {
    expect(getActionsForCategory("nonexistent")).toHaveLength(0);
  });
});

// ── V3: buildMainMenuKeyboard ──────────────────────────────────

describe("buildMainMenuKeyboard", () => {
  it("V3: returns an InlineKeyboard with one row per category", () => {
    const kb = buildMainMenuKeyboard();
    expect(kb).toBeDefined();
    const rows = kb.inline_keyboard;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("V3: each button has menu_ prefixed callback_data", () => {
    const kb = buildMainMenuKeyboard();
    const buttons = kb.inline_keyboard.flat();
    for (const btn of buttons) {
      const data = (btn as { callback_data?: string }).callback_data;
      expect(data).toBeDefined();
      expect(data!.startsWith("menu_cat:")).toBe(true);
    }
  });

  it("V3: callback_data <= 64 bytes", () => {
    const kb = buildMainMenuKeyboard();
    const buttons = kb.inline_keyboard.flat();
    for (const btn of buttons) {
      const data = (btn as { callback_data?: string }).callback_data || "";
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
  });

  it("V3: max 5 rows for iOS compatibility", () => {
    const kb = buildMainMenuKeyboard();
    expect(kb.inline_keyboard.length).toBeLessThanOrEqual(5);
  });
});

// ── V4: buildCategoryKeyboard ──────────────────────────────────

describe("buildCategoryKeyboard", () => {
  it("V4: returns keyboard with command buttons for a known category", () => {
    const catId = MENU_CATEGORIES[0].id;
    const kb = buildCategoryKeyboard(catId);
    expect(kb).toBeDefined();
    const buttons = kb!.inline_keyboard.flat();
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("V4: includes a 'Retour' (back) button on last row", () => {
    const catId = MENU_CATEGORIES[0].id;
    const kb = buildCategoryKeyboard(catId);
    expect(kb).toBeDefined();
    const lastRow = kb!.inline_keyboard[kb!.inline_keyboard.length - 1];
    const texts = lastRow.map((b) => b.text);
    expect(texts).toContain("Retour");
  });

  it("V4: callback_data uses menu_cmd: prefix", () => {
    const catId = MENU_CATEGORIES[0].id;
    const kb = buildCategoryKeyboard(catId);
    expect(kb).toBeDefined();
    const buttons = kb!.inline_keyboard.flat();
    const commandButtons = buttons.filter((b) => {
      const data = (b as { callback_data?: string }).callback_data || "";
      return data.startsWith("menu_cmd:");
    });
    expect(commandButtons.length).toBeGreaterThan(0);
  });

  it("V4: back button has menu_back callback_data", () => {
    const catId = MENU_CATEGORIES[0].id;
    const kb = buildCategoryKeyboard(catId);
    expect(kb).toBeDefined();
    const lastRow = kb!.inline_keyboard[kb!.inline_keyboard.length - 1];
    const backBtn = lastRow.find((b) => b.text === "Retour");
    expect(backBtn).toBeDefined();
    expect((backBtn as { callback_data?: string }).callback_data).toBe("menu_back");
  });

  it("V4: returns undefined for unknown category", () => {
    expect(buildCategoryKeyboard("nonexistent")).toBeUndefined();
  });

  it("V4: max 5 rows for iOS compatibility", () => {
    for (const cat of MENU_CATEGORIES) {
      const kb = buildCategoryKeyboard(cat.id);
      if (kb) {
        expect(kb.inline_keyboard.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it("V4: all callback_data <= 64 bytes", () => {
    for (const cat of MENU_CATEGORIES) {
      const kb = buildCategoryKeyboard(cat.id);
      if (kb) {
        for (const btn of kb.inline_keyboard.flat()) {
          const data = (btn as { callback_data?: string }).callback_data || "";
          expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
        }
      }
    }
  });
});

// ── V5: buildOnboardingKeyboard ────────────────────────────────

describe("buildOnboardingKeyboard", () => {
  it("V5: returns an InlineKeyboard with discovery buttons", () => {
    const kb = buildOnboardingKeyboard();
    expect(kb).toBeDefined();
    const buttons = kb.inline_keyboard.flat();
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it("V5: includes a button to see the full menu", () => {
    const kb = buildOnboardingKeyboard();
    const buttons = kb.inline_keyboard.flat();
    const texts = buttons.map((b) => b.text);
    expect(
      texts.some((t) => t.toLowerCase().includes("menu") || t.toLowerCase().includes("commandes")),
    ).toBe(true);
  });

  it("V5: includes quick-start buttons (backlog, status)", () => {
    const kb = buildOnboardingKeyboard();
    const allData = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data || "");
    expect(allData.some((d) => d.includes("backlog") || d.includes("status"))).toBe(true);
  });
});

// ── V6: buildBacklogActionKeyboard ─────────────────────────────

describe("buildBacklogActionKeyboard", () => {
  it("V6: returns keyboard with start button for a task", () => {
    const kb = buildBacklogActionKeyboard("abc12345-1234-1234-1234-123456789abc", "Ma tache");
    expect(kb).toBeDefined();
    const buttons = kb.inline_keyboard.flat();
    const texts = buttons.map((b) => b.text);
    expect(
      texts.some((t) => t.toLowerCase().includes("demarrer") || t.toLowerCase().includes("start")),
    ).toBe(true);
  });

  it("V6: uses short task ID in callback_data (<=64 bytes)", () => {
    const kb = buildBacklogActionKeyboard("abc12345-1234-1234-1234-123456789abc", "Ma tache");
    const buttons = kb.inline_keyboard.flat();
    for (const btn of buttons) {
      const data = (btn as { callback_data?: string }).callback_data || "";
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
  });
});

// ── V7: buildQualityNavKeyboard ────────────────────────────────

describe("buildQualityNavKeyboard", () => {
  it("V7: returns keyboard with metrics, retro, alerts buttons", () => {
    const kb = buildQualityNavKeyboard();
    expect(kb).toBeDefined();
    const texts = kb.inline_keyboard.flat().map((b) => b.text);
    expect(
      texts.some(
        (t) => t.toLowerCase().includes("metrique") || t.toLowerCase().includes("metrics"),
      ),
    ).toBe(true);
    expect(texts.some((t) => t.toLowerCase().includes("retro"))).toBe(true);
    expect(
      texts.some((t) => t.toLowerCase().includes("alerte") || t.toLowerCase().includes("alert")),
    ).toBe(true);
  });

  it("V7: callback_data uses menu_cmd: prefix", () => {
    const kb = buildQualityNavKeyboard();
    const buttons = kb.inline_keyboard.flat();
    for (const btn of buttons) {
      const data = (btn as { callback_data?: string }).callback_data || "";
      expect(data.startsWith("menu_cmd:")).toBe(true);
    }
  });
});

// ── V8: buildNotifyPrefsKeyboard ───────────────────────────────

describe("buildNotifyPrefsKeyboard", () => {
  it("V8: returns keyboard with toggle buttons for each notification type", () => {
    const prefs = {
      types: {
        task: { enabled: true, immediate: false },
        pr: { enabled: true, immediate: false },
        idea: { enabled: false, immediate: false },
        alert: { enabled: true, immediate: true },
      },
    };
    const kb = buildNotifyPrefsKeyboard(prefs);
    expect(kb).toBeDefined();
    const texts = kb.inline_keyboard.flat().map((b) => b.text.toLowerCase());
    expect(texts.some((t) => t.includes("task"))).toBe(true);
    expect(texts.some((t) => t.includes("pr"))).toBe(true);
    expect(texts.some((t) => t.includes("idea"))).toBe(true);
    expect(texts.some((t) => t.includes("alert"))).toBe(true);
  });

  it("V8: callback_data uses notify_ prefix", () => {
    const prefs = {
      types: {
        task: { enabled: true, immediate: false },
        pr: { enabled: true, immediate: false },
        idea: { enabled: false, immediate: false },
        alert: { enabled: true, immediate: true },
      },
    };
    const kb = buildNotifyPrefsKeyboard(prefs);
    const buttons = kb.inline_keyboard.flat();
    for (const btn of buttons) {
      const data = (btn as { callback_data?: string }).callback_data || "";
      expect(data.startsWith("notify_")).toBe(true);
    }
  });

  it("V8: all callback_data <= 64 bytes", () => {
    const prefs = {
      types: {
        task: { enabled: true, immediate: false },
        pr: { enabled: true, immediate: false },
        idea: { enabled: false, immediate: false },
        alert: { enabled: true, immediate: true },
      },
    };
    const kb = buildNotifyPrefsKeyboard(prefs);
    for (const btn of kb.inline_keyboard.flat()) {
      const data = (btn as { callback_data?: string }).callback_data || "";
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
  });
});
