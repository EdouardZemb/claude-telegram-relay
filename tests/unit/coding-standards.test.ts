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
 * S6: createLogger mandatory (all non-barrel, non-type-only files)
 * S7: No circular imports (DFS cycle detection on import graph)
 * S9: process.env allowlist size cap (S2 allowlist must not grow unbounded)
 *
 * S8 (per-file coverage threshold) is enforced via scripts/check-coverage.sh in CI.
 *
 * See CLAUDE.md section Conventions for the full standards reference.
 */

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, normalize } from "path";

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
    // Infrastructure: environment bootstrap before config
    "heartbeat.ts":
      "PROJECT_DIR, RELAY_DIR, SUPABASE_URL/KEY, HEARTBEAT_DEBUG — standalone process",
    "job-manager.ts": "RELAY_DIR — standalone job persistence directory",
    "notification-queue.ts":
      "RELAY_DIR, TELEGRAM_USER_ID, USER_TIMEZONE, TELEGRAM_GROUP_ID, SPRINT/DEV_THREAD_ID — notification routing",
    "pipeline-tracker.ts": "RELAY_DIR — SDD pipeline persistence directory",
    "bot-context.ts": "HOME, VOICE_PROVIDER, TTS_PROVIDER — runtime provider detection",
    // External tools: tool-specific env vars not in config
    "transcribe.ts":
      "VOICE_PROVIDER, WHISPER_LANGUAGE, WHISPER_BINARY, WHISPER_MODEL_PATH, TMPDIR — whisper config",
    "tts.ts": "TTS_PROVIDER, GROQ_API_KEY, GROQ_TTS_*, PIPER_*, TMPDIR — TTS provider config",
    // Commands: timezone and thread IDs for user-facing formatting
    "commands/memory-cmds.ts": "USER_TIMEZONE — timestamp formatting",
    "commands/zz-messages.ts": "VOICE_PROVIDER — voice detection",
    // Memory: timezone for context formatting
    "memory/core.ts": "USER_TIMEZONE — memory timestamp formatting",
    "memory/classification.ts": "USER_TIMEZONE — classification timestamp formatting",
    // SDD agents: GITHUB_REPO for gh CLI calls (consistent with agent.ts pattern)
    "sdd-agents.ts":
      "GITHUB_REPO — GitHub CLI pr review call (no full config needed in agent context)",
    // Prompt overlay: RELAY_DIR + HOME for JSON storage path (same pattern as job-manager)
    "prompt-overlay.ts": "RELAY_DIR, HOME — prompt overlay JSON storage directory",
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
  const LOC_ALLOWLIST: Record<string, number> = {};

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

// ── S6: createLogger mandatory ────────────────────────────────

describe("Coding standards — S6: createLogger mandatory", () => {
  const CREATE_LOGGER_PATTERN = /createLogger/;

  // Files excluded from the createLogger requirement:
  // - logger.ts: implements createLogger itself
  // - result.ts: pure types, no side-effects
  // - config.ts: types + config singleton, no logging needed
  // - semaphore.ts: generic utility, no side-effects needing logging
  // - Barrels: re-exports only
  // - .d.ts: type declarations
  const EXCLUDED = new Set(["logger.ts", "result.ts", "config.ts", "semaphore.ts"]);

  // Files that are declarative/data-only or thin wrappers without internal logging needs.
  // Each entry has a justification. If a file gains runtime logic, remove it from this list.
  const TYPES_ONLY_ALLOWLIST: Record<string, string> = {
    // Declarative/data-only modules
    "action-registry.ts": "Declarative registry of command metadata — no runtime logic",
    "topic-config.ts": "Declarative topic configuration — no runtime logic",
    "heartbeat-prompt.ts": "Prompt builder returning strings — no side-effects",
    "doc-utils.ts": "Pure parsing utilities — no side-effects needing logging",
    "inline-menus.ts":
      "Pure keyboard builder functions from registry data — no side-effects needing logging",
    // Pure functions querying Supabase — errors handled by caller
    "alerts.ts":
      "Pure async functions returning Alert[] — no internal side-effects needing logging",
    // Pure string formatting utilities — no side-effects needing logging
    "html-utils.ts": "Pure escapeHtml function — no runtime logic or side-effects",
    "html-format-helpers.ts": "Pure HTML formatting helpers — no side-effects needing logging",
    // Command composers: thin wrappers delegating to logged modules via bctx
    "commands/jobs.ts": "Thin Composer delegating to job-manager.ts — logging in dependency",
    "commands/profile.ts":
      "Thin Composer delegating to notification-queue.ts — logging in dependency",
    "commands/project.ts": "Thin Composer delegating to projects.ts — logging in dependency",
    "commands/tasks.ts": "Thin Composer delegating to tasks.ts — logging in dependency",
  };

  const files = getAllSourceFiles().filter((f) => {
    if (f.endsWith(".d.ts")) return false;
    if (EXCLUDED.has(basename(f))) return false;
    if (isBarrelFile(f)) return false;
    if (TYPES_ONLY_ALLOWLIST[f]) return false;
    return true;
  });

  for (const file of files) {
    it(`${file} uses createLogger`, () => {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      const hasLogger = CREATE_LOGGER_PATTERN.test(content);
      if (!hasLogger) {
        // Provide a helpful error message
        expect(hasLogger).toBe(
          true,
          // `${file} must import or call createLogger (see S6 standard)`
        );
      }
    });
  }

  // Verify allowlisted files are still data/types-only (no createLogger = no runtime logic)
  for (const [file, reason] of Object.entries(TYPES_ONLY_ALLOWLIST)) {
    it(`S6 allowlist: ${file} is still types/data-only (${reason})`, () => {
      const filePath = join(SRC_DIR, file);
      if (!existsSync(filePath)) return; // file may have been deleted
      const content = readFileSync(filePath, "utf-8");
      // If the file now uses createLogger, it has runtime logic and should be removed from the allowlist
      expect(CREATE_LOGGER_PATTERN.test(content)).toBe(false);
    });
  }
});

