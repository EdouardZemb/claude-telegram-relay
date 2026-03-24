/**
 * Tests for SPEC-corriger-les-defauts-du-pipeline-dagents
 *
 * V-criteres:
 * V1  (unit) — runPreCommitValidation returns { passed: false } when typecheck fails
 * V2  (unit) — runPreCommitValidation returns { passed: false } when tests fail
 * V3  (unit) — runPreCommitValidation returns { passed: true } when both pass
 * V4  (unit) — executeTask does NOT git commit when validation fails
 * V5  (unit) — getSprintDelta destructures { data, error } and logs error
 * V6  (unit) — getStaleTasks destructures { data, error } and logs error
 * V7  (unit) — getDevInstructions("exec") contains CLAUDE.md, bun build, bun test
 * V8  (unit) — heartbeat.ts imports from "./doc-utils.ts" not "../scripts/doc-utils.ts"
 * V9  (unit) — scripts/doc-utils.ts re-exports from "../src/doc-utils.ts"
 * V10 (integration) — bun test tests/unit passes without regression
 * V11 (integration) — bun build --no-bundle --target=bun src/*.ts passes
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const SRC_DIR = join(PROJECT_ROOT, "src");

// ── V1: runPreCommitValidation returns { passed: false } when typecheck fails ──

// V-critere: V1
describe("[V1] runPreCommitValidation returns passed:false when typecheck fails", () => {
  test("runPreCommitValidation is exported and callable", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    expect(typeof runPreCommitValidation).toBe("function");
  });

  test("typecheck failure on invalid directory returns passed:false", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    const result = runPreCommitValidation("/tmp/nonexistent-project-dir-xyz");
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("TypeCheck");
  });

  test("error message is truncated to max 2000 chars", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    const result = runPreCommitValidation("/tmp/nonexistent-project-dir-xyz");
    // Each error message should be under 2000 chars + prefix
    for (const err of result.errors) {
      // TypeCheck: <msg> -- msg is max 2000, plus "TypeCheck: " prefix (~11 chars)
      expect(err.length).toBeLessThanOrEqual(2020);
    }
  });
});

// ── V2: runPreCommitValidation returns { passed: false } when tests fail ──

// V-critere: V2
describe("[V2] runPreCommitValidation returns passed:false when tests fail", () => {
  test("test failure on bad test dir returns passed:false with test error", () => {
    const tmpDir = mkdtempSync("/tmp/precommit-v2-");
    try {
      // Create src/ with a valid .ts file so typecheck passes
      mkdirSync(join(tmpDir, "src"));
      writeFileSync(join(tmpDir, "src", "index.ts"), "export const x = 1;");
      // Create tests/unit/ with a failing test
      mkdirSync(join(tmpDir, "tests", "unit"), { recursive: true });
      writeFileSync(
        join(tmpDir, "tests", "unit", "fail.test.ts"),
        'import { test, expect } from "bun:test";\ntest("fail", () => { expect(1).toBe(2); });',
      );

      const { runPreCommitValidation } = require("../../src/agent.ts");
      const result = runPreCommitValidation(tmpDir);
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Tests");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

// ── V3: runPreCommitValidation returns { passed: true } when both pass ──

// V-critere: V3
describe("[V3] runPreCommitValidation returns passed:true when typecheck and tests pass", () => {
  test("valid project returns passed:true with empty errors", () => {
    const tmpDir = mkdtempSync("/tmp/precommit-v3-");
    try {
      mkdirSync(join(tmpDir, "src"));
      writeFileSync(join(tmpDir, "src", "index.ts"), "export const x: number = 1;");
      mkdirSync(join(tmpDir, "tests", "unit"), { recursive: true });
      writeFileSync(
        join(tmpDir, "tests", "unit", "pass.test.ts"),
        'import { test, expect } from "bun:test";\ntest("pass", () => { expect(1).toBe(1); });',
      );

      const { runPreCommitValidation } = require("../../src/agent.ts");
      const result = runPreCommitValidation(tmpDir);
      expect(result.passed).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

// ── V4: executeTask does NOT git commit when validation fails ──

// V-critere: V4
describe("[V4] executeTask does not git commit when runPreCommitValidation fails", () => {
  test("agent.ts contains pre-commit validation check before git commit", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");

    // runPreCommitValidation must be called
    expect(content).toContain("runPreCommitValidation(PROJECT_DIR)");

    // The validation check must appear before git commit
    const validationIdx = content.indexOf("runPreCommitValidation(PROJECT_DIR)");
    const commitIdx = content.indexOf('git("commit"');
    expect(validationIdx).toBeLessThan(commitIdx);

    // If validation fails, return success: false
    expect(content).toContain("Pre-commit validation failed");
  });

  test("executeTask returns success:false pattern on validation failure", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");
    // Check the error message format contains the validation errors
    expect(content).toContain("Pre-commit validation failed");
    expect(content).toContain("validation.errors");
  });
});

// ── V5: getSprintDelta destructures { data, error } and logs error ──

// V-critere: V5
describe("[V5] getSprintDelta handles Supabase errors", () => {
  test("getSprintDelta destructures { data, error } from Supabase", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    const funcStart = content.indexOf("export async function getSprintDelta");
    const nextExport = content.indexOf("\nexport ", funcStart + 1);
    const funcBody = content.substring(
      funcStart,
      nextExport > funcStart ? nextExport : funcStart + 2000,
    );
    expect(funcBody).toContain("{ data: tasks, error }");
  });

  test("getSprintDelta logs error with log.error on Supabase failure", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    const funcStart = content.indexOf("export async function getSprintDelta");
    const nextExport = content.indexOf("\nexport ", funcStart + 1);
    const funcBody = content.substring(
      funcStart,
      nextExport > funcStart ? nextExport : funcStart + 2000,
    );
    expect(funcBody).toContain('log.error("Supabase error in getSprintDelta"');
  });

  test("getSprintDelta returns changed:false on error", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    const funcStart = content.indexOf("export async function getSprintDelta");
    const nextExport = content.indexOf("\nexport ", funcStart + 1);
    const funcBody = content.substring(
      funcStart,
      nextExport > funcStart ? nextExport : funcStart + 2000,
    );
    // When error is detected, it returns changed: false
    expect(funcBody).toContain("changed: false");
  });
});

// ── V6: getStaleTasks destructures { data, error } and logs error ──

// V-critere: V6
describe("[V6] getStaleTasks handles Supabase errors", () => {
  test("getStaleTasks destructures { data, error } from Supabase", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    const funcStart = content.indexOf("export async function getStaleTasks");
    const nextSection = content.indexOf("\n// ", funcStart + 1);
    const funcBody = content.substring(
      funcStart,
      nextSection > funcStart ? nextSection : funcStart + 2000,
    );
    expect(funcBody).toContain("{ data, error }");
  });

  test("getStaleTasks logs error with log.error on Supabase failure", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    const funcStart = content.indexOf("export async function getStaleTasks");
    const nextSection = content.indexOf("\n// ", funcStart + 1);
    const funcBody = content.substring(
      funcStart,
      nextSection > funcStart ? nextSection : funcStart + 2000,
    );
    expect(funcBody).toContain('log.error("Supabase error in getStaleTasks"');
  });

  test("getStaleTasks returns hasStale:false and empty tasks on Supabase error", async () => {
    const { getStaleTasks } = await import("../../src/heartbeat.ts");

    // Create a mock Supabase that returns an error on the query chain
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: null, error: { message: "timeout" } }),
        }),
      }),
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock supabase
    const result = await getStaleTasks(mockSupabase as any);
    expect(result.tasks).toBe("");
    expect(result.hasStale).toBe(false);
  });
});

// V7: bmad-prompts.ts removed (ARCHITECTURE-V2), test removed

// ── V8: heartbeat.ts imports from ./doc-utils.ts ──

// V-critere: V8
describe("[V8] heartbeat.ts imports from ./doc-utils.ts not ../scripts/doc-utils.ts", () => {
  test("no import from ../scripts/doc-utils", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    expect(content).not.toContain("../scripts/doc-utils");
  });

  test("imports from ./doc-utils.ts", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    expect(content).toContain('"./doc-utils.ts"');
  });
});

// ── V9: scripts/doc-utils.ts re-exports from ../src/doc-utils.ts ──

// V-critere: V9
describe("[V9] scripts/doc-utils.ts re-exports from ../src/doc-utils.ts", () => {
  test("contains export * from statement pointing to src/doc-utils", () => {
    const content = readFileSync(join(PROJECT_ROOT, "scripts", "doc-utils.ts"), "utf-8");
    expect(content).toContain("export *");
    expect(content).toContain("../src/doc-utils");
  });

  test("exports are functionally identical to src/doc-utils.ts", async () => {
    const srcExports = await import("../../src/doc-utils.ts");
    const scriptsExports = await import("../../scripts/doc-utils.ts");

    // Compare exported function names
    const srcKeys = Object.keys(srcExports).sort();
    const scriptKeys = Object.keys(scriptsExports).sort();
    expect(scriptKeys).toEqual(srcKeys);
  });

  test("src/doc-utils.ts exists and exports the expected functions", async () => {
    const mod = await import("../../src/doc-utils.ts");
    expect(typeof mod.extractModules).toBe("function");
    expect(typeof mod.extractCommands).toBe("function");
    expect(typeof mod.parseClaudeMdModules).toBe("function");
    expect(typeof mod.parseClaudeMdCommands).toBe("function");
    expect(typeof mod.parseClaudeMdTestCount).toBe("function");
    expect(typeof mod.countTests).toBe("function");
    expect(typeof mod.findGaps).toBe("function");
  });
});

// ── V10: bun test tests/unit passes (integration) ──

// V-critere: V10
describe("[V10] bun test tests/unit passes without regression", () => {
  // Skip: redundant with CI (nested bun test conflicts with parent runner)
  test.skip("all unit tests pass", () => {
    const result = spawnSync([process.execPath, "test", "tests/unit", "--bail"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
      timeout: 120_000,
    });
    // Only check exit code -- output may contain "fail" in log messages
    expect(result.exitCode).toBe(0);
  }, 120_000);
});

// ── V11: typecheck passes (integration) ──

// V-critere: V11
describe("[V11] bun build --no-bundle --target=bun passes on src/", () => {
  test("typecheck passes on project src/ directory", () => {
    const result = spawnSync([process.execPath, "build", "--no-bundle", "--target=bun", "src/"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
      timeout: 30_000,
    });
    expect(result.exitCode).toBe(0);
  }, 30_000);
});

// ── Edge cases and robustness ──

describe("Edge cases — runPreCommitValidation", () => {
  test("defense in profondeur comment exists in agent.ts", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");
    // The spec requires a comment explaining the coexistence of hard gate + soft instructions
    expect(content).toContain("Defense in profondeur");
    expect(content).toContain("gate hard");
    expect(content).toContain("instructions soft");
  });

  test("fail-fast: typecheck runs before tests in runPreCommitValidation", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");
    const funcStart = content.indexOf("export function runPreCommitValidation");
    const funcEnd = content.indexOf("\nfunction ", funcStart + 1);
    const funcBody = content.substring(funcStart, funcEnd > funcStart ? funcEnd : funcStart + 2000);

    // bun build should appear before bun test
    const typecheckIdx = funcBody.indexOf('"build"');
    const testsIdx = funcBody.indexOf('"test"');
    expect(typecheckIdx).toBeGreaterThan(0);
    expect(testsIdx).toBeGreaterThan(0);
    expect(typecheckIdx).toBeLessThan(testsIdx);
  });
});

describe("Edge cases — heartbeat logger migration", () => {
  test("heartbeat.ts has no console.log calls", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    const codeLines = content.split("\n").filter((line: string) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    });
    const consoleCalls = codeLines.filter((line: string) => /\bconsole\.log\b/.test(line));
    expect(consoleCalls).toEqual([]);
  });

  test("heartbeat.ts has no console.error calls", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    const codeLines = content.split("\n").filter((line: string) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    });
    const consoleCalls = codeLines.filter((line: string) => /\bconsole\.error\b/.test(line));
    expect(consoleCalls).toEqual([]);
  });

  test("heartbeat.ts imports createLogger from logger.ts", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    expect(content).toMatch(/import\s*\{\s*createLogger\s*\}\s*from\s*"[^"]*logger\.ts"/);
  });

  test("heartbeat.ts creates a module-scoped logger instance", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    expect(content).toMatch(/const log = createLogger\("heartbeat"\)/);
  });
});
