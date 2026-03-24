/**
 * Coding Standards — Automated structural enforcement
 *
 * Dynamic tests that scan all src/ .ts files to enforce project standards.
 * Complements the soft layer (prompt injection) with hard CI enforcement.
 *
 * S1: No direct console calls (use createLogger)
 * S2: No direct process.env (use getConfig)
 * S3: LOC threshold (800 lines max)
 * S4: Architectural boundaries (services don't import from commands/)
 * S5: Barrel convention (sub-directories have barrel files)
 *
 * See CLAUDE.md section Conventions for the full standards reference.
 */

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";

const SRC_DIR = join(import.meta.dir, "../../src");

// ── Shared helpers (copied from logger-migration.test.ts, not imported) ──

/**
 * Filter code lines: exclude comment lines.
 * Does NOT handle multiline template literals spanning multiple lines —
 * KNOWN_LIMITATION: a `console.log` reference inside a multiline template
 * literal could be a false positive. Accepted as rare/residual risk.
 */
function getCodeLines(content: string): string[] {
  return content.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) return false;
    if (trimmed.startsWith("*")) return false;
    if (trimmed.startsWith("/*")) return false;
    return true;
  });
}

/**
 * Check if a line has a real pattern match outside of string literals.
 * Strips double-quoted, single-quoted, and backtick strings before re-testing.
 */
function hasRealMatch(line: string, pattern: RegExp): boolean {
  if (!pattern.test(line)) return false;
  const withoutStrings = line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return pattern.test(withoutStrings);
}

// ── File discovery ──

function getAllSourceFiles(): string[] {
  const glob = new Glob("**/*.ts");
  const files: string[] = [];
  for (const match of glob.scanSync({ cwd: SRC_DIR, absolute: false })) {
    files.push(match);
  }
  return files.sort();
}

// ── Barrel detection ──

function isBarrelFile(filePath: string): boolean {
  const knownBarrels = ["memory.ts"];
  const base = basename(filePath);
  if (!knownBarrels.includes(base)) return false;
  // Verify it's at src/ root level (not inside a subdirectory)
  return dirname(filePath) === ".";
}

// ── S1: No direct console calls ──────────────────────────────

describe("Coding standards — S1: no direct console calls", () => {
  const CONSOLE_PATTERN = /\bconsole\.(log|error|warn|debug|info|trace)\b/;

  // Exclusions per R6: logger.ts (implements console), barrels, type defs
  const EXCLUDED = new Set(["logger.ts"]);

  const files = getAllSourceFiles().filter((f) => {
    if (f.endsWith(".d.ts")) return false;
    if (EXCLUDED.has(basename(f))) return false;
    if (isBarrelFile(f)) return false;
    return true;
  });

  for (const file of files) {
    it(`${file} has no direct console calls`, () => {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      const codeLines = getCodeLines(content);
      const violations = codeLines.filter((line) => hasRealMatch(line, CONSOLE_PATTERN));
      if (violations.length > 0) {
        expect(violations).toEqual(
          expect.arrayContaining([]),
          // Show the violating lines for debugging
        );
        expect(violations.length).toBe(0);
      }
    });
  }
});

// ── S2: No direct process.env ────────────────────────────────

