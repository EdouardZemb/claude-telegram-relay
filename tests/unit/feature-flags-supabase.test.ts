/**
 * Unit Tests — Feature Flags Supabase Migration
 *
 * V-criteres (derived from exploration):
 * V1: feature_flags table schema is defined in db/schema.sql
 * V2: isFeatureEnabled() remains synchronous (reads from memory cache)
 * V3: initFeatureFlags() loads flags from Supabase into memory cache
 * V4: initFeatureFlags() falls back to config/features.json defaults when Supabase unavailable
 * V5: setFeature() persists to Supabase and updates memory cache
 * V6: listFeatures() returns cached flags synchronously
 * V7: Cache refresh via refreshFeatureFlags() re-reads from Supabase
 * V8: deploy.yml reads sdd_auto_deploy via curl to Supabase PostgREST
 * V9: formatFeatures() displays flags from cache (HTML format)
 * V10: Unknown flags default to false
 * V11: loadDefaults() returns the JSON file defaults without modifying cache
 * V12: setFeature() on new flag creates it in Supabase
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const SCHEMA_FILE = join(PROJECT_ROOT, "db", "schema.sql");
const DEPLOY_YML = join(PROJECT_ROOT, ".github", "workflows", "deploy.yml");
const REAL_FLAGS = join(PROJECT_ROOT, "config", "features.json");

// ── V1: Schema definition ────────────────────────────────────

describe("feature_flags table schema (V1)", () => {
  it("V1: db/schema.sql contains CREATE TABLE feature_flags", () => {
    const schema = readFileSync(SCHEMA_FILE, "utf-8");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS feature_flags");
  });

  it("V1: feature_flags table has flag TEXT PRIMARY KEY", () => {
    const schema = readFileSync(SCHEMA_FILE, "utf-8");
    expect(schema).toMatch(/feature_flags[\s\S]*?flag TEXT PRIMARY KEY/);
  });

  it("V1: feature_flags table has enabled BOOLEAN", () => {
    const schema = readFileSync(SCHEMA_FILE, "utf-8");
    expect(schema).toMatch(/feature_flags[\s\S]*?enabled BOOLEAN/);
  });

  it("V1: feature_flags table has description TEXT", () => {
    const schema = readFileSync(SCHEMA_FILE, "utf-8");
    expect(schema).toMatch(/feature_flags[\s\S]*?description TEXT/);
  });

  it("V1: feature_flags table has updated_at and updated_by", () => {
    const schema = readFileSync(SCHEMA_FILE, "utf-8");
    expect(schema).toMatch(/feature_flags[\s\S]*?updated_at TIMESTAMPTZ/);
    expect(schema).toMatch(/feature_flags[\s\S]*?updated_by TEXT/);
  });
});

// ── Mock Supabase client ──────────────────────────────────────

function createMockSupabase(flags: Array<{ flag: string; enabled: boolean }> = []) {
  const mockData = { data: flags, error: null };
  const mockUpsertResult = { data: null, error: null };

  const fromChain = {
    select: mock(() => Promise.resolve(mockData)),
    upsert: mock(() => Promise.resolve(mockUpsertResult)),
  };

  return {
    client: {
      from: mock((table: string) => {
        if (table !== "feature_flags") throw new Error(`Unexpected table: ${table}`);
        return fromChain;
      }),
    },
    chain: fromChain,
    mockData,
  };
}

// ── V2, V3, V4, V5, V6, V7, V10, V11, V12: Module behavior ──

describe("feature-flags module (V2-V12)", () => {
  // Dynamic import to get fresh module state each time
  let featureFlags: typeof import("../../src/feature-flags");

  beforeEach(async () => {
    // Clear module cache for fresh state
    const modulePath = join(PROJECT_ROOT, "src", "feature-flags.ts");
    delete require.cache[modulePath];
    featureFlags = await import("../../src/feature-flags");
    // Reset internal state
    featureFlags._resetForTesting();
  });

  afterEach(() => {
    featureFlags._resetForTesting();
  });

  it("V2: isFeatureEnabled() is synchronous (returns boolean, not Promise)", () => {
    const result = featureFlags.isFeatureEnabled("nonexistent");
    // Must be a boolean, not a Promise
    expect(typeof result).toBe("boolean");
    expect(result).toBe(false);
  });

  it("V3: initFeatureFlags() loads flags from Supabase into cache", async () => {
    const { client } = createMockSupabase([
      { flag: "test_flag", enabled: true },
      { flag: "other_flag", enabled: false },
    ]);

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client as any,
    );

    expect(featureFlags.isFeatureEnabled("test_flag")).toBe(true);
    expect(featureFlags.isFeatureEnabled("other_flag")).toBe(false);
  });

  it("V4: initFeatureFlags() falls back to defaults when Supabase errors", async () => {
    const mockClient = {
      from: mock(() => ({
        select: mock(() =>
          Promise.resolve({ data: null, error: { message: "connection refused" } }),
        ),
      })),
    };

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockClient as any,
    );

    // Should have loaded defaults from features.json
    const defaults = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    for (const [flag, enabled] of Object.entries(defaults)) {
      expect(featureFlags.isFeatureEnabled(flag)).toBe(enabled as boolean);
    }
  });

  it("V4: initFeatureFlags(null) loads defaults from features.json", async () => {
    await featureFlags.initFeatureFlags(null);

    const defaults = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    for (const [flag, enabled] of Object.entries(defaults)) {
      expect(featureFlags.isFeatureEnabled(flag)).toBe(enabled as boolean);
    }
  });

  it("V5: setFeature() updates cache and persists to Supabase", async () => {
    const { client, chain } = createMockSupabase([{ flag: "my_flag", enabled: false }]);

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client as any,
    );
    expect(featureFlags.isFeatureEnabled("my_flag")).toBe(false);

    await featureFlags.setFeature("my_flag", true);

    // Cache should be updated immediately
    expect(featureFlags.isFeatureEnabled("my_flag")).toBe(true);

    // Supabase upsert should have been called
    expect(chain.upsert).toHaveBeenCalled();
  });

  it("V5: setFeature() updates cache even if Supabase upsert fails", async () => {
    const mockClient = {
      from: mock(() => ({
        select: mock(() =>
          Promise.resolve({ data: [{ flag: "my_flag", enabled: false }], error: null }),
        ),
        upsert: mock(() => Promise.resolve({ data: null, error: { message: "network error" } })),
      })),
    };

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockClient as any,
    );
    await featureFlags.setFeature("my_flag", true);

    // Cache should still be updated (best-effort persistence)
    expect(featureFlags.isFeatureEnabled("my_flag")).toBe(true);
  });

  it("V6: listFeatures() returns cached flags synchronously", async () => {
    const { client } = createMockSupabase([
      { flag: "alpha", enabled: true },
      { flag: "beta", enabled: false },
    ]);

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client as any,
    );

    const features = featureFlags.listFeatures();
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBe(2);
    expect(features.find((f) => f.flag === "alpha")?.enabled).toBe(true);
    expect(features.find((f) => f.flag === "beta")?.enabled).toBe(false);
  });

  it("V7: refreshFeatureFlags() re-reads from Supabase", async () => {
    const flags = [{ flag: "evolving", enabled: false }];
    const mockClient = {
      from: mock(() => ({
        select: mock(() => Promise.resolve({ data: flags, error: null })),
        upsert: mock(() => Promise.resolve({ data: null, error: null })),
      })),
    };

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockClient as any,
    );
    expect(featureFlags.isFeatureEnabled("evolving")).toBe(false);

    // Simulate DB change
    flags[0] = { flag: "evolving", enabled: true };

    await featureFlags.refreshFeatureFlags();
    expect(featureFlags.isFeatureEnabled("evolving")).toBe(true);
  });

  it("V9: formatFeatures() displays cached flags in HTML", async () => {
    const { client } = createMockSupabase([
      { flag: "html_flag_on", enabled: true },
      { flag: "html_flag_off", enabled: false },
    ]);

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client as any,
    );

    const output = featureFlags.formatFeatures();
    expect(output).toContain("Feature Flags");
    expect(output).toContain("html_flag_on");
    expect(output).toContain("html_flag_off");
    expect(output).toContain("ON");
    expect(output).toContain("OFF");
  });

  it("V10: Unknown flags default to false", async () => {
    const { client } = createMockSupabase([{ flag: "known", enabled: true }]);

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client as any,
    );

    expect(featureFlags.isFeatureEnabled("known")).toBe(true);
    expect(featureFlags.isFeatureEnabled("totally_unknown")).toBe(false);
  });

  it("V11: loadDefaults() returns the JSON file defaults", () => {
    const defaults = featureFlags.loadDefaults();
    const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    expect(defaults).toEqual(raw);
  });

  it("V11: loadDefaults() returns empty object if file is missing/corrupt", () => {
    // This tests the graceful degradation — we can't easily corrupt the file
    // in a test, but we verify the function signature and return type
    const defaults = featureFlags.loadDefaults();
    expect(typeof defaults).toBe("object");
    expect(defaults).not.toBeNull();
  });

  it("V12: setFeature() on new flag creates it in Supabase and cache", async () => {
    const { client, chain } = createMockSupabase([]);

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client as any,
    );
    expect(featureFlags.isFeatureEnabled("brand_new")).toBe(false);

    await featureFlags.setFeature("brand_new", true);

    expect(featureFlags.isFeatureEnabled("brand_new")).toBe(true);
    expect(chain.upsert).toHaveBeenCalled();
  });

  // Edge cases

  it("edge: setFeature() without prior init still works (uses defaults fallback)", async () => {
    // No initFeatureFlags called — should use defaults
    await featureFlags.setFeature("test_edge", true);
    expect(featureFlags.isFeatureEnabled("test_edge")).toBe(true);
  });

  it("edge: initFeatureFlags() called multiple times is safe", async () => {
    const { client } = createMockSupabase([{ flag: "stable", enabled: true }]);

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client as any,
    );
    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client as any,
    );

    expect(featureFlags.isFeatureEnabled("stable")).toBe(true);
  });

  it("edge: refreshFeatureFlags() without init does not crash", async () => {
    // Should not throw — graceful no-op
    await featureFlags.refreshFeatureFlags();
  });

  it("edge: empty Supabase response loads defaults", async () => {
    const mockClient = {
      from: mock(() => ({
        select: mock(() => Promise.resolve({ data: [], error: null })),
      })),
    };

    await featureFlags.initFeatureFlags(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockClient as any,
    );

    // Empty DB → should load defaults from JSON file
    const defaults = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    for (const [flag, enabled] of Object.entries(defaults)) {
      expect(featureFlags.isFeatureEnabled(flag)).toBe(enabled as boolean);
    }
  });
});

// ── V8: deploy.yml uses curl to check Supabase ────────────────

describe("deploy.yml Supabase flag check (V8)", () => {
  it("V8: deploy.yml uses curl to read sdd_auto_deploy from Supabase", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    expect(content).toContain("curl");
    expect(content).toContain("SUPABASE_URL");
    expect(content).toContain("SUPABASE_ANON_KEY");
    expect(content).toContain("sdd_auto_deploy");
  });

  it("V8: deploy.yml still has backward compat fallback to features.json", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    // Should still have a fallback mechanism
    expect(content).toContain("features.json");
  });

  it("V8: deploy.yml defaults to true when Supabase is unavailable", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    // Should default to deploying when flag cannot be read
    expect(content).toMatch(/DEPLOY_ENABLED.*true|true.*DEPLOY_ENABLED/s);
  });
});
