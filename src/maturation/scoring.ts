import { getConfig } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { GateResult } from "./types.ts";

const log = createLogger("maturation/scoring");

const MATURITY_THRESHOLD_DEFAULT = 7;

let _maturityThresholdOverride: number | undefined;

/** @internal — for tests: override threshold without requiring env vars */
export function _setMaturityThresholdForTests(value: number | undefined): void {
  _maturityThresholdOverride = value;
}

function getMaturityThreshold(): number {
  if (_maturityThresholdOverride !== undefined) return _maturityThresholdOverride;
  try {
    return getConfig().maturityThreshold;
  } catch {
    return MATURITY_THRESHOLD_DEFAULT;
  }
}

const MATURITY_RE =
  /(?:score\s*(?:de\s*)?maturit[eé]\s*[:=]?\s*\**|score\s*[:=]\s*\**)(\d+(?:\.\d+)?)\s*\/\s*10/i;
const AMBIGUITY_RE = /ambigu[iïi]t[eé]\s*[:=]?\s*\**(\d+(?:\.\d+)?)\s*\/\s*10/i;
const SHOWSTOPPER_RE = /\*?\*?SHOWSTOPPER\*?\*?\s*[:=]?\s*(.{10,200})/i;

export function extractMaturityScore(text: string): number {
  const match = text.match(MATURITY_RE);
  return match ? parseFloat(match[1]) : 0;
}

export function extractAmbiguityScore(text: string): number {
  const match = text.match(AMBIGUITY_RE);
  return match ? parseFloat(match[1]) : 5;
}

export interface Showstopper {
  reason: string;
}

export function extractShowstopper(text: string): Showstopper | null {
  const match = text.match(SHOWSTOPPER_RE);
  if (!match) return null;
  return { reason: match[1].trim().replace(/\*+/g, "").trim() };
}

export function evaluateGate(
  score: number,
  showstopper: Showstopper | null,
  currentIteration: number,
  maxIterations: number,
): GateResult {
  const issues: string[] = [];

  if (showstopper) {
    issues.push(showstopper.reason);
    return { passed: false, score, issues, recommendation: "human" };
  }

  const threshold = getMaturityThreshold();
  if (score >= threshold) {
    return { passed: true, score, issues, recommendation: "advance" };
  }

  issues.push(`Score ${score}/10 < seuil ${threshold}/10`);

  if (currentIteration < maxIterations) {
    return { passed: false, score, issues, recommendation: "loop" };
  }

  return { passed: false, score, issues, recommendation: "human" };
}