describe("Coding standards — S2: no direct process.env", () => {
  const PROCESS_ENV_PATTERN = /\bprocess\.env\./;

  // config.ts: IS the config module — legitimate by design
  // logger.ts: uses process.env.NODE_ENV and LOG_LEVEL pre-config initialization
  const EXCLUDED_BY_DESIGN = new Set(["config.ts", "logger.ts"]);

  // Allowlist: files with legitimate pre-config process.env usage.
  // Each entry has a justification. These are legacy usages predating getConfig().
  // New code MUST use getConfig() instead of process.env.
  const ALLOWLIST: Record<string, string> = {
    // Agent execution: PROJECT_DIR/CLAUDE_PATH needed before config is available
    "agent.ts": "PROJECT_DIR, CLAUDE_PATH, GITHUB_REPO — agent spawn pre-config",
    // Infrastructure: environment bootstrap before config
    "heartbeat.ts":
      "PROJECT_DIR, RELAY_DIR, SUPABASE_URL/KEY, HEARTBEAT_DEBUG — standalone process",
    "job-manager.ts": "RELAY_DIR — standalone job persistence directory",
    "notification-queue.ts":
      "RELAY_DIR, TELEGRAM_USER_ID, USER_TIMEZONE, TELEGRAM_GROUP_ID, SPRINT/DEV_THREAD_ID — notification routing",
    "pipeline-tracker.ts": "RELAY_DIR — SDD pipeline persistence directory",
    "bot-context.ts": "HOME, VOICE_PROVIDER, TTS_PROVIDER — runtime provider detection",
    // Code tooling: PROJECT_DIR for filesystem operations
    "code-graph.ts": "PROJECT_DIR — project root for code graph indexing",
    "profile-evolution.ts": "PROJECT_DIR — profile file path",
    "workflow.ts": "PROJECT_DIR — workflow config path",
    // External tools: tool-specific env vars not in config
    "documents.ts": "CLAUDE_PATH — document classification via Claude",
    "transcribe.ts":
      "VOICE_PROVIDER, WHISPER_LANGUAGE, WHISPER_BINARY, WHISPER_MODEL_PATH, TMPDIR — whisper config",
    "tts.ts": "TTS_PROVIDER, GROQ_API_KEY, GROQ_TTS_*, PIPER_*, TMPDIR — TTS provider config",
    // Commands: timezone and thread IDs for user-facing formatting
    "commands/tasks.ts": "SPRINT_THREAD_ID, USER_TIMEZONE — sprint routing and formatting",
    "commands/memory-cmds.ts": "USER_TIMEZONE — timestamp formatting",
    "commands/zz-messages.ts": "VOICE_PROVIDER — voice detection",
    // Memory: timezone for context formatting
    "memory/core.ts": "USER_TIMEZONE — memory timestamp formatting",
    "memory/classification.ts": "USER_TIMEZONE — classification timestamp formatting",
  };

  const files = getAllSourceFiles().filter((f) => {
    if (f.endsWith(".d.ts")) return false;
    if (EXCLUDED_BY_DESIGN.has(basename(f))) return false;
    if (isBarrelFile(f)) return false;
    if (ALLOWLIST[f]) return false;
    return true;
  });

  for (const file of files) {
    it(`${file} has no direct process.env usage`, () => {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      const codeLines = getCodeLines(content);
      const violations = codeLines.filter((line) => hasRealMatch(line, PROCESS_ENV_PATTERN));
      if (violations.length > 0) {
        expect(violations).toEqual(expect.arrayContaining([]));
        expect(violations.length).toBe(0);
      }
    });
  }
});

// ── S3: LOC threshold ────────────────────────────────────────

describe("Coding standards — S3: LOC threshold", () => {
  const MAX_LOC = 800;

  // Temporary allowlist for files currently above threshold.
  // These are tracked for future refactoring — see CLAUDE.md "File size guideline".
  const LOC_ALLOWLIST: Record<string, number> = {
    "workflow.ts": 848,
    "commands/zz-messages.ts": 938,
  };

  const files = getAllSourceFiles().filter((f) => {
    if (f.endsWith(".d.ts")) return false;
    if (isBarrelFile(f)) return false;
    if (LOC_ALLOWLIST[f]) return false;
    return true;
  });

  for (const file of files) {
    it(`${file} is under ${MAX_LOC} LOC`, () => {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      const lines = content.split("\n").length;
      expect(lines).toBeLessThanOrEqual(MAX_LOC);
    });
  }

  // Verify allowlisted files still need the exemption (alert if refactored below threshold)
  for (const [file, expectedLoc] of Object.entries(LOC_ALLOWLIST)) {
    it(`allowlist: ${file} is still above ${MAX_LOC} LOC (expected ~${expectedLoc})`, () => {
      const filePath = join(SRC_DIR, file);
      if (!existsSync(filePath)) return; // file may have been deleted/refactored
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").length;
      // If this fails, the file has been refactored below threshold — remove from allowlist
      expect(lines).toBeGreaterThan(MAX_LOC);
    });
  }
});

