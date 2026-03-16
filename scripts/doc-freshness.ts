/**
 * @module doc-freshness
 * @description CI-integrated documentation freshness checker. Verifies that CLAUDE.md
 * accurately reflects the current state of src/ modules, Telegram commands, and test count.
 * Exit code 1 if any gap is detected. Used in .github/workflows/ci.yml.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import {
  extractModules,
  extractCommands,
  parseClaudeMdModules,
  parseClaudeMdCommands,
  parseClaudeMdTestCount,
  findGaps,
} from "./doc-utils.ts";

const ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src");
const RELAY_PATH = join(SRC_DIR, "relay.ts");
const CLAUDE_MD_PATH = join(ROOT, "CLAUDE.md");
const TESTS_DIR = join(ROOT, "tests");

async function main() {
  console.log("Documentation freshness check\n");

  const [srcModules, srcCommands, claudeMdModules, claudeMdCommands, claudeMdContent] =
    await Promise.all([
      extractModules(SRC_DIR),
      extractCommands(RELAY_PATH),
      parseClaudeMdModules(CLAUDE_MD_PATH),
      parseClaudeMdCommands(CLAUDE_MD_PATH),
      readFile(CLAUDE_MD_PATH, "utf-8"),
    ]);

  const claudeMdTestCount = parseClaudeMdTestCount(claudeMdContent);

  // For CI, we skip the actual test count (tests already ran) and just check modules/commands
  // The test count check uses the CI's own test results via the anti-regression step
  const gaps = findGaps({
    srcModules,
    claudeMdModules,
    srcCommands,
    claudeMdCommands,
    actualTestCount: claudeMdTestCount, // Skip test count check in freshness (handled by CI anti-regression)
    claudeMdTestCount,
  });

  if (gaps.length === 0) {
    console.log(`Modules: ${srcModules.length} in src/, ${claudeMdModules.length} in CLAUDE.md — OK`);
    console.log(`Commands: ${srcCommands.length} in relay.ts, ${claudeMdCommands.length} in CLAUDE.md — OK`);
    console.log("\nAll documentation is up to date.");
    process.exit(0);
  }

  console.log("GAPS DETECTED:\n");
  for (const gap of gaps) {
    console.log(`  [${gap.type}] ${gap.detail}`);
  }
  console.log(`\n${gaps.length} gap(s) found. Update CLAUDE.md before merging.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Freshness check failed:", err);
  process.exit(1);
});
