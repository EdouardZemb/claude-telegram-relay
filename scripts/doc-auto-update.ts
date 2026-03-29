/**
 * @module doc-auto-update (CI script)
 * @description CI orchestration for automatic documentation updates.
 *
 * Workflow:
 * 1. Detect which src/ files changed since last commit (anti-recursion gate)
 * 2. Run doc-freshness check to identify stale docs
 * 3. Build tier-stratified update plan
 * 4. For Tier 1 (auto-merge): create branch, update via Claude Code, create PR, auto-merge
 * 5. For Tier 2 (CLAUDE.md): create branch, update via Claude Code, create PR, notify Telegram
 *
 * Anti-recursion triple barrier:
 *   - Only triggers on src/** changes (shouldTriggerUpdate)
 *   - Uses GITHUB_TOKEN (native, no extra secrets needed)
 *   - All commits include [skip actions] suffix
 *
 * Invoked by .github/workflows/doc-update.yml
 */

import { execFileSync, execSync } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  buildBranchName,
  buildDocUpdatePlan,
  SKIP_CI_SUFFIX,
  shouldTriggerUpdate,
  tierLabel,
} from "../src/doc-auto-update.ts";
import {
  extractCommands,
  extractModules,
  findGaps,
  parseClaudeMdCommands,
  parseClaudeMdModules,
  parseClaudeMdTestCount,
} from "./doc-utils.ts";

const ROOT = join(import.meta.dir, "..");

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: opts?.silent ? "pipe" : "inherit",
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return e?.stdout || e?.stderr || e?.message || "";
  }
}

/** Get list of files changed in the last commit */
function getChangedFiles(): string[] {
  try {
    const output = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: ROOT,
      encoding: "utf-8",
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    // First commit or shallow clone — treat as all files changed
    return ["src/"];
  }
}

/** Run doc-freshness check to detect stale docs. Returns list of stale doc paths. */
async function detectStaleDocs(): Promise<string[]> {
  const SRC_DIR = join(ROOT, "src");
  const RELAY_PATH = join(SRC_DIR, "relay.ts");
  const CLAUDE_MD_PATH = join(ROOT, "CLAUDE.md");

  const [srcModules, srcCommands, claudeMdModules, claudeMdCommands, claudeMdContent] =
    await Promise.all([
      extractModules(SRC_DIR),
      extractCommands(RELAY_PATH),
      parseClaudeMdModules(CLAUDE_MD_PATH),
      parseClaudeMdCommands(CLAUDE_MD_PATH),
      readFile(CLAUDE_MD_PATH, "utf-8"),
    ]);

  const claudeMdTestCount = parseClaudeMdTestCount(claudeMdContent);
  const gaps = findGaps({
    srcModules,
    claudeMdModules,
    srcCommands,
    claudeMdCommands,
    actualTestCount: claudeMdTestCount,
    claudeMdTestCount,
  });

  if (gaps.length > 0) {
    console.log(`[doc-auto-update] CLAUDE.md has ${gaps.length} gap(s) — marking as stale`);
    for (const g of gaps) console.log(`  [${g.type}] ${g.detail}`);
    return ["CLAUDE.md"];
  }

  return [];
}

/** Send Telegram notification for Tier 2 PR */
async function notifyTelegram(prUrl: string, docPath: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const userId = process.env.TELEGRAM_USER_ID;
  if (!token || !userId) {
    console.log("[doc-auto-update] No Telegram credentials — skipping notification");
    return;
  }

  // Validate userId is numeric to prevent URL tampering
  if (!/^\d+$/.test(userId)) {
    console.log("[doc-auto-update] Invalid TELEGRAM_USER_ID format — skipping notification");
    return;
  }

  const text = `📄 Doc auto-update (review required)\n\nFichier : ${docPath}\nTier : ${tierLabel(2)}\n\nPR: ${prUrl}\n\nRevue humaine nécessaire avant merge.`;
  try {
    // Use fetch with POST body to avoid token appearing in process cmdline args
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: userId, text, parse_mode: "Markdown" }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log("[doc-auto-update] Telegram notification sent");
  } catch {
    console.log("[doc-auto-update] Telegram notification failed — continuing");
  }
}