// ── S7: No circular imports ───────────────────────────────────

describe("Coding standards — S7: no circular imports", () => {
  /**
   * Resolve an import specifier relative to the importing file.
   * Handles: ./foo -> foo.ts or foo/index.ts
   */
  function resolveImport(fromFile: string, importPath: string): string | null {
    const fromDir = dirname(fromFile);
    let resolved = normalize(join(fromDir, importPath));

    // Strip .ts/.js extension for normalization, then re-add .ts
    if (resolved.endsWith(".ts")) return resolved;
    if (resolved.endsWith(".js")) {
      resolved = resolved.replace(/\.js$/, "");
    }

    // Try direct .ts
    if (existsSync(join(SRC_DIR, resolved + ".ts"))) {
      return resolved + ".ts";
    }
    // Try index.ts (directory import)
    if (existsSync(join(SRC_DIR, resolved, "index.ts"))) {
      return normalize(join(resolved, "index.ts"));
    }
    // File doesn't exist in src/ — external or non-existent, skip
    return null;
  }

  /**
   * Build the import graph: file -> list of resolved imports within src/
   */
  function buildImportGraph(): Map<string, string[]> {
    const files = getAllSourceFiles().filter((f) => !f.endsWith(".d.ts"));
    const fileSet = new Set(files);
    const graph = new Map<string, string[]>();

    for (const file of files) {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      const codeLines = getCodeLines(content);
      const imports: string[] = [];

      for (const line of codeLines) {
        // Reset regex lastIndex for each line
        const re = /(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const resolved = resolveImport(file, m[1]);
          if (resolved && fileSet.has(resolved) && resolved !== file) {
            imports.push(resolved);
          }
        }
      }

      graph.set(file, [...new Set(imports)]); // deduplicate
    }

    return graph;
  }

  /**
   * DFS cycle detection. Returns all cycles found as arrays of file paths.
   */
  function findCycles(graph: Map<string, string[]>): string[][] {
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const color = new Map<string, number>();
    const parent = new Map<string, string>();
    const cycles: string[][] = [];

    for (const node of graph.keys()) color.set(node, WHITE);

    function dfs(u: string): void {
      color.set(u, GRAY);
      for (const v of graph.get(u) || []) {
        if (color.get(v) === GRAY) {
          // Found cycle — reconstruct path
          const cycle = [v, u];
          let cur = parent.get(u);
          while (cur && cur !== v) {
            cycle.push(cur);
            cur = parent.get(cur);
          }
          cycle.push(v);
          cycles.push(cycle.reverse());
        } else if (color.get(v) === WHITE) {
          parent.set(v, u);
          dfs(v);
        }
      }
      color.set(u, BLACK);
    }

    for (const node of graph.keys()) {
      if (color.get(node) === WHITE) {
        dfs(node);
      }
    }

    return cycles;
  }

  it("import graph has no cycles", () => {
    const graph = buildImportGraph();
    const cycles = findCycles(graph);

    if (cycles.length > 0) {
      const _cycleDescriptions = cycles.map((cycle) => cycle.join(" -> ")).join("\n  ");
      expect(cycles.length).toBe(
        0,
        // `Circular imports detected:\n  ${_cycleDescriptions}`
      );
    }
  });

  it("import graph has nodes (sanity check)", () => {
    const graph = buildImportGraph();
    // We expect at least 40 source files
    expect(graph.size).toBeGreaterThanOrEqual(40);
  });

  it("import graph has edges (sanity check)", () => {
    const graph = buildImportGraph();
    let totalEdges = 0;
    for (const deps of graph.values()) {
      totalEdges += deps.length;
    }
    // We expect at least 50 import edges across the codebase
    expect(totalEdges).toBeGreaterThanOrEqual(50);
  });

  // V4: Robustness test — verify the DFS algorithm detects cycles on a mock graph
  it("findCycles detects A -> B -> A cycle in mock graph", () => {
    const mockGraph = new Map<string, string[]>();
    mockGraph.set("a.ts", ["b.ts"]);
    mockGraph.set("b.ts", ["a.ts"]);
    const cycles = findCycles(mockGraph);
    expect(cycles.length).toBeGreaterThan(0);
    // Verify the cycle contains both nodes
    const cycleNodes = new Set(cycles[0]);
    expect(cycleNodes.has("a.ts")).toBe(true);
    expect(cycleNodes.has("b.ts")).toBe(true);
  });

  it("findCycles detects A -> B -> C -> A cycle in mock graph", () => {
    const mockGraph = new Map<string, string[]>();
    mockGraph.set("a.ts", ["b.ts"]);
    mockGraph.set("b.ts", ["c.ts"]);
    mockGraph.set("c.ts", ["a.ts"]);
    const cycles = findCycles(mockGraph);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("findCycles returns empty for acyclic mock graph", () => {
    const mockGraph = new Map<string, string[]>();
    mockGraph.set("a.ts", ["b.ts"]);
    mockGraph.set("b.ts", ["c.ts"]);
    mockGraph.set("c.ts", []);
    const cycles = findCycles(mockGraph);
    expect(cycles.length).toBe(0);
  });
});

// ── S9: process.env allowlist size cap ────────────────────────

describe("Coding standards — S9: process.env allowlist size cap", () => {
  // This is a meta-test that enforces a cap on the S2 allowlist size.
  // The cap prevents the allowlist from growing unbounded, which would
  // dilute the value of the S2 standard.
  //
  // Current state: 18 ALLOWLIST entries + 2 EXCLUDED_BY_DESIGN = 20 total.
  // Any increase MUST be justified with a comment in S2's ALLOWLIST.
  const MAX_TOTAL_ENV_EXCEPTIONS = 20;

  // Re-read the S2 allowlist and excluded-by-design sets.
  // We parse the test file itself to count entries — this is intentionally meta.
  it("S2 allowlist + excluded-by-design does not exceed cap", () => {
    const testContent = readFileSync(join(import.meta.dir, "coding-standards.test.ts"), "utf-8");

    // Count ALLOWLIST entries (lines matching "key": "value" pattern inside ALLOWLIST block)
    const allowlistMatch = testContent.match(
      /const ALLOWLIST:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\};/,
    );
    const allowlistEntries = allowlistMatch
      ? (allowlistMatch[1].match(/"[^"]+"\s*:/g) || []).length
      : 0;

    // Count EXCLUDED_BY_DESIGN entries
    const excludedMatch = testContent.match(/EXCLUDED_BY_DESIGN\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
    const excludedEntries = excludedMatch ? (excludedMatch[1].match(/"[^"]+"/g) || []).length : 0;

    const total = allowlistEntries + excludedEntries;

    expect(total).toBeLessThanOrEqual(MAX_TOTAL_ENV_EXCEPTIONS);
    // If this test fails, you added a new process.env exception without reducing existing ones.
    // Either migrate an existing file to use getConfig() first, or increase MAX_TOTAL_ENV_EXCEPTIONS
    // with a justification comment.
  });

  it("MAX cap matches documented value (sanity)", () => {
    // Ensure the cap is not silently increased beyond a reasonable bound
    expect(MAX_TOTAL_ENV_EXCEPTIONS).toBeLessThanOrEqual(25);
  });
});
