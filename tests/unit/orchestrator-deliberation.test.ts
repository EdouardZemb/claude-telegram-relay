import { describe, expect, it } from "bun:test";
import { getDeliberationReviewer, shouldDeliberate } from "../../src/deliberation.ts";

describe("orchestrator-deliberation", () => {
  describe("shouldDeliberate", () => {
    it("returns true for architect (reviewed by PM)", () => {
      expect(shouldDeliberate("architect")).toBe(true);
    });

    it("returns true for dev (reviewed by QA)", () => {
      expect(shouldDeliberate("dev")).toBe(true);
    });

    it("returns false for analyst", () => {
      expect(shouldDeliberate("analyst")).toBe(false);
    });

    it("returns false for pm", () => {
      expect(shouldDeliberate("pm")).toBe(false);
    });

    it("returns false for qa", () => {
      expect(shouldDeliberate("qa")).toBe(false);
    });

    it("returns false for sm", () => {
      expect(shouldDeliberate("sm")).toBe(false);
    });
  });

  describe("getDeliberationReviewer", () => {
    it("PM reviews architect", () => {
      expect(getDeliberationReviewer("architect")).toBe("pm");
    });

    it("QA reviews dev", () => {
      expect(getDeliberationReviewer("dev")).toBe("qa");
    });

    it("returns null for non-deliberation roles", () => {
      expect(getDeliberationReviewer("analyst")).toBeNull();
      expect(getDeliberationReviewer("pm")).toBeNull();
      expect(getDeliberationReviewer("qa")).toBeNull();
      expect(getDeliberationReviewer("sm")).toBeNull();
    });
  });
});
