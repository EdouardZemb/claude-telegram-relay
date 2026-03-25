/**
 * @module prompt-overlay
 * @description Prompt overlay CRUD: dynamic feedback overlays appended to SDD agent
 * system prompts at runtime. Overlays are stored in a local JSON file and never
 * modify the .claude/agents/*.md files. Feature-gated by prompt_feedback_loop.
 *
 * Design: local JSON storage (~/.claude-relay/prompt-overlays.json), max 3 active
 * overlays per agent role, optional TTL (expiresAt), deactivation for rollback.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createLogger } from "./logger.ts";

const log = createLogger("prompt-overlay");

// ── Types ────────────────────────────────────────────────────

export interface PromptOverlay {
  id: string;
  agentRole: string;
  overlayText: string;
  reason: string;
  triggerType: "manual" | "alert" | "metric";
  triggerData?: Record<string, unknown>;
  active: boolean;
  createdAt: string;
  expiresAt?: string;
}

export interface AddOverlayInput {
  agentRole: string;
  overlayText: string;
  reason: string;
  triggerType: "manual" | "alert" | "metric";
  triggerData?: Record<string, unknown>;
  expiresAt?: string;
}

// ── Constants ────────────────────────────────────────────────

const MAX_OVERLAYS_PER_AGENT = 3;

// ── Storage ──────────────────────────────────────────────────

function getStoragePath(): string {
  const relayDir = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
  return join(relayDir, "prompt-overlays.json");
}

/** In-memory cache, loaded on first access. */
let _cache: PromptOverlay[] | null = null;

function loadOverlays(): PromptOverlay[] {
  if (_cache !== null) return _cache;
  try {
    const raw = readFileSync(getStoragePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _cache = parsed;
      return _cache;
    }
  } catch {
    // File missing or corrupt — start fresh
  }
  _cache = [];
  return _cache;
}

function saveOverlays(overlays: PromptOverlay[]): void {
  _cache = overlays;
  const storagePath = getStoragePath();
  try {
    const dir = storagePath.replace(/\/[^/]+$/, "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(storagePath, JSON.stringify(overlays, null, 2) + "\n", "utf-8");
  } catch (err) {
    log.error("Failed to save overlays", { error: String(err) });
  }
}

function generateId(): string {
  return `ov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Get active, non-expired overlays for an agent role.
 */
export function getActiveOverlays(agentRole: string): PromptOverlay[] {
  const overlays = loadOverlays();
  const now = Date.now();
  return overlays.filter((o) => {
    if (!o.active) return false;
    if (o.agentRole !== agentRole) return false;
    if (o.expiresAt && new Date(o.expiresAt).getTime() <= now) return false;
    return true;
  });
}

/**
 * Add a new overlay. Enforces max 3 active overlays per agent role.
 * When the limit is reached, the oldest active overlay for that role is deactivated.
 */
export function addOverlay(input: AddOverlayInput): PromptOverlay {
  const overlays = loadOverlays();

  const overlay: PromptOverlay = {
    id: generateId(),
    agentRole: input.agentRole,
    overlayText: input.overlayText,
    reason: input.reason,
    triggerType: input.triggerType,
    triggerData: input.triggerData,
    active: true,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
  };

  overlays.push(overlay);

  // Enforce max active overlays per agent
  const activeForRole = overlays.filter((o) => o.active && o.agentRole === input.agentRole);
  if (activeForRole.length > MAX_OVERLAYS_PER_AGENT) {
    // Deactivate oldest active overlays for this role until within limit
    const sorted = activeForRole.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const toDeactivate = sorted.slice(0, activeForRole.length - MAX_OVERLAYS_PER_AGENT);
    for (const old of toDeactivate) {
      old.active = false;
    }
  }

  saveOverlays(overlays);
  log.info("Overlay added", {
    id: overlay.id,
    agentRole: overlay.agentRole,
    triggerType: overlay.triggerType,
  });
  return overlay;
}

/**
 * Deactivate an overlay by id. Returns true if found, false otherwise.
 * Idempotent: deactivating an already-inactive or non-existent overlay does not throw.
 */
export function deactivateOverlay(id: string): boolean {
  const overlays = loadOverlays();
  const overlay = overlays.find((o) => o.id === id);
  if (!overlay) return false;
  overlay.active = false;
  saveOverlays(overlays);
  log.info("Overlay deactivated", { id });
  return true;
}

/**
 * List all overlays (including deactivated).
 */
export function listAllOverlays(): PromptOverlay[] {
  return [...loadOverlays()];
}

/**
 * Expire overlays whose expiresAt is in the past.
 * Returns the count of newly expired overlays.
 */
export function expireOverlays(): number {
  const overlays = loadOverlays();
  const now = Date.now();
  let expiredCount = 0;

  for (const o of overlays) {
    if (o.active && o.expiresAt && new Date(o.expiresAt).getTime() <= now) {
      o.active = false;
      expiredCount++;
    }
  }

  if (expiredCount > 0) {
    saveOverlays(overlays);
    log.info("Expired overlays", { count: expiredCount });
  }

  return expiredCount;
}

/**
 * Build an enriched system prompt by concatenating the base prompt with
 * active overlays for the given agent role.
 * Returns the base prompt unchanged if no active overlays exist.
 */
export function buildEnrichedPrompt(agentRole: string, basePrompt: string): string {
  if (!basePrompt) return basePrompt;

  const overlays = getActiveOverlays(agentRole);
  if (overlays.length === 0) return basePrompt;

  const overlaySection = overlays.map((o) => `- ${o.overlayText}`).join("\n");

  return `${basePrompt}\n\n---\nFEEDBACK OVERLAYS (auto-generated, based on recent agent performance):\n${overlaySection}`;
}

// ── Test Helpers ─────────────────────────────────────────────

/** @internal — for tests only: reset in-memory cache */
export function _resetForTests(): void {
  _cache = null;
}
