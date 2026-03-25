/**
 * @module html-utils
 * @description HTML escaping utilities for Telegram HTML parse_mode.
 * Extracted to avoid circular imports between bot-context and memory sub-modules.
 */

/**
 * Escape special HTML characters for safe interpolation in Telegram HTML messages.
 * Covers text content (&, <, >) and attribute values (", ').
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
