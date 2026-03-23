/**
 * @file deliberation.test.ts
 * @description Dedicated unit tests for src/deliberation.ts
 * Tests shouldDeliberate(), getDeliberationReviewer() — no agent spawn needed.
 * DELIBERATION_PAIRS: { architect: "pm", dev: "qa" }
 */

import { describe, expect, it } from "bun:test";
import { getDeliberationReviewer, shouldDeliberate } from "../../src/deliberation.ts";

describe("shouldDeliberate", () => {
  it("returns true for architect (has deliberation pair)", () => {
    expect(shouldDeliberate("architect")).toBe(true);
  });

  it("returns true for dev (has deliberation pair)", () => {
    expect(shouldDeliberate("dev")).toBe(true);
  });

  it("returns false for analyst (no deliberation pair)", () => {
    expect(shouldDeliberate("analyst")).toBe(false);
  });

  it("returns false for pm (no deliberation pair)", () => {
    expect(shouldDeliberate("pm")).toBe(false);
  });

  it("returns false for qa (no deliberation pair)", () => {
    expect(shouldDeliberate("qa")).toBe(false);
  });

  it("returns false for unknown role", () => {
    expect(shouldDeliberate("unknown_role" as never)).toBe(false);
  });
});

describe("getDeliberationReviewer", () => {
  it("returns 'pm' for architect", () => {
    const reviewer = getDeliberationReviewer("architect");
    expect(reviewer).toBe("pm");
  });

  it("returns 'qa' for dev", () => {
    const reviewer = getDeliberationReviewer("dev");
    expect(reviewer).toBe("qa");
  });

  it("returns null for analyst (no deliberation pair)", () => {
    const reviewer = getDeliberationReviewer("analyst");
    expect(reviewer).toBeNull();
  });

  it("returns null for pm (no deliberation pair)", () => {
    const reviewer = getDeliberationReviewer("pm");
    expect(reviewer).toBeNull();
  });

  it("returns null for qa (no deliberation pair)", () => {
    const reviewer = getDeliberationReviewer("qa");
    expect(reviewer).toBeNull();
  });

  it("reviewer is a different role than the agent (architect -> pm)", () => {
    const reviewer = getDeliberationReviewer("architect");
    expect(reviewer).not.toBe("architect");
    expect(reviewer).toBe("pm");
  });
});
