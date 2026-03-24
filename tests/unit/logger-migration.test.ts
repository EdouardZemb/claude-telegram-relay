/**
 * Unit Tests — Logger migration (AC-1, AC-2)
 *
 * Verifies that all migrated modules use the structured logger
 * instead of direct console.log/error/warn calls.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SRC_DIR = join(import.meta.dir, "../../src");

const MIGRATED_MODULES = [
  // Pilotes (already migrated)
  "relay.ts",
  "agent.ts",
  // Vague 1 — Modules critiques haute frequence
  "memory/core.ts",
  "memory/classification.ts",
  "memory/scoring.ts",
  "memory/ideas.ts",
  "memory/graph.ts",
  "memory/agent-memory.ts",
  "heartbeat.ts",
  "documents.ts",
  "commands/zz-messages.ts",
  "bot-context.ts",
  // Vague 2 — Infrastructure et agents
  "tts.ts",
  "workflow.ts",
  "loader.ts",
  // Vague 3 — Modules legers
  "tasks.ts",
  "commands/utilities.ts",
  "document-sharding.ts",
  "llm-ops.ts",
  "cost-tracking.ts",
  "notification-queue.ts",
  "projects.ts",
  "job-manager.ts",
  "commands/documents.ts",
  "commands/memory-cmds.ts",
  "commands/quality.ts",
  "gates.ts",
  "transcribe.ts",
  "intent-detection.ts",
  "conversation-session.ts",
  "bmad-prompts.ts",
  "commands/help.ts",
];

/**
 * Filter code lines: exclude comments and string literals containing "console.".
 * R16: The regex must ignore console.* inside string literals to avoid false positives.
 */
function getCodeLines(content: string): string[] {
  return content.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    // Exclude comment lines
    if (trimmed.startsWith("//")) return false;
    if (trimmed.startsWith("*")) return false;
    if (trimmed.startsWith("/*")) return false;
    return true;
  });
}

/**
 * Check if a line has a real console.X call (not inside a string literal).
 * Returns true if the line contains a real console call outside of strings.
 */
function hasRealConsoleCall(line: string, pattern: RegExp): boolean {
  if (!pattern.test(line)) return false;

  // Remove string literals to avoid false positives (R16)
  const withoutStrings = line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

  return pattern.test(withoutStrings);
}

describe("Logger migration — AC-1: no direct console calls", () => {
  for (const mod of MIGRATED_MODULES) {
    describe(mod, () => {
      const content = readFileSync(join(SRC_DIR, mod), "utf-8");

      it("imports createLogger from logger.ts", () => {
        expect(content).toMatch(/import\s*\{\s*createLogger\s*\}\s*from\s*"[^"]*logger\.ts"/);
      });

      it("creates a module-scoped logger instance", () => {
        expect(content).toMatch(/const log = createLogger\("[^"]+"\)/);
      });

      it("has no direct console.log calls", () => {
        const codeLines = getCodeLines(content);
        const consoleLogLines = codeLines.filter((line) =>
          hasRealConsoleCall(line, /\bconsole\.log\b/),
        );
        expect(consoleLogLines).toEqual([]);
      });

      it("has no direct console.error calls", () => {
        const codeLines = getCodeLines(content);
        const consoleErrorLines = codeLines.filter((line) =>
          hasRealConsoleCall(line, /\bconsole\.error\b/),
        );
        expect(consoleErrorLines).toEqual([]);
      });

      it("has no direct console.warn calls", () => {
        const codeLines = getCodeLines(content);
        const consoleWarnLines = codeLines.filter((line) =>
          hasRealConsoleCall(line, /\bconsole\.warn\b/),
        );
        expect(consoleWarnLines).toEqual([]);
      });

      it("uses log.info, log.error, or log.warn instead", () => {
        expect(content).toMatch(/\blog\.(info|error|warn|debug)\(/);
      });
    });
  }
});

describe("Logger migration — AC-2: existing tests still pass", () => {
  it("createLogger returns an object with info, warn, error, debug", () => {
    // Dynamic import to verify the module loads correctly
    const { createLogger } = require("../../src/logger.ts");
    const log = createLogger("test");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.debug).toBe("function");
  });
});

describe("Logger migration — V6: logger.ts preserves console calls", () => {
  it("logger.ts contains exactly 3 console.* calls (implementation)", () => {
    const content = readFileSync(join(SRC_DIR, "logger.ts"), "utf-8");
    const codeLines = getCodeLines(content);
    const consoleCalls = codeLines.filter((line) => /\bconsole\.(log|error|warn)\b/.test(line));
    expect(consoleCalls.length).toBe(3);
  });
});

describe("Logger migration — V7: heartbeat.ts no timestamp prefix", () => {
  it("heartbeat.ts has no [${timestamp}] prefix in log calls", () => {
    const content = readFileSync(join(SRC_DIR, "heartbeat.ts"), "utf-8");
    const codeLines = getCodeLines(content);
    const timestampPrefixLines = codeLines.filter(
      (line) => /`\[\$\{timestamp\}\]/.test(line) && /\blog\./.test(line),
    );
    expect(timestampPrefixLines).toEqual([]);
  });
});

describe("Logger migration — V8: loader.ts no [loader] prefix", () => {
  it("loader.ts has no [loader] prefix in log calls", () => {
    const content = readFileSync(join(SRC_DIR, "loader.ts"), "utf-8");
    const codeLines = getCodeLines(content);
    const loaderPrefixLines = codeLines.filter(
      (line) => /\[loader\]/.test(line) && /\blog\./.test(line),
    );
    expect(loaderPrefixLines).toEqual([]);
  });
});

