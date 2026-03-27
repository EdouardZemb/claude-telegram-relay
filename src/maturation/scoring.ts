import type { GateResult } from "./types.ts";

const MATURITY_THRESHOLD = 7;

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

  if (score >= MATURITY_THRESHOLD) {
    return { passed: true, score, issues, recommendation: "advance" };
  }

  issues.push(`Score ${score}/10 < seuil ${MATURITY_THRESHOLD}/10`);

  if (currentIteration < maxIterations) {
    return { passed: false, score, issues, recommendation: "loop" };
  }

  return { passed: false, score, issues, recommendation: "human" };
}
