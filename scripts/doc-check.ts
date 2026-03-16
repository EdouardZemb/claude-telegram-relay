/**
 * @module doc-check
 * @description Interactive documentation maintenance tool. Compares current code state
 * against CLAUDE.md and proposes specific text to add for each gap found.
 * Run with: bun run doc:check
 */

import { readFile } from "fs/promises";
import { join } from "path";
import {
  extractModules,
  extractCommands,
  parseClaudeMdModules,
  parseClaudeMdCommands,
  parseClaudeMdTestCount,
  parseClaudeMdModuleCount,
  countTests,
  findGaps,
  type DocGap,
} from "./doc-utils.ts";

const ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src");
const RELAY_PATH = join(SRC_DIR, "relay.ts");
const CLAUDE_MD_PATH = join(ROOT, "CLAUDE.md");
const TESTS_DIR = join(ROOT, "tests");

function proposeFix(gap: DocGap): string {
  switch (gap.type) {
    case "missing_module":
      return `Add to Source Modules table in CLAUDE.md:\n  | \`${gap.item}\` | TODO: add description |`;
    case "extra_module":
      return `Remove from Source Modules table in CLAUDE.md:\n  | \`${gap.item}\` | ... |`;
    case "missing_command":
      return `Add to Telegram Commands table in CLAUDE.md:\n  | \`${gap.item}\` | TODO: add description |`;
    case "extra_command":
      return `Remove from Telegram Commands table in CLAUDE.md:\n  | \`${gap.item}\` | ... |`;
    case "test_count":
      return `Update test count in CLAUDE.md Conventions section to match actual count: ${gap.item.split(" vs ")[0]}`;
    default:
      return "Manual review required";
  }
}

async function main() {
  console.log("Documentation Check — Comparing code vs CLAUDE.md\n");
  console.log("=".repeat(60) + "\n");

  const [srcModules, srcCommands, claudeMdModules, claudeMdCommands, claudeMdContent] =
    await Promise.all([
      extractModules(SRC_DIR),
      extractCommands(RELAY_PATH),
      parseClaudeMdModules(CLAUDE_MD_PATH),
      parseClaudeMdCommands(CLAUDE_MD_PATH),
      readFile(CLAUDE_MD_PATH, "utf-8"),
    ]);

  const claudeMdTestCount = parseClaudeMdTestCount(claudeMdContent);
  const claudeMdModuleCount = parseClaudeMdModuleCount(claudeMdContent);

  // Run actual test count (this takes time)
  console.log("Running tests to get actual count...");
  const actualTestCount = await countTests(TESTS_DIR);
  console.log(`Actual test count: ${actualTestCount}\n`);

  console.log("SUMMARY");
  console.log("-".repeat(60));
  console.log(`Modules in src/:          ${srcModules.length}`);
  console.log(`Modules in CLAUDE.md:     ${claudeMdModules.length}`);
  console.log(`Module count in text:     ${claudeMdModuleCount}`);
  console.log(`Commands in relay.ts:     ${srcCommands.length}`);
  console.log(`Commands in CLAUDE.md:    ${claudeMdCommands.length}`);
  console.log(`Actual test count:        ${actualTestCount}`);
  console.log(`CLAUDE.md test count:     ${claudeMdTestCount}`);
  console.log("-".repeat(60) + "\n");

  const gaps = findGaps({
    srcModules,
    claudeMdModules,
    srcCommands,
    claudeMdCommands,
    actualTestCount,
    claudeMdTestCount,
  });

  if (gaps.length === 0) {
    console.log("No gaps found. Documentation is up to date!");
    return;
  }

  console.log(`${gaps.length} GAP(S) FOUND:\n`);

  for (const gap of gaps) {
    console.log(`[${gap.type.toUpperCase()}] ${gap.detail}`);
    console.log(`  Fix: ${proposeFix(gap)}`);
    console.log("");
  }

  // Check module count in Project Structure section
  if (claudeMdModuleCount !== srcModules.length) {
    console.log(`[MODULE_COUNT] Project Structure says "${claudeMdModuleCount} TypeScript modules" but there are ${srcModules.length}`);
    console.log(`  Fix: Update "src/    ${claudeMdModuleCount} TypeScript modules" to "src/    ${srcModules.length} TypeScript modules" in CLAUDE.md\n`);
  }
}

main().catch((err) => {
  console.error("Doc check failed:", err);
  process.exit(1);
});
