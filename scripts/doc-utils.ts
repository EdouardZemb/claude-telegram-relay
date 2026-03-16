/**
 * @module doc-utils
 * @description Shared parsing utilities for documentation freshness checks and maintenance.
 * Used by doc-freshness.ts and doc-check.ts.
 */

import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";

/** Modules to exclude from freshness checks (internal utilities) */
const WHITELIST: string[] = [];

export interface DocState {
  srcModules: string[];
  claudeMdModules: string[];
  srcCommands: string[];
  claudeMdCommands: string[];
  actualTestCount: number;
  claudeMdTestCount: number;
}

export interface DocGap {
  type: "missing_module" | "missing_command" | "extra_module" | "extra_command" | "test_count";
  item: string;
  detail: string;
}

/**
 * Extract all TypeScript module names from src/ directory.
 */
export async function extractModules(srcDir: string): Promise<string[]> {
  const files = await readdir(srcDir);
  return files
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !WHITELIST.includes(f))
    .map((f) => f)
    .sort();
}

/**
 * Extract all bot.command() registrations from relay.ts.
 */
export async function extractCommands(relayPath: string): Promise<string[]> {
  const content = await readFile(relayPath, "utf-8");
  const regex = /bot\.command\(["'](\w+)["']/g;
  const commands: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    commands.push(`/${match[1]}`);
  }
  return commands.sort();
}

/**
 * Parse CLAUDE.md to extract documented module names from the Source Modules table.
 */
export async function parseClaudeMdModules(claudeMdPath: string): Promise<string[]> {
  const content = await readFile(claudeMdPath, "utf-8");
  const regex = /\| `([^`]+\.ts)` \|/g;
  const modules: string[] = [];
  let match;
  // Only match in the Source Modules section
  const modulesSection = content.split("### Source Modules")[1]?.split("###")[0] || "";
  const sectionRegex = /\| `([^`]+\.ts)` \|/g;
  while ((match = sectionRegex.exec(modulesSection)) !== null) {
    modules.push(match[1]);
  }
  return modules.sort();
}

/**
 * Parse CLAUDE.md to extract documented command names from the Telegram Commands table.
 */
export async function parseClaudeMdCommands(claudeMdPath: string): Promise<string[]> {
  const content = await readFile(claudeMdPath, "utf-8");
  const commandsSection = content.split("### Telegram Commands")[1]?.split("###")[0] || "";
  const regex = /\| `(\/\w+)/g;
  const commands: string[] = [];
  let match;
  while ((match = regex.exec(commandsSection)) !== null) {
    commands.push(match[1]);
  }
  return commands.sort();
}

/**
 * Count actual tests by running bun test --dry-run or by parsing test files.
 * Returns the count from test file analysis.
 */
export async function countTests(testsDir: string): Promise<number> {
  const { execSync } = await import("child_process");
  try {
    const result = execSync("bun test 2>&1", {
      cwd: join(testsDir, ".."),
      timeout: 120000,
      encoding: "utf-8",
    });
    const passMatch = result.match(/(\d+) pass/);
    return passMatch ? parseInt(passMatch[1], 10) : 0;
  } catch (e: any) {
    // bun test exits non-zero if tests fail, but output still has counts
    const output = e.stdout || e.stderr || "";
    const passMatch = output.match(/(\d+) pass/);
    return passMatch ? parseInt(passMatch[1], 10) : 0;
  }
}

/**
 * Parse the test count mentioned in CLAUDE.md.
 * Looks for patterns like "640 tests" or "640 pass" in the Conventions section.
 */
export function parseClaudeMdTestCount(content: string): number {
  // Look for "N tests" in the conventions section
  const conventionsSection = content.split("### Conventions")[1]?.split("---")[0] || "";
  const match = conventionsSection.match(/(\d+)\s*tests/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Parse the module count mentioned in CLAUDE.md Project Structure.
 */
export function parseClaudeMdModuleCount(content: string): number {
  const match = content.match(/(\d+)\s*TypeScript modules/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Compare actual state vs documented state and return gaps.
 */
export function findGaps(state: DocState): DocGap[] {
  const gaps: DocGap[] = [];

  // Modules in src/ but not in CLAUDE.md
  for (const mod of state.srcModules) {
    if (!state.claudeMdModules.includes(mod)) {
      gaps.push({
        type: "missing_module",
        item: mod,
        detail: `Module src/${mod} exists but is not documented in CLAUDE.md`,
      });
    }
  }

  // Modules in CLAUDE.md but not in src/
  for (const mod of state.claudeMdModules) {
    if (!state.srcModules.includes(mod)) {
      gaps.push({
        type: "extra_module",
        item: mod,
        detail: `Module src/${mod} documented in CLAUDE.md but does not exist`,
      });
    }
  }

  // Commands in relay.ts but not in CLAUDE.md
  for (const cmd of state.srcCommands) {
    if (!state.claudeMdCommands.includes(cmd)) {
      gaps.push({
        type: "missing_command",
        item: cmd,
        detail: `Command ${cmd} registered in relay.ts but not documented in CLAUDE.md`,
      });
    }
  }

  // Commands in CLAUDE.md but not in relay.ts
  for (const cmd of state.claudeMdCommands) {
    if (!state.srcCommands.includes(cmd)) {
      gaps.push({
        type: "extra_command",
        item: cmd,
        detail: `Command ${cmd} documented in CLAUDE.md but not registered in relay.ts`,
      });
    }
  }

  // Test count drift (tolerance: ±10)
  const testDiff = Math.abs(state.actualTestCount - state.claudeMdTestCount);
  if (testDiff > 10) {
    gaps.push({
      type: "test_count",
      item: `${state.actualTestCount} vs ${state.claudeMdTestCount}`,
      detail: `Actual test count (${state.actualTestCount}) differs from CLAUDE.md (${state.claudeMdTestCount}) by ${testDiff}`,
    });
  }

  return gaps;
}
