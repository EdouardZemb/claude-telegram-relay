/**
 * @module doc-freshness.test
 * @description Tests for the doc-freshness CI script behavior.
 * Validates that the freshness check correctly identifies gaps.
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  extractCommands,
  extractModules,
  findGaps,
  parseClaudeMdCommands,
  parseClaudeMdModules,
} from "../../src/doc-utils.ts";

const ROOT = join(import.meta.dir, "../..");
const SRC_DIR = join(ROOT, "src");
const RELAY_PATH = join(SRC_DIR, "relay.ts");
const CLAUDE_MD_PATH = join(ROOT, "CLAUDE.md");

describe("doc-freshness integration", () => {
  test("current repo passes freshness check (modules in sync)", async () => {
    const srcModules = await extractModules(SRC_DIR);
    const claudeMdModules = await parseClaudeMdModules(CLAUDE_MD_PATH);

    const gaps = findGaps({
      srcModules,
      claudeMdModules,
      srcCommands: [],
      claudeMdCommands: [],
      actualTestCount: 0,
      claudeMdTestCount: 0,
    });

    const moduleGaps = gaps.filter((g) => g.type === "missing_module" || g.type === "extra_module");
    expect(moduleGaps).toEqual([]);
  });

  test("current repo passes freshness check (commands in sync)", async () => {
    const srcCommands = await extractCommands(RELAY_PATH);
    const claudeMdCommands = await parseClaudeMdCommands(CLAUDE_MD_PATH);

    const gaps = findGaps({
      srcModules: [],
      claudeMdModules: [],
      srcCommands,
      claudeMdCommands,
      actualTestCount: 0,
      claudeMdTestCount: 0,
    });

    const cmdGaps = gaps.filter((g) => g.type === "missing_command" || g.type === "extra_command");
    expect(cmdGaps).toEqual([]);
  });

  test("V9: scripts/doc-utils.ts re-exports everything from src/doc-utils.ts", async () => {
    const { readFileSync } = require("fs");
    const content = readFileSync(join(ROOT, "scripts", "doc-utils.ts"), "utf-8");

    // Must contain the re-export directive
    expect(content).toContain('export * from "../src/doc-utils.ts"');

    // Verify exports are identical: import from both and compare
    const srcExports = await import("../../src/doc-utils.ts");
    const scriptsExports = await import("../../scripts/doc-utils.ts");

    const srcKeys = Object.keys(srcExports).sort();
    const scriptsKeys = Object.keys(scriptsExports).sort();
    expect(scriptsKeys).toEqual(srcKeys);
  });

  test("whitelist works (no false positives for excluded modules)", async () => {
    const srcModules = await extractModules(SRC_DIR);
    // All modules should be present, none should be whitelisted out incorrectly
    expect(srcModules.length).toBeGreaterThanOrEqual(39);
  });
});
