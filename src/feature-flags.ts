/**
 * @module feature-flags
 * @description Feature flags with Supabase persistence and in-memory cache.
 *
 * Architecture:
 * - Primary store: Supabase `feature_flags` table
 * - Memory cache: Map<string, boolean> loaded at boot, refreshed periodically
 * - Fallback: config/features.json (defaults when DB unavailable)
 * - isFeatureEnabled() remains SYNCHRONOUS (reads from cache)
 * - setFeature() is ASYNC (persists to Supabase, updates cache immediately)
 *
 * Migration from file-based system:
 * - config/features.json is kept as default values (never modified at runtime)
 * - All runtime reads/writes go through Supabase via the memory cache
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { sectionTitle, statusIcon } from "./html-format-helpers.ts";
import { escapeHtml } from "./html-utils.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("feature-flags");

const FLAGS_FILE = join(import.meta.dir, "..", "config", "features.json");

// ── In-memory cache ──────────────────────────────────────────

/** In-memory cache of feature flags. Loaded at boot, refreshed periodically. */
let _cache: Map<string, boolean> = new Map();

/** Reference to the Supabase client, set via initFeatureFlags(). */
let _supabase: SupabaseClient | null = null;

/** Whether initFeatureFlags() has been called. */
let _initialized = false;

// ── Defaults from file ───────────────────────────────────────

/**
 * Load default flag values from config/features.json.
 * Returns empty object if file is missing or invalid.
 * This file is the source of truth for DEFAULT values only —
 * runtime state is stored in Supabase.
 */
export function loadDefaults(): Record<string, boolean> {
  try {
    const raw = readFileSync(FLAGS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    // R6: optional IO — degrade gracefully
    return {};
  }
}

// ── Initialization ───────────────────────────────────────────

/**
 * Initialize the feature flags system.
 * Loads flags from Supabase into the memory cache.
 * Falls back to config/features.json defaults if Supabase is unavailable.
 *
 * @param supabase - Supabase client (null for file-only fallback mode)
 */
export async function initFeatureFlags(supabase: SupabaseClient | null): Promise<void> {
  _supabase = supabase;
  _initialized = true;

  if (!supabase) {
    log.info("No Supabase client — loading defaults from file");
    _loadDefaultsIntoCache();
    return;
  }

  try {
    const { data, error } = await supabase.from("feature_flags").select("flag, enabled");

    if (error) {
      log.warn("Supabase error loading flags, using defaults", { error: error.message });
      _loadDefaultsIntoCache();
      return;
    }

    if (!data || data.length === 0) {
      log.info("No flags in Supabase, loading defaults from file");
      _loadDefaultsIntoCache();
      return;
    }

    // Populate cache from DB
    _cache = new Map();
    for (const row of data) {
      _cache.set(row.flag, row.enabled);
    }

    log.info(`Loaded ${data.length} feature flags from Supabase`);
  } catch (err) {
    log.error("Failed to load flags from Supabase, using defaults", { error: String(err) });
    _loadDefaultsIntoCache();
  }
}

/**
 * Refresh the in-memory cache from Supabase.
 * No-op if no Supabase client is configured.
 */
export async function refreshFeatureFlags(): Promise<void> {
  if (!_supabase) return;

  try {
    const { data, error } = await _supabase.from("feature_flags").select("flag, enabled");

    if (error) {
      log.warn("Refresh failed, keeping current cache", { error: error.message });
      return;
    }

    if (data && data.length > 0) {
      _cache = new Map();
      for (const row of data) {
        _cache.set(row.flag, row.enabled);
      }
      log.debug(`Refreshed ${data.length} feature flags from Supabase`);
    }
  } catch (err) {
    log.warn("Refresh exception, keeping current cache", { error: String(err) });
  }
}

// ── Core API ─────────────────────────────────────────────────

/**
 * Check if a feature flag is enabled.
 * SYNCHRONOUS — reads from the in-memory cache.
 * Returns false for unknown flags.
 *
 * If initFeatureFlags() has not been called, loads defaults from file.
 */
export function isFeatureEnabled(flag: string): boolean {
  if (!_initialized) {
    _loadDefaultsIntoCache();
    _initialized = true;
  }
  return _cache.get(flag) === true;
}

/**
 * Set a feature flag value.
 * Updates the in-memory cache immediately and persists to Supabase asynchronously.
 * If Supabase is unavailable, the cache is still updated (best-effort persistence).
 */
export async function setFeature(flag: string, enabled: boolean): Promise<void> {
  if (!_initialized) {
    _loadDefaultsIntoCache();
    _initialized = true;
  }

  // Update cache immediately
  _cache.set(flag, enabled);

  // Persist to Supabase (best-effort)
  if (_supabase) {
    try {
      const { error } = await _supabase.from("feature_flags").upsert({
        flag,
        enabled,
        updated_at: new Date().toISOString(),
        updated_by: "bot",
      });

      if (error) {
        log.error("Failed to persist flag to Supabase", { flag, error: error.message });
      } else {
        log.info(`Feature flag ${flag} set to ${enabled} (persisted)`);
      }
    } catch (err) {
      log.error("Exception persisting flag to Supabase", { flag, error: String(err) });
    }
  } else {
    log.warn(`Feature flag ${flag} set to ${enabled} (cache only, no Supabase)`);
  }
}

/**
 * List all feature flags with their current status.
 * SYNCHRONOUS — reads from the in-memory cache.
 */
export function listFeatures(): Array<{ flag: string; enabled: boolean }> {
  if (!_initialized) {
    _loadDefaultsIntoCache();
    _initialized = true;
  }
  return Array.from(_cache.entries()).map(([flag, enabled]) => ({ flag, enabled }));
}

/**
 * Format feature flags for Telegram display (HTML formatting via sendResponseHtml).
 */
export function formatFeatures(): string {
  const features = listFeatures();
  if (features.length === 0) return "Aucun feature flag configure.";

  const lines = [sectionTitle("Feature Flags"), ""];
  for (const { flag, enabled } of features) {
    const icon = enabled ? statusIcon("ok") : statusIcon("critical");
    const label = enabled ? "ON" : "OFF";
    lines.push(`${icon} <code>${escapeHtml(flag)}</code>  ${label}`);
  }
  return lines.join("\n");
}

// ── Backward compatibility ───────────────────────────────────

/**
 * @deprecated Use isFeatureEnabled() instead. Kept for backward compatibility.
 * Load all feature flags. Returns the cache contents as a plain object.
 */
export function loadFeatures(): Record<string, boolean> {
  if (!_initialized) {
    _loadDefaultsIntoCache();
    _initialized = true;
  }
  return Object.fromEntries(_cache);
}

// ── Internal helpers ─────────────────────────────────────────

function _loadDefaultsIntoCache(): void {
  const defaults = loadDefaults();
  _cache = new Map(Object.entries(defaults));
}

// ── Test utilities ───────────────────────────────────────────

/**
 * Reset internal state for testing.
 * FOR TESTING ONLY.
 */
export function _resetForTesting(): void {
  _cache = new Map();
  _supabase = null;
  _initialized = false;
}
