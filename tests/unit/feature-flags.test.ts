/**
 * Unit Tests — src/feature-flags.ts
 *
 * Tests the feature flags module with in-memory cache and Supabase persistence.
 * These tests verify backward-compatible behavior (synchronous reads)
 * and the new async persistence layer.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REAL_FLAGS = join(import.meta.dir, "..", "..", "config", "features.json");

import {
  _resetForTesting,
  formatFeatures,
  initFeatureFlags,
  isFeatureEnabled,
  listFeatures,
  loadDefaults,
  loadFeatures,
  setFeature,
} from "../../src/feature-flags";

describe("auto_document_search flag (AC-1, AC-2)", () => {
  beforeEach(() => _resetForTesting());
  afterEach(() => _resetForTesting());

  it("exists in config/features.json and isFeatureEnabled reflects current value", () => {
    const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    expect(raw).toHaveProperty("auto_document_search");
    // Without init, isFeatureEnabled falls back to file defaults
    expect(isFeatureEnabled("auto_document_search")).toBe(raw.auto_document_search);
  });
});

describe("sdd_auto_merge flag (AM-FLAG)", () => {
  it("AM-FLAG: sdd_auto_merge exists in config/features.json", () => {
    const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    expect(raw).toHaveProperty("sdd_auto_merge");
    expect(typeof raw.sdd_auto_merge).toBe("boolean");
  });
});

describe("feature-flags", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
  });

  describe("loadDefaults", () => {
    it("loads flags from config file", () => {
      const flags = loadDefaults();
      expect(typeof flags).toBe("object");
      // Should have at least the known production flags
      const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
      expect(flags).toEqual(raw);
    });
  });

  describe("loadFeatures (backward compat)", () => {
    it("returns flags from cache (falls back to file defaults)", () => {
      const flags = loadFeatures();
      const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
      expect(flags).toEqual(raw);
    });
  });

  describe("isFeatureEnabled", () => {
    it("returns true for enabled flag (from defaults)", () => {
      // heartbeat is true in the defaults
      const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
      if (raw.heartbeat === true) {
        expect(isFeatureEnabled("heartbeat")).toBe(true);
      }
    });

    it("returns false for unknown flag", () => {
      expect(isFeatureEnabled("nonexistent_flag")).toBe(false);
    });
  });

  describe("setFeature (without Supabase)", () => {
    it("enables a flag in cache", async () => {
      expect(isFeatureEnabled("test_new_flag")).toBe(false);
      await setFeature("test_new_flag", true);
      expect(isFeatureEnabled("test_new_flag")).toBe(true);
    });

    it("disables a flag in cache", async () => {
      // First load defaults then override
      await setFeature("heartbeat", false);
      expect(isFeatureEnabled("heartbeat")).toBe(false);
    });

    it("creates a new flag", async () => {
      await setFeature("brand_new_flag", true);
      expect(isFeatureEnabled("brand_new_flag")).toBe(true);
    });
  });

  describe("listFeatures", () => {
    it("returns all flags with status", () => {
      const features = listFeatures();
      expect(features.length).toBeGreaterThan(0);
      for (const f of features) {
        expect(typeof f.flag).toBe("string");
        expect(typeof f.enabled).toBe("boolean");
      }
    });
  });

  describe("formatFeatures", () => {
    it("formats flags for display", () => {
      const output = formatFeatures();
      expect(output).toContain("Feature Flags");
      expect(output).toContain("ON");
    });
  });

  describe("initFeatureFlags", () => {
    it("loads from Supabase when available", async () => {
      const mockClient = {
        from: mock(() => ({
          select: mock(() =>
            Promise.resolve({
              data: [
                { flag: "mock_flag", enabled: true },
                { flag: "other_mock", enabled: false },
              ],
              error: null,
            }),
          ),
        })),
      };

      await initFeatureFlags(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        mockClient as any,
      );

      expect(isFeatureEnabled("mock_flag")).toBe(true);
      expect(isFeatureEnabled("other_mock")).toBe(false);
    });

    it("falls back to defaults on Supabase error", async () => {
      const mockClient = {
        from: mock(() => ({
          select: mock(() =>
            Promise.resolve({
              data: null,
              error: { message: "connection refused" },
            }),
          ),
        })),
      };

      await initFeatureFlags(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        mockClient as any,
      );

      // Should have file defaults
      const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
      for (const [flag, enabled] of Object.entries(raw)) {
        expect(isFeatureEnabled(flag)).toBe(enabled as boolean);
      }
    });

    it("falls back to defaults when client is null", async () => {
      await initFeatureFlags(null);

      const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
      for (const [flag, enabled] of Object.entries(raw)) {
        expect(isFeatureEnabled(flag)).toBe(enabled as boolean);
      }
    });
  });
});
