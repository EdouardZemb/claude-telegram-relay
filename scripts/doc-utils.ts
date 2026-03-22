/**
 * @module doc-utils (re-export)
 * @description Backward-compatible re-export from src/doc-utils.ts.
 * The canonical module now lives in src/ to avoid cross-frontier imports.
 * This file preserves CI compatibility (scripts/doc-freshness.ts imports "./doc-utils.ts").
 */
export * from "../src/doc-utils.ts";
