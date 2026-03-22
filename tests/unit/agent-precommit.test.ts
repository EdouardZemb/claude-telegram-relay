/**
 * Unit tests for runPreCommitValidation integration in executeTask.
 *
 * Covers:
 * AC-1: validation fails → no git commit, AgentResult.success === false, error detail in output
 * AC-2: validation passes → flow continues normally with git add and git commit
 * AC-3: TypeScript errors → branch not pushed, error reported
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const SRC_DIR = join(PROJECT_ROOT, "src");

// ── runPreCommitValidation behavioral tests ─────────────────────────

describe("AC-1: runPreCommitValidation fails → no commit, success:false, error detail", () => {
  test("nonexistent project dir returns passed:false with TypeCheck error", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    // ENOENT on spawnSync triggers the catch block → TypeCheck error
    const result = runPreCommitValidation("/tmp/nonexistent-dir-precommit-ac1");
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("TypeCheck");
  });

  test("test failure returns passed:false with error detail", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    const tmpDir = mkdtempSync("/tmp/precommit-ac1-tf-");
    try {
      mkdirSync(join(tmpDir, "src"));
      writeFileSync(join(tmpDir, "src", "ok.ts"), "export const x = 1;");
      mkdirSync(join(tmpDir, "tests", "unit"), { recursive: true });
      writeFileSync(
        join(tmpDir, "tests", "unit", "fail.test.ts"),
        'import { test, expect } from "bun:test";\ntest("should fail", () => { expect(true).toBe(false); });',
      );
      const result = runPreCommitValidation(tmpDir);
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Tests");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test("test failure returns passed:false with Tests error detail", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    const tmpDir = mkdtempSync("/tmp/precommit-ac1-test-");
    try {
      mkdirSync(join(tmpDir, "src"));
      writeFileSync(join(tmpDir, "src", "ok.ts"), "export const x = 1;");
      mkdirSync(join(tmpDir, "tests", "unit"), { recursive: true });
      writeFileSync(
        join(tmpDir, "tests", "unit", "fail.test.ts"),
        'import { test, expect } from "bun:test";\ntest("should fail", () => { expect(true).toBe(false); });',
      );
      const result = runPreCommitValidation(tmpDir);
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Tests");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test("executeTask code: validation failure prevents git commit (structural)", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");

    // runPreCommitValidation is called before git commit
    const validationIdx = content.indexOf("runPreCommitValidation(PROJECT_DIR)");
    const commitIdx = content.indexOf('git("commit"');
    expect(validationIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeGreaterThan(0);
    expect(validationIdx).toBeLessThan(commitIdx);

    // When validation fails, function returns before reaching git commit
    const validationBlock = content.substring(validationIdx, commitIdx);
    expect(validationBlock).toContain("!validation.passed");
    expect(validationBlock).toContain("return");
    expect(validationBlock).toContain("success: false");
  });

  test("executeTask code: error detail includes validation.errors joined", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");
    const validationIdx = content.indexOf("runPreCommitValidation(PROJECT_DIR)");
    const commitIdx = content.indexOf('git("commit"');
    const validationBlock = content.substring(validationIdx, commitIdx);

    // The error message includes the validation errors
    expect(validationBlock).toContain("validation.errors.join");
    expect(validationBlock).toContain("Pre-commit validation failed");
  });
});

describe("AC-2: runPreCommitValidation passes → flow continues normally", () => {
  test("valid project returns passed:true with empty errors", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    const tmpDir = mkdtempSync("/tmp/precommit-ac2-");
    try {
      mkdirSync(join(tmpDir, "src"));
      writeFileSync(join(tmpDir, "src", "valid.ts"), "export const value: number = 42;");
      mkdirSync(join(tmpDir, "tests", "unit"), { recursive: true });
      writeFileSync(
        join(tmpDir, "tests", "unit", "pass.test.ts"),
        'import { test, expect } from "bun:test";\ntest("pass", () => { expect(1).toBe(1); });',
      );
      const result = runPreCommitValidation(tmpDir);
      expect(result.passed).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test("executeTask code: git commit follows after validation passes (structural)", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");

    // Find the validation block
    const validationIdx = content.indexOf("runPreCommitValidation(PROJECT_DIR)");
    const commitIdx = content.indexOf('git("commit"');

    // git commit comes after validation — no early return when passed
    expect(commitIdx).toBeGreaterThan(validationIdx);

    // The return for failure is inside an if(!validation.passed) block
    // After that block closes, git commit proceeds
    const afterValidation = content.substring(validationIdx, commitIdx);
    // Verify the conditional only returns when NOT passed
    expect(afterValidation).toContain("if (!validation.passed)");
  });

  test("git add precedes validation which precedes commit (correct ordering)", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");

    const addIdx = content.indexOf('git("add", "-A")');
    const validationIdx = content.indexOf("runPreCommitValidation(PROJECT_DIR)");
    const commitIdx = content.indexOf('git("commit"');

    expect(addIdx).toBeGreaterThan(0);
    expect(validationIdx).toBeGreaterThan(addIdx);
    expect(commitIdx).toBeGreaterThan(validationIdx);
  });
});

describe("AC-3: TypeScript errors → branch not pushed, error reported", () => {
  test("runPreCommitValidation catches TypeScript errors and prevents push path", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    const tmpDir = mkdtempSync("/tmp/precommit-ac3-");
    try {
      mkdirSync(join(tmpDir, "src"));
      // Syntax error that bun build will catch
      writeFileSync(join(tmpDir, "src", "broken.ts"), "export function bad( { return 42; }");
      const result = runPreCommitValidation(tmpDir);
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test("executeTask code: git push only happens after successful commit (structural)", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");

    const commitIdx = content.indexOf('git("commit"');
    const pushIdx = content.indexOf('git("push"');

    // Push comes after commit — if commit never happens (validation fail returns early),
    // push is never reached
    expect(pushIdx).toBeGreaterThan(commitIdx);

    // The validation failure return is between add and commit
    const validationIdx = content.indexOf("runPreCommitValidation(PROJECT_DIR)");
    expect(validationIdx).toBeLessThan(commitIdx);
    expect(validationIdx).toBeLessThan(pushIdx);
  });

  test("executeTask code: validation failure returns success:false with error field", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");

    // Find the validation failure block
    const validationIdx = content.indexOf("!validation.passed");
    expect(validationIdx).toBeGreaterThan(0);

    // Extract the return block after validation failure
    const returnBlock = content.substring(validationIdx, validationIdx + 400);
    expect(returnBlock).toContain("success: false");
    expect(returnBlock).toContain("error:");
    expect(returnBlock).toContain("Pre-commit validation failed");
    expect(returnBlock).toContain("validation.errors");
  });
});

// ── Edge cases ─────────────────────────────────────────────────────

describe("runPreCommitValidation edge cases", () => {
  test("nonexistent directory returns passed:false", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    const result = runPreCommitValidation("/tmp/does-not-exist-at-all-xyz-123");
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("error messages are truncated to 2000 chars max", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    const result = runPreCommitValidation("/tmp/does-not-exist-at-all-xyz-123");
    for (const err of result.errors) {
      // "TypeCheck: " prefix (11 chars) + message (max 2000) = max ~2011
      expect(err.length).toBeLessThanOrEqual(2020);
    }
  });

  test("fail-fast: typecheck failure on missing dir skips test execution", () => {
    const { runPreCommitValidation } = require("../../src/agent.ts");
    // A nonexistent directory triggers ENOENT on spawnSync → caught in catch block
    // Only 1 error: TypeCheck, not Tests (fail-fast)
    const result = runPreCommitValidation("/tmp/nonexistent-precommit-failfast-xyz");
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("TypeCheck");
  });

  test("executeTask returns to master branch on validation failure (structural)", () => {
    const content = readFileSync(join(SRC_DIR, "agent.ts"), "utf-8");
    const validationFailIdx = content.indexOf("!validation.passed");
    const returnAfterFail = content.substring(validationFailIdx, validationFailIdx + 300);
    // Should checkout master before returning
    expect(returnAfterFail).toContain('git("checkout", "master")');
  });
});
