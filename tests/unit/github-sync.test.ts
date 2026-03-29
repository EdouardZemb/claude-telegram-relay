import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  _ghExecForTests,
  _resetEnsuredLabelsForTests,
  _setGhExecHookForTests,
  _setSyncEnabledForTests,
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
  syncPhaseComplete,
  syncRunComplete,
  syncRunStart,
} from "../../src/github-sync.ts";

// CI does not have TELEGRAM_BOT_TOKEN etc. — ensure getConfig() works
const savedEnv: Record<string, string | undefined> = {};
const ciEnv: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_USER_ID: "123",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "test-key",
};

beforeAll(async () => {
  for (const key of Object.keys(ciEnv)) {
    savedEnv[key] = process.env[key];
    if (!process.env[key]) process.env[key] = ciEnv[key];
  }
  const { _resetConfigForTesting } = await import("../../src/config.ts");
  _resetConfigForTesting();
});

afterAll(async () => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  const { _resetConfigForTesting } = await import("../../src/config.ts");
  _resetConfigForTesting();
});

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
    it("V2: uses test hook when set", async () => {
      const calls: string[][] = [];
      _setGhExecHookForTests((args) => {
        calls.push(args);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });
      const result: GhResult = await _ghExecForTests(["issue", "list"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["issue", "list"]);
      expect(result.stdout).toBe("ok");
    });

    it("V3: returns exitCode from hook", async () => {
      _setGhExecHookForTests(() => ({
        stdout: "",
        stderr: "not found",
        exitCode: 1,
      }));
      const result = await _ghExecForTests(["issue", "view", "999"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("not found");
    });
  });
});

