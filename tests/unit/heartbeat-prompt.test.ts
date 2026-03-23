/**
 * @file heartbeat-prompt.test.ts
 * @description Dedicated unit tests for src/heartbeat-prompt.ts
 * Tests buildHeartbeatPrompt(), createDefaultState(), HEARTBEAT_SYSTEM_PROMPT — no I/O needed.
 */

import { describe, expect, it } from "bun:test";
import {
  buildHeartbeatPrompt,
  createDefaultState,
  HEARTBEAT_DECISION_SCHEMA,
  HEARTBEAT_SYSTEM_PROMPT,
  type HeartbeatDelta,
  type HeartbeatState,
} from "../../src/heartbeat-prompt.ts";

const defaultState: HeartbeatState = createDefaultState();

const sampleDelta: HeartbeatDelta = {
  timeSinceLastPulse: "10min",
  sprintSummary: "S01: 5/10 done (50%)",
  commits: null,
  ciStatus: null,
  openPRs: null,
  pendingAlerts: null,
  memoryHealth: null,
  workingMemoryStats: null,
  llmOpsStatus: null,
  auditSummary: null,
};

describe("createDefaultState", () => {
  it("returns a HeartbeatState with empty lastPulseAt", () => {
    const state = createDefaultState();
    expect(state.lastPulseAt).toBe("");
  });

  it("returns empty recentActions array", () => {
    const state = createDefaultState();
    expect(Array.isArray(state.recentActions)).toBe(true);
    expect(state.recentActions.length).toBe(0);
  });

  it("returns empty cooldowns object", () => {
    const state = createDefaultState();
    expect(typeof state.cooldowns).toBe("object");
  });

  it("has all required fields", () => {
    const state = createDefaultState();
    expect("lastPulseAt" in state).toBe(true);
    expect("lastCommitSha" in state).toBe(true);
    expect("lastSprintSnapshot" in state).toBe(true);
    expect("recentActions" in state).toBe(true);
    expect("cooldowns" in state).toBe(true);
  });
});

describe("buildHeartbeatPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildHeartbeatPrompt(defaultState, sampleDelta);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes sprint summary in prompt", () => {
    const prompt = buildHeartbeatPrompt(defaultState, sampleDelta);
    expect(prompt).toContain("S01");
  });

  it("includes timestamp/pulsation header", () => {
    const prompt = buildHeartbeatPrompt(defaultState, sampleDelta);
    expect(prompt).toContain("PULSATION");
  });

  it("includes time since last pulse", () => {
    const prompt = buildHeartbeatPrompt(defaultState, sampleDelta);
    expect(prompt).toContain("10min");
  });

  it("includes commits when provided", () => {
    const deltaWithCommits: HeartbeatDelta = {
      ...sampleDelta,
      commits: "abc123 fix: something",
    };
    const prompt = buildHeartbeatPrompt(defaultState, deltaWithCommits);
    expect(prompt).toContain("abc123");
  });

  it("mentions no commits when null", () => {
    const prompt = buildHeartbeatPrompt(defaultState, sampleDelta);
    expect(prompt).toContain("aucun");
  });
});

describe("HEARTBEAT_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof HEARTBEAT_SYSTEM_PROMPT).toBe("string");
    expect(HEARTBEAT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});

describe("HEARTBEAT_DECISION_SCHEMA", () => {
  it("is an object with type field", () => {
    expect(typeof HEARTBEAT_DECISION_SCHEMA).toBe("object");
    expect(HEARTBEAT_DECISION_SCHEMA).not.toBeNull();
  });
});