async function main(): Promise<void> {
  console.log("[doc-auto-update] Starting documentation update check\n");

  const changedFiles = getChangedFiles();
  console.log(`Changed files: ${changedFiles.join(", ")}`);

  if (!shouldTriggerUpdate(changedFiles)) {
    console.log("[doc-auto-update] No src/ changes detected — skipping (anti-recursion).");
    process.exit(0);
  }

  const staleDocPaths = await detectStaleDocs();
  const plan = buildDocUpdatePlan(changedFiles, staleDocPaths);

  if (!plan.shouldProceed) {
    console.log("[doc-auto-update] All docs up to date — nothing to do.");
    process.exit(0);
  }

  console.log(
    `[doc-auto-update] Update plan: Tier1=${plan.tier1.length}, Tier2=${plan.tier2.length}, Tier3(excluded)=${plan.tier3.length}`,
  );

  // Ensure clean git state before branching
  run("git config user.email 'doc-bot@localhost'", { silent: true });
  run("git config user.name 'Doc Auto-Update Bot'", { silent: true });

  const branchName = buildBranchName();
  run(`git checkout -b ${branchName}`);

  let hasChanges = false;

  // Process Tier 1 + Tier 2 docs via Claude Code agent
  const docsToUpdate = [...plan.tier1, ...plan.tier2];
  for (const doc of docsToUpdate) {
    const tier = plan.tier1.includes(doc) ? 1 : 2;
    console.log(`\n[doc-auto-update] Updating ${doc} (Tier ${tier}: ${tierLabel(tier)})`);

    try {
      // Call Claude Code CLI to update the document
      execSync(
        `claude -p "Update ${doc} to accurately reflect the current state of the codebase. Focus on operational accuracy. Use [skip actions] in any commits." --output-format text`,
        { cwd: ROOT, stdio: "inherit", timeout: 300000 },
      );
    } catch {
      console.log(`[doc-auto-update] Claude Code update for ${doc} skipped or failed — continuing`);
    }

    // Stage and commit any changes
    const diff = run(`git diff --name-only`, { silent: true }).trim();
    if (diff.includes(doc)) {
      run(`git add "${doc}"`);
      run(`git commit -m "docs: auto-update ${doc} ${SKIP_CI_SUFFIX}"`);
      hasChanges = true;
      console.log(`[doc-auto-update] Committed update for ${doc}`);
    } else {
      console.log(`[doc-auto-update] No changes detected for ${doc}`);
    }
  }

  if (!hasChanges) {
    console.log("[doc-auto-update] No actual changes made — cleaning up branch.");
    run("git checkout master", { silent: true });
    run(`git branch -D ${branchName}`, { silent: true });
    process.exit(0);
  }

  // Pre-PR validation: run doc-freshness to ensure format integrity
  console.log("\n[doc-auto-update] Running pre-PR validation (doc-freshness)...");
  try {
    execSync("bun run scripts/doc-freshness.ts", {
      cwd: ROOT,
      stdio: "inherit",
    });
    console.log("[doc-auto-update] Pre-PR validation passed");
  } catch {
    console.error("[doc-auto-update] Pre-PR validation FAILED — aborting PR creation");
    run("git checkout master", { silent: true });
    run(`git branch -D ${branchName}`, { silent: true });
    process.exit(1);
  }

  // Create PR
  const tier2Docs = plan.tier2;
  const isReviewRequired = tier2Docs.length > 0;
  const prTitle = `docs: auto-update ${docsToUpdate.join(", ")} ${SKIP_CI_SUFFIX}`;
  const prBody = [
    "## Documentation Auto-Update",
    "",
    "Triggered by: src/ changes detected",
    "",
    plan.tier1.length > 0 ? `**Tier 1 (auto-merge):** ${plan.tier1.join(", ")}` : null,
    plan.tier2.length > 0 ? `**Tier 2 (review required):** ${plan.tier2.join(", ")}` : null,
    "",
    isReviewRequired
      ? "⚠️ CLAUDE.md modifié — revue humaine requise avant merge."
      : "✅ Tier 1 uniquement — auto-merge en cours.",
  ]
    .filter(Boolean)
    .join("\n");

  let prUrl = "";
  try {
    // Use execFileSync with args array to prevent shell injection via prTitle/prBody
    prUrl = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        prTitle,
        "--body",
        prBody,
        "--base",
        "master",
        "--head",
        branchName,
      ],
      { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    console.log(`[doc-auto-update] PR created: ${prUrl}`);
  } catch {
    console.error("[doc-auto-update] Failed to create PR");
    process.exit(1);
  }

  // Tier 1: auto-merge
  if (plan.tier1.length > 0 && plan.tier2.length === 0) {
    try {
      execFileSync("gh", ["pr", "merge", "--auto", "--merge", prUrl], {
        cwd: ROOT,
        stdio: "pipe",
      });
      console.log("[doc-auto-update] Tier 1 PR queued for auto-merge");
    } catch {
      console.log("[doc-auto-update] Auto-merge failed — PR requires manual attention");
    }
  }

  // Tier 2: Telegram notification
  for (const doc of tier2Docs) {
    await notifyTelegram(prUrl, doc);
  }

  console.log("\n[doc-auto-update] Done.");
}

main().catch((err) => {
  console.error("[doc-auto-update] Fatal error:", err);
  process.exit(1);
});
