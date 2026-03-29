import { afterEach, describe, expect, it } from "bun:test";
import {
  _ghExecForTests,
  _setGhExecHookForTests,
  closeIssue,
  commentOnIssue,
  createIssue,
  type GhResult,
} from "../../src/github-sync.ts";

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

describe("issue operations", () => {
  afterEach(() => {
    _setGhExecHookForTests(undefined);
  });

  it("V4: createIssue parses issue number and URL from gh output", () => {
    _setGhExecHookForTests((args) => {
      if (args[0] === "issue" && args[1] === "create") {
        return {
          stdout: "https://github.com/EdouardZemb/claude-telegram-relay/issues/42",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });
    const result = createIssue("Test Issue", "Body text", ["label1"]);
    expect(result).not.toBeNull();
    expect(result!.number).toBe(42);
    expect(result!.url).toContain("/issues/42");
  });

  it("V5: createIssue returns null on gh failure", () => {
    _setGhExecHookForTests(() => ({
      stdout: "",
      stderr: "error",
      exitCode: 1,
    }));
    const result = createIssue("Fail", "Body", []);
    expect(result).toBeNull();
  });

  it("V6: commentOnIssue sends body to gh issue comment", () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const ok = commentOnIssue(42, "Hello world");
    expect(ok).toBe(true);
    expect(calls[0]).toContain("comment");
    expect(calls[0]).toContain("42");
  });

  it("V7: closeIssue calls gh issue close", () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const ok = closeIssue(42);
    expect(ok).toBe(true);
    expect(calls[0]).toContain("close");
  });
});
