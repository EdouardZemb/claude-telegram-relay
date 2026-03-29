import { describe, expect, it } from "bun:test";

describe("github-sync config", () => {
  it("V1: GITHUB_PROJECT_NUMBER defaults to 0", async () => {
    const { getConfig, _resetConfigForTesting } = await import("../../src/config.ts");
    _resetConfigForTesting();
    const cfg = getConfig();
    expect(cfg.githubProjectNumber).toBe(0);
  });
});
