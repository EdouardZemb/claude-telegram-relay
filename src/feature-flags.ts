/**
 * @module feature-flags
 * @description Feature flags: minimal file-based toggle system for production features.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { sectionTitle, statusIcon } from "./html-format-helpers.ts";
import { escapeHtml } from "./html-utils.ts";

const FLAGS_FILE = join(import.meta.dir, "..", "config", "features.json");

// ── Core API ──────────────────────────────────────────────────

/**
 * Load all feature flags from config/features.json.
 * Returns empty object if file is missing or invalid.
 */
export function loadFeatures(): Record<string, boolean> {
  try {
    const raw = readFileSync(FLAGS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    // R6: optional IO → degrade gracefully
    return {};
  }
}

/**
 * Check if a feature flag is enabled.
 * Re-reads the file each call for hot-reload (file is tiny, cost negligible).
 * Returns false for unknown flags.
 */
export function isFeatureEnabled(flag: string): boolean {
  const flags = loadFeatures();
  return flags[flag] === true;
}

/**
 * Set a feature flag value and persist to disk.
 */
export function setFeature(flag: string, enabled: boolean): void {
  const flags = loadFeatures();
  flags[flag] = enabled;
  writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2) + "\n", "utf-8");
}

/**
 * List all feature flags with their current status.
 */
export function listFeatures(): Array<{ flag: string; enabled: boolean }> {
  const flags = loadFeatures();
  return Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled }));
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
