/**
 * @module html-format-helpers
 * @description Shared HTML formatting helpers for Telegram HTML parse_mode.
 * Provides reusable building blocks: section titles, separators, progress bars,
 * key-value lines, status icons, bullet lists, collapsible sections.
 * All functions return strings safe for Telegram's HTML parse_mode.
 */

import { escapeHtml } from "./html-utils.ts";

// ── Section Title ────────────────────────────────────────────

/**
 * Format a section title: bold text with a Unicode separator line below.
 * @param text - The title text (will be HTML-escaped)
 */
export function sectionTitle(text: string): string {
  return `<b>${escapeHtml(text)}</b>\n${separator()}`;
}

// ── Separator ────────────────────────────────────────────────

/**
 * Return a Unicode box-drawing separator line.
 */
export function separator(): string {
  return "─────────────────────";
}

// ── Progress Bar ─────────────────────────────────────────────

/**
 * Render a Unicode progress bar with percentage.
 * @param current - Current progress value
 * @param total - Total value
 * @param width - Bar width in characters (default 10)
 */
export function progressBar(current: number, total: number, width: number = 10): string {
  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const pct = Math.round(ratio * 100);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return `${"█".repeat(filled)}${"░".repeat(empty)} ${pct}%`;
}

// ── Key-Value Line ───────────────────────────────────────────

/**
 * Format a key-value pair: italic key, monospace value.
 * @param key - The label (will be HTML-escaped)
 * @param value - The value (will be HTML-escaped)
 */
export function kvLine(key: string, value: string | number): string {
  return `<i>${escapeHtml(key)}:</i> <code>${escapeHtml(String(value))}</code>`;
}

// ── Status Icon ──────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  ok: "\u2705", // green check
  warning: "\u26A0\uFE0F", // warning triangle
  critical: "\u274C", // red cross
  info: "\u2139\uFE0F", // info
};

/**
 * Return a Unicode status icon for the given severity level.
 */
export function statusIcon(severity: "ok" | "warning" | "critical" | "info"): string {
  return STATUS_ICONS[severity] || STATUS_ICONS.info;
}

// ── Bullet List ──────────────────────────────────────────────

/**
 * Format a list of items with Unicode bullet points.
 * @param items - List items (will be HTML-escaped)
 */
export function bulletList(items: string[]): string {
  if (items.length === 0) return "";
  return items.map((item) => `  \u2022 ${escapeHtml(item)}`).join("\n");
}

// ── Collapsible Section ─────────────────────────────────────

/**
 * Wrap content in a Telegram expandable blockquote.
 * @param title - Section title (will be HTML-escaped)
 * @param content - Pre-formatted HTML content (not escaped)
 */
export function collapsibleSection(title: string, content: string): string {
  return `<blockquote expandable><b>${escapeHtml(title)}</b>\n${content}</blockquote>`;
}
