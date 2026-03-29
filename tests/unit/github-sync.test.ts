import { afterEach, describe, expect, it } from "bun:test";
import { _ghExecForTests, _setGhExecHookForTests, type GhResult } from "../../src/github-sync.ts";

describe("github-sync config", () => {
  it("V1: GITHUB_PROJECT_NUMBER defaults to 0", async () => {
    const { getConfig, _resetConfigForTesting } = await import("../../src/config.ts");
    _resetConfigForTesting();
    const cfg = getConfig();
    expect(cfg.githubProjectNumber).toBe(0);
  });
});

describe("github-sync core", () => {
  afterEach(() => {
    _setGhExecHookForTests(undefined);
  });

  describe("ghExec", () => {
    it("V2: uses test hook when set", () => {
      const calls: string[][] = [];
      _setGhExecHookForTests((args) => {
        calls.push(args);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });
      const result: GhResult = _ghExecForTests(["issue", "list"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["issue", "list"]);
      expect(result.stdout).toBe("ok");
    });

    it("V3: returns exitCode from hook", () => {
      _setGhExecHookForTests(() => ({
        stdout: "",
        stderr: "not found",
        exitCode: 1,
      }));
      const result = _ghExecForTests(["issue", "view", "999"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("not found");
    });
  });
});
