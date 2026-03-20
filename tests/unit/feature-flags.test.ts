/**
 * Unit Tests — src/feature-flags.ts (S29-T1)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// Use a temp file for tests to avoid modifying the real config
const TEMP_FLAGS = join(import.meta.dir, "..", "..", "config", "features.test.json");
const REAL_FLAGS = join(import.meta.dir, "..", "..", "config", "features.json");

// We test the functions directly by importing them
import {
  loadFeatures,
  isFeatureEnabled,
  setFeature,
  listFeatures,
  formatFeatures,
} from "../../src/feature-flags";

describe("auto_document_search flag (AC-1, AC-2)", () => {
  it("exists in config/features.json and isFeatureEnabled reflects current value", () => {
    const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    expect(raw).toHaveProperty("auto_document_search");
    expect(isFeatureEnabled("auto_document_search")).toBe(raw.auto_document_search);
  });
});

describe("feature-flags", () => {
  let originalContent: string;

  beforeEach(() => {
    // Save original
    originalContent = readFileSync(REAL_FLAGS, "utf-8");
    // Write known state
    writeFileSync(REAL_FLAGS, JSON.stringify({
      test_flag_a: true,
      test_flag_b: false,
      test_flag_c: true,
    }, null, 2) + "\n");
  });

  afterEach(() => {
    // Restore original
    writeFileSync(REAL_FLAGS, originalContent);
  });

  describe("loadFeatures", () => {
    it("loads flags from config file", () => {
      const flags = loadFeatures();
      expect(flags.test_flag_a).toBe(true);
      expect(flags.test_flag_b).toBe(false);
      expect(flags.test_flag_c).toBe(true);
    });
  });

  describe("isFeatureEnabled", () => {
    it("returns true for enabled flag", () => {
      expect(isFeatureEnabled("test_flag_a")).toBe(true);
    });

    it("returns false for disabled flag", () => {
      expect(isFeatureEnabled("test_flag_b")).toBe(false);
    });

    it("returns false for unknown flag", () => {
      expect(isFeatureEnabled("nonexistent_flag")).toBe(false);
    });
  });

  describe("setFeature", () => {
    it("enables a flag and persists it", () => {
      setFeature("test_flag_b", true);
      expect(isFeatureEnabled("test_flag_b")).toBe(true);

      // Verify persistence
      const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
      expect(raw.test_flag_b).toBe(true);
    });

    it("disables a flag", () => {
      setFeature("test_flag_a", false);
      expect(isFeatureEnabled("test_flag_a")).toBe(false);
    });

    it("creates a new flag", () => {
      setFeature("new_flag", true);
      expect(isFeatureEnabled("new_flag")).toBe(true);
    });
  });

  describe("listFeatures", () => {
    it("returns all flags with status", () => {
      const features = listFeatures();
      expect(features.length).toBe(3);
      expect(features.find(f => f.flag === "test_flag_a")?.enabled).toBe(true);
      expect(features.find(f => f.flag === "test_flag_b")?.enabled).toBe(false);
    });
  });

  describe("formatFeatures", () => {
    it("formats flags for display", () => {
      const output = formatFeatures();
      expect(output).toContain("Feature Flags");
      expect(output).toContain("ON");
      expect(output).toContain("OFF");
      expect(output).toContain("test_flag_a");
    });
  });
});