// ── S4: Architectural boundaries ─────────────────────────────

describe("Coding standards — S4: architectural boundaries", () => {
  // R8: No service file (src/*.ts) imports from src/commands/
  const IMPORT_COMMANDS_PATTERN = /from\s+['"]\.\/commands\//;
  const IMPORT_COMMANDS_DYNAMIC = /import\(\s*['"]\.\/commands\//;

  // Get only top-level src/*.ts files (not in subdirectories, not in commands/)
  const serviceFiles = getAllSourceFiles().filter((f) => {
    // Only top-level files (no subdirectory)
    if (f.includes("/")) return false;
    if (f.endsWith(".d.ts")) return false;
    return true;
  });

  for (const file of serviceFiles) {
    it(`${file} does not import from commands/`, () => {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      const codeLines = getCodeLines(content);
      const staticViolations = codeLines.filter((line) =>
        hasRealMatch(line, IMPORT_COMMANDS_PATTERN),
      );
      const dynamicViolations = codeLines.filter((line) =>
        hasRealMatch(line, IMPORT_COMMANDS_DYNAMIC),
      );
      expect([...staticViolations, ...dynamicViolations]).toEqual([]);
    });
  }

  // Also check orchestrator/ and memory/ subdirectories
  const subModuleFiles = getAllSourceFiles().filter((f) => {
    if (f.startsWith("commands/")) return false;
    if (!f.includes("/")) return false;
    if (f.endsWith(".d.ts")) return false;
    return true;
  });

  for (const file of subModuleFiles) {
    it(`${file} does not import from commands/`, () => {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      const codeLines = getCodeLines(content);
      const violations = codeLines.filter(
        (line) =>
          hasRealMatch(line, /from\s+['"]\.\.\/commands\//) ||
          hasRealMatch(line, /import\(\s*['"]\.\.\/commands\//),
      );
      expect(violations).toEqual([]);
    });
  }
});

// ── S5: Barrel convention ────────────────────────────────────

describe("Coding standards — S5: barrel convention", () => {
  // Dynamically discover subdirectories of src/ (R5: no static list)
  const entries = readdirSync(SRC_DIR);
  const subDirs = entries.filter((entry) => {
    const fullPath = join(SRC_DIR, entry);
    try {
      return statSync(fullPath).isDirectory() && entry !== "commands";
    } catch {
      return false;
    }
  });

  for (const dir of subDirs) {
    it(`src/${dir}/ has a barrel file at src/${dir}.ts`, () => {
      const barrelPath = join(SRC_DIR, `${dir}.ts`);
      expect(existsSync(barrelPath)).toBe(true);
    });

    it(`src/${dir}.ts is a barrel (re-exports only, no logic)`, () => {
      const barrelPath = join(SRC_DIR, `${dir}.ts`);
      if (!existsSync(barrelPath)) return;
      const content = readFileSync(barrelPath, "utf-8");
      const codeLines = getCodeLines(content);
      // A barrel file should only contain: export/re-export statements, type annotations,
      // empty lines, comments, and multi-line export block contents (identifiers, braces).
      // We verify no function/class/const declarations (logic) exist.
      const logicPatterns = [
        /^(function|class|const|let|var|if|for|while|switch|return|async function)\b/,
      ];
      const nonBarrelLines = codeLines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed === "") return false;
        if (trimmed.startsWith("export ")) return false;
        if (trimmed.startsWith("import ")) return false;
        // Multi-line export block contents: identifiers, type keywords, braces, commas
        if (/^[}\s,]/.test(trimmed)) return false;
        if (/^type\s+\w/.test(trimmed)) return false;
        // Named identifiers inside export { ... } blocks
        if (/^\w+[,]?$/.test(trimmed)) return false;
        // Check for actual logic declarations
        return logicPatterns.some((p) => p.test(trimmed));
      });
      expect(nonBarrelLines).toEqual([]);
    });
  }
});