describe("issue operations", () => {
  afterEach(() => {
    _setGhExecHookForTests(undefined);
    _resetEnsuredLabelsForTests();
  });

  it("V4: createIssue parses issue number and URL from gh output", async () => {
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
    const result = await createIssue("Test Issue", "Body text", ["label1"]);
    expect(result).not.toBeNull();
    expect(result!.number).toBe(42);
    expect(result!.url).toContain("/issues/42");
  });

  it("V5: createIssue returns null on gh failure", async () => {
    _setGhExecHookForTests(() => ({
      stdout: "",
      stderr: "error",
      exitCode: 1,
    }));
    const result = await createIssue("Fail", "Body", []);
    expect(result).toBeNull();
  });

  it("V6: commentOnIssue sends body to gh issue comment", async () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const ok = await commentOnIssue(42, "Hello world");
    expect(ok).toBe(true);
    expect(calls[0]).toContain("comment");
    expect(calls[0]).toContain("42");
  });

  it("V7: closeIssue calls gh issue close", async () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const ok = await closeIssue(42);
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
    const itemId = await addToProject("https://github.com/o/r/issues/42");
    delete process.env.GITHUB_PROJECT_NUMBER;
    _resetConfigForTesting();
    expect(itemId).toBe("PVTI_abc123");
    expect(calls[0]).toContain("item-add");
  });

  it("V9: addToProject returns null when no project number configured", async () => {
    _setGhExecHookForTests(() => ({
      stdout: "",
      stderr: "no project",
      exitCode: 1,
    }));
    const itemId = await addToProject("https://github.com/o/r/issues/42");
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

  it("V14: postDocument posts single comment for small doc", async () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const ok = await postDocument(42, "UNDERSTANDING", "Small content here");
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const bodyArg = calls[0][calls[0].indexOf("--body") + 1];
    expect(bodyArg).toContain("UNDERSTANDING");
    expect(bodyArg).toContain("Small content here");
  });

  it("V15: postDocument posts multiple comments for large doc", async () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const bigContent = "x".repeat(70000);
    const ok = await postDocument(42, "SPEC-UNIFIEE", bigContent);
    expect(ok).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe("high-level sync API", () => {
  afterEach(() => {
    _setGhExecHookForTests(undefined);
    _setSyncEnabledForTests(undefined);
    _resetEnsuredLabelsForTests();
  });

  const makeMockSupabase = () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
    const saved: any[] = [];
    return {
      sb: {
        from: () => ({
          // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
          upsert: (row: any) => {
            saved.push(row);
            return { data: row, error: null };
          },
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({ maybeSingle: () => ({ data: null, error: null }) }),
                eq: () => ({ maybeSingle: () => ({ data: null, error: null }) }),
              }),
            }),
          }),
        }),
      },
      saved,
    };
  };

  it("V16: syncRunStart creates parent issue and saves entity", async () => {
    _setSyncEnabledForTests(true);
    const ghCalls: string[][] = [];
    _setGhExecHookForTests((args) => {
      ghCalls.push(args);
      if (args[1] === "create") {
        return { stdout: "https://github.com/o/r/issues/10", stderr: "", exitCode: 0 };
      }
      if (args[1] === "item-add") {
        return { stdout: "PVTI_123", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const { sb, saved } = makeMockSupabase();
    await syncRunStart(
      // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
      sb as any,
      {
        id: "run-1",
        name: "test-run",
        rawInput: "Build something",
      },
      "maturation",
    );

    expect(ghCalls.some((c) => c[1] === "create")).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[0].run_id).toBe("run-1");
    expect(saved[0].issue_number).toBe(10);
  });

  it("V17: syncPhaseComplete creates sub-issue and posts documents", async () => {
    _setSyncEnabledForTests(true);
    const ghCalls: string[][] = [];
    _setGhExecHookForTests((args) => {
      ghCalls.push(args);
      if (args[1] === "create") {
        return { stdout: "https://github.com/o/r/issues/11", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    // Mock: parent issue exists
    // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
    const saved: any[] = [];
    const sb = {
      from: () => ({
        // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
        upsert: (row: any) => {
          saved.push(row);
          return { data: row, error: null };
        },
        select: () => ({
          // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
          eq: (_col: string, _val: any) => ({
            // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
            eq: (_col2: string, _val2: any) => ({
              is: () => ({
                maybeSingle: () => ({
                  data: {
                    run_id: "run-1",
                    issue_number: 10,
                    issue_url: "https://github.com/o/r/issues/10",
                  },
                  error: null,
                }),
              }),
              eq: () => ({
                maybeSingle: () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      }),
    };

    await syncPhaseComplete(
      // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
      sb as any,
      "run-1",
      "understand",
      "maturation",
      ["Doc content"],
      "ambiguity:4",
    );

    const creates = ghCalls.filter((c) => c[1] === "create");
    expect(creates.length).toBeGreaterThanOrEqual(1);
    const comments = ghCalls.filter((c) => c[1] === "comment");
    expect(comments.length).toBeGreaterThanOrEqual(1);
  });

  it("V18: syncRunComplete closes the parent issue", async () => {
    _setSyncEnabledForTests(true);
    const ghCalls: string[][] = [];
    _setGhExecHookForTests((args) => {
      ghCalls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: () => ({
                  data: { run_id: "run-1", issue_number: 10 },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
    await syncRunComplete(sb as any, "run-1", "done");
    const closes = ghCalls.filter((c) => c[1] === "close");
    expect(closes).toHaveLength(1);
  });
});

describe("maturation integration", () => {
  it("V19: syncPhaseComplete accepts all required params and returns Promise", async () => {
    const { syncPhaseComplete: fn } = await import("../../src/github-sync.ts");
    expect(typeof fn).toBe("function");
    // Verify it returns a Promise (async function)
    _setSyncEnabledForTests(false);
    const result = fn(
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock for type check
      {} as any,
      "run-id",
      "phase",
      "maturation",
      [],
    );
    expect(result).toBeInstanceOf(Promise);
    await result;
    _setSyncEnabledForTests(undefined);
  });
});

describe("label resilience", () => {
  afterEach(() => {
    _setGhExecHookForTests(undefined);
    _resetEnsuredLabelsForTests();
  });

  it("V21: createIssue ensures labels exist before creating issue", async () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      if (args[0] === "label" && args[1] === "create") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "issue" && args[1] === "create") {
        return {
          stdout: "https://github.com/o/r/issues/50",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await createIssue("Test", "Body", ["maturation", "pipeline-sync"]);
    expect(result).not.toBeNull();
    expect(result!.number).toBe(50);

    const labelCalls = calls.filter((c) => c[0] === "label" && c[1] === "create");
    expect(labelCalls).toHaveLength(2);
    expect(labelCalls.some((c) => c.includes("maturation"))).toBe(true);
    expect(labelCalls.some((c) => c.includes("pipeline-sync"))).toBe(true);
  });

  it("V22: createIssue retries without labels if first attempt fails", async () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      if (args[0] === "label") {
        return { stdout: "", stderr: "permission denied", exitCode: 1 };
      }
      if (args[0] === "issue" && args[1] === "create") {
        const hasLabels = args.includes("--label");
        if (hasLabels) {
          return { stdout: "", stderr: "label 'xyz' not found", exitCode: 1 };
        }
        return {
          stdout: "https://github.com/o/r/issues/51",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await createIssue("Fallback test", "Body", ["xyz"]);
    expect(result).not.toBeNull();
    expect(result!.number).toBe(51);

    const issueCalls = calls.filter((c) => c[0] === "issue" && c[1] === "create");
    expect(issueCalls).toHaveLength(2); // first with labels, second without
  });

  it("V23: ensured labels are cached — second call skips gh label create", async () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      if (args[0] === "label") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "issue" && args[1] === "create") {
        return { stdout: "https://github.com/o/r/issues/52", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    await createIssue("First", "Body", ["cached-label"]);
    const firstLabelCalls = calls.filter((c) => c[0] === "label").length;
    expect(firstLabelCalls).toBe(1);

    calls.length = 0;
    await createIssue("Second", "Body", ["cached-label"]);
    const secondLabelCalls = calls.filter((c) => c[0] === "label").length;
    expect(secondLabelCalls).toBe(0); // cached, no gh call
  });

  it("V24: createIssue with no labels skips ensureLabel entirely", async () => {
    const calls: string[][] = [];
    _setGhExecHookForTests((args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "create") {
        return { stdout: "https://github.com/o/r/issues/53", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await createIssue("No labels", "Body", []);
    expect(result).not.toBeNull();
    expect(calls.filter((c) => c[0] === "label")).toHaveLength(0);
  });
});

describe("V3 pipeline integration", () => {
  afterEach(() => {
    _setGhExecHookForTests(undefined);
    _setSyncEnabledForTests(undefined);
    _resetEnsuredLabelsForTests();
  });

  it("V20: syncPhaseComplete works with v3 pipeline_type", async () => {
    _setSyncEnabledForTests(true);
    const ghCalls: string[][] = [];
    _setGhExecHookForTests((args) => {
      ghCalls.push(args);
      if (args[1] === "create") {
        return { stdout: "https://github.com/o/r/issues/20", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const sb = {
      from: () => ({
        // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
        upsert: (row: any) => ({ data: row, error: null }),
        select: () => ({
          eq: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: () => ({
                  data: {
                    run_id: "v3-1",
                    issue_number: 15,
                    issue_url: "https://github.com/o/r/issues/15",
                  },
                  error: null,
                }),
              }),
              eq: () => ({ maybeSingle: () => ({ data: null, error: null }) }),
            }),
          }),
        }),
      }),
    };
    await syncPhaseComplete(
      // biome-ignore lint/suspicious/noExplicitAny: mock supabase object for testing
      sb as any,
      "v3-1",
      "review",
      "v3",
      ["Panel verdict: APPROVED"],
      "APPROVED",
    );
    expect(ghCalls.some((c) => c[1] === "create")).toBe(true);
  });
});
