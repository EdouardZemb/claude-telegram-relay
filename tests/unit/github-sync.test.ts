import { afterEach, describe, expect, it } from "bun:test";
import {
  _ghExecForTests,
  _setGhExecHookForTests,
  addToProject,
  chunkDocument,
  closeIssue,
  commentOnIssue,
  createIssue,
  type EntityMapEntry,
  type GhResult,
  getRunIssue,
  postDocument,
  saveEntity,
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

describe("project board operations", () => {
  afterEach(() => {
    _setGhExecHookForTests(undefined);
  });

  it("V8: addToProject calls gh project item-add and returns item ID", async () => {
    const { _resetConfigForTesting } = await import("../../src/config.ts");
    process.env.GITHUB_PROJECT_NUMBER = "1";
    _resetConfigForTesting();
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "PVTI_abc123", stderr: "", exitCode: 0 };
    });
    const itemId = addToProject("https://github.com/o/r/issues/42");
    delete process.env.GITHUB_PROJECT_NUMBER;
    _resetConfigForTesting();
    expect(itemId).toBe("PVTI_abc123");
    expect(calls[0]).toContain("item-add");
  });

  it("V9: addToProject returns null when no project number configured", () => {
    _setGhExecHookForTests(() => ({
      stdout: "",
      stderr: "no project",
      exitCode: 1,
    }));
    const itemId = addToProject("https://github.com/o/r/issues/42");
    expect(itemId).toBeNull();
  });
});

describe("entity map CRUD", () => {
  it("V10: saveEntity calls supabase upsert on github_entity_map", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
    let upsertedRow: any = null;
    const sb = {
      from: (_table: string) => ({
        // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
        upsert: (row: any) => {
          upsertedRow = row;
          return { data: row, error: null };
        },
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
    await saveEntity(sb as any, {
      run_id: "abc",
      pipeline_type: "maturation",
      entity_type: "run_issue",
      phase: null,
      issue_number: 42,
      issue_url: "https://github.com/o/r/issues/42",
      project_item_id: null,
    });
    expect(upsertedRow).not.toBeNull();
    expect(upsertedRow.run_id).toBe("abc");
    expect(upsertedRow.issue_number).toBe(42);
  });

  it("V11: getRunIssue queries by run_id and entity_type=run_issue", async () => {
    const entry: EntityMapEntry = {
      run_id: "abc",
      pipeline_type: "maturation",
      entity_type: "run_issue",
      phase: null,
      issue_number: 42,
      issue_url: "https://github.com/o/r/issues/42",
      project_item_id: "PVTI_x",
    };
    // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
    const filters: Record<string, any> = {};
    const sb = {
      from: () => ({
        select: () => ({
          // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
          eq: (col: string, val: any) => {
            filters[col] = val;
            return {
              // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
              eq: (col2: string, val2: any) => {
                filters[col2] = val2;
                return {
                  is: () => ({ maybeSingle: () => ({ data: entry, error: null }) }),
                };
              },
            };
          },
        }),
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
    const result = await getRunIssue(sb as any, "abc");
    expect(result).not.toBeNull();
    expect(result!.issue_number).toBe(42);
    expect(filters.run_id).toBe("abc");
    expect(filters.entity_type).toBe("run_issue");
  });
});

describe("document operations", () => {
  afterEach(() => {
    _setGhExecHookForTests(undefined);
  });

  it("V12: chunkDocument returns single chunk for small content", () => {
    const chunks = chunkDocument("Hello world", 60000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Hello world");
  });

  it("V13: chunkDocument splits at line boundary for large content", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i}: ${"x".repeat(40)}`);
    const content = lines.join("\n");
    const chunks = chunkDocument(content, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500 + 100); // tolerance for last line
    }
    expect(chunks.join("\n")).toBe(content);
  });

  it("V14: postDocument posts single comment for small doc", () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const ok = postDocument(42, "UNDERSTANDING", "Small content here");
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const bodyArg = calls[0][calls[0].indexOf("--body") + 1];
    expect(bodyArg).toContain("UNDERSTANDING");
    expect(bodyArg).toContain("Small content here");
  });

  it("V15: postDocument posts multiple comments for large doc", () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const bigContent = "x".repeat(70000);
    const ok = postDocument(42, "SPEC-UNIFIEE", bigContent);
    expect(ok).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  });
});
