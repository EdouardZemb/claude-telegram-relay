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
  "orchestrator.ts",
  "agent.ts",
  // Vague 1 — Modules critiques haute frequence
  "memory.ts",
  "heartbeat.ts",
  "documents.ts",
  "commands/zz-messages.ts",
  "bot-context.ts",
  // Vague 2 — Infrastructure et agents
  "tts.ts",
  "gate-evaluator.ts",
  "workflow.ts",
  "loader.ts",
  "prd.ts",
  "blackboard.ts",
  "adversarial-verifier.ts",
  // Vague 3 — Modules legers
  "tasks.ts",
  "adversarial-challenge.ts",
  "commands/utilities.ts",
  "llm-router.ts",
  "document-sharding.ts",
  "llm-ops.ts",
  "cost-tracking.ts",
  "notification-queue.ts",
  "projects.ts",
  "spec-lite.ts",
  "pipeline-state.ts",
  "job-manager.ts",
  "commands/documents.ts",
  "commands/memory-cmds.ts",
  "commands/quality.ts",
  "trust-scores.ts",
  "gates.ts",
  "agent-context.ts",
  "agent-events.ts",
  "feedback-loop.ts",
  "story-files.ts",
  "transcribe.ts",
  "intent-detection.ts",
  "conversation-session.ts",
  "gate-persistence.ts",
  "code-review.ts",
  "bmad-prompts.ts",
  "commands/execution.ts",
  "commands/help.ts",
  "commands/jobs.ts",
];

/**
 * Filter code lines: exclude comments and string literals containing "console.".
 * R16: The regex must ignore console.* inside string literals to avoid false positives
 * (e.g., gate-persistence.ts has "log les erreurs avec console.error" in a template string).
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

describe("Logger migration — R16: gate-persistence.ts string literal not flagged", () => {
  it("gate-persistence.ts has console.error only in string literals", () => {
    const content = readFileSync(join(SRC_DIR, "gate-persistence.ts"), "utf-8");
    const codeLines = getCodeLines(content);
    const realConsoleCalls = codeLines.filter((line) =>
      hasRealConsoleCall(line, /\bconsole\.(log|error|warn)\b/),
    );
    expect(realConsoleCalls).toEqual([]);
  });
});
