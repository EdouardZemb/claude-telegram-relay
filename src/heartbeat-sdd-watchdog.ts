/**
 * @module heartbeat-sdd-watchdog
 * @description SDD pipeline watchdog for heartbeat: detects orphaned/stuck pipeline phases
 * by reading pipelines.json directly (cross-process, read-only).
 *
 * Thresholds:
 * - Agent phases (explore, spec, challenge, review, doc): 30 min
 * - Implementation phase: 60 min (legitimately longer)
 * - Conversational phase (discuss): 24h
 * - Running phase without startedAt: treated as stuck (conservative)
 *
 * Integrated into heartbeat.ts periodic tasks, gated by feature flag `sdd_pipeline_watchdog`.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { createLogger } from "./logger.ts";
import type { PipelineTracker, SddPhase } from "./pipeline-tracker.ts";

const log = createLogger("heartbeat-sdd-watchdog");

// ── Thresholds ──────────────────────────────────────────────

/** 30 min default for agent phases */
const AGENT_THRESHOLD_MS = 30 * 60 * 1000;

/** 60 min for implement phase (can legitimately take longer) */
const IMPLEMENT_THRESHOLD_MS = 60 * 60 * 1000;

/** 24h for discuss phase (conversational, user-driven) */
const DISCUSS_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** 7 days TTL — match pipeline-tracker.ts */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Get the stuck threshold for a given SDD phase.
 * Exported for testing and potential future configuration.
 */
export function getStuckThresholdMs(phase: SddPhase): number {
  switch (phase) {
    case "discuss":
      return DISCUSS_THRESHOLD_MS;
    case "implement":
      return IMPLEMENT_THRESHOLD_MS;
    default:
      return AGENT_THRESHOLD_MS;
  }
}

// ── Result type ─────────────────────────────────────────────

export interface WatchdogResult {
  /** Number of orphaned/stuck pipeline phases detected */
  orphansDetected: number;
  /** Human-readable notification messages for each detected orphan */
  notifications: string[];
}

// ── Core detection ──────────────────────────────────────────

/**
 * Check all SDD pipelines for stuck/orphaned phases.
 * Reads pipelines.json directly from disk (cross-process safe, read-only).
 *
 * @param relayDir - Path to the relay directory containing pipelines.json
 * @returns Detection result with count and notification messages
 */
export async function checkSddPipelines(relayDir: string): Promise<WatchdogResult> {
  const pipelinesFile = join(relayDir, "pipelines.json");
  const now = Date.now();

  // Read and parse pipelines.json (graceful degradation)
  let entries: Array<{ key: string; tracker: PipelineTracker }>;
  try {
    const content = await readFile(pipelinesFile, "utf-8");
    entries = JSON.parse(content);
    if (!Array.isArray(entries)) {
      return { orphansDetected: 0, notifications: [] };
    }
  } catch {
    // R6: optional IO — degrade gracefully (file missing, malformed, etc.)
    return { orphansDetected: 0, notifications: [] };
  }

  const notifications: string[] = [];

  for (const { tracker } of entries) {
    // TTL check — skip expired pipelines (same 7-day TTL as pipeline-tracker.ts)
    if (now - new Date(tracker.updatedAt).getTime() >= TTL_MS) {
      continue;
    }

    // Check each step for stuck "running" status
    const phases = Object.keys(tracker.steps) as SddPhase[];
    for (const phase of phases) {
      const step = tracker.steps[phase];
      if (step.status !== "running") continue;

      const threshold = getStuckThresholdMs(phase);

      // If no startedAt, treat as stuck (conservative — data integrity issue)
      if (!step.startedAt) {
        const msg = `Pipeline « ${tracker.name} » : phase ${phase} en running sans startedAt — potentiellement orpheline`;
        notifications.push(msg);
        log.warn("Stuck pipeline detected (no startedAt)", {
          pipeline: tracker.name,
          phase,
          chatId: tracker.chatId,
        });
        continue;
      }

      const elapsedMs = now - new Date(step.startedAt).getTime();
      if (elapsedMs > threshold) {
        const elapsedMin = Math.round(elapsedMs / (60 * 1000));
        const elapsedDisplay =
          elapsedMin >= 60
            ? `${Math.floor(elapsedMin / 60)}h${elapsedMin % 60 > 0 ? `${elapsedMin % 60}m` : ""}`
            : `${elapsedMin}min`;
        const thresholdMin = Math.round(threshold / (60 * 1000));

        const msg = `Pipeline « ${tracker.name} » : phase ${phase} bloquee depuis ${elapsedDisplay} (seuil: ${thresholdMin}min)`;
        notifications.push(msg);
        log.warn("Stuck pipeline detected", {
          pipeline: tracker.name,
          phase,
          elapsed: elapsedDisplay,
          threshold: thresholdMin,
          chatId: tracker.chatId,
        });
      }
    }
  }

  return {
    orphansDetected: notifications.length,
    notifications,
  };
}
