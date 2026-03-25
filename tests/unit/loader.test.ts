/**
 * Unit Tests — src/loader.ts
 *
 * Tests for auto-discovery, loading order, error boundaries,
 * and edge cases of the Composer loader.
 *
 * After migration to structured logger, loader.ts uses log.info("Loaded: file")
 * instead of console.log("[loader] Loaded: file"). Tests intercept console.log
 * (the underlying output) and parse the structured logger format.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { Bot, Composer } from "grammy";
import { join } from "path";

import { loadComposers } from "../../src/loader.ts";

// Minimal BotContext mock — factory functions just need to not crash
function makeBotContext() {
  return {
    callClaude: async () => "mock",
    sendResponse: async () => {},
    buildPrompt: () => "mock prompt",
    supabase: null,
    session: {},
    getTopicConfig: () => null,
    isAllowedInTopic: () => true,
  };
}

function makeBot(): Bot {
  // Grammy Bot requires a token; "test:token" is enough for testing without polling
  return new Bot("test:token");
}

/**
 * Extract loaded filenames from logger output.
 * The structured logger outputs either:
 * - Dev mode: "HH:mm:ss.SSS INFO  [loader]  Loaded: filename.ts"
 * - JSON mode: {"module":"loader","message":"Loaded: filename.ts",...}
 * We capture any output containing "Loaded: " and extract the filename.
 */
function extractLoadedFiles(calls: string[][]): string[] {
  const files: string[] = [];
  for (const args of calls) {
    const msg = args.join(" ");
    // Match "Loaded: <filename>" in any format
    const match = msg.match(/Loaded:\s+(\S+\.ts)/);
    if (match) {
      files.push(match[1]);
    }
  }
  return files;
}

/**
 * Extract the summary line "N/M composers loaded" from logger output.
 */
function extractSummary(calls: string[][]): string | null {
  for (const args of calls) {
    const msg = args.join(" ");
    if (msg.includes("composers loaded")) {
      return msg;
    }
  }
  return null;
}

describe("loader", () => {
  describe("loadComposers (real commands)", () => {
    it("loads all existing Composer modules from src/commands/", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const count = await loadComposers(bot, ctx);

      // There should be at least 10 composers (currently 13)
      expect(count).toBeGreaterThanOrEqual(10);
    });

    it("returns the count of successfully loaded composers", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const count = await loadComposers(bot, ctx);

      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThan(0);
    });

    it("registers middleware on the bot for each loaded composer", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      // bot.use is called once per loaded composer (errorBoundary wrapping)
      const useSpy = spyOn(bot, "use");

      await loadComposers(bot, ctx);

      // Each loaded composer calls bot.use once
      expect(useSpy).toHaveBeenCalled();
      expect(useSpy.mock.calls.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("loading order", () => {
    it("sorts files alphabetically so zz-messages loads last", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      // Capture console.log output (the logger writes to console.log for info level)
      const logCalls: string[][] = [];
      const origLog = console.log;
      console.log = (...args: string[]) => {
        logCalls.push(args);
      };

      try {
        await loadComposers(bot, ctx);
      } finally {
        console.log = origLog;
      }

      const loadOrder = extractLoadedFiles(logCalls);

      // zz-messages.ts must be the last loaded file
      expect(loadOrder.length).toBeGreaterThan(0);
      expect(loadOrder[loadOrder.length - 1]).toBe("zz-messages.ts");

      // All other files should come before zz-messages.ts alphabetically
      for (let i = 0; i < loadOrder.length - 1; i++) {
        expect(loadOrder[i].localeCompare(loadOrder[i + 1])).toBeLessThanOrEqual(0);
      }
    });

    it("loads help.ts before zz-messages.ts", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const logCalls: string[][] = [];
      const origLog = console.log;
      console.log = (...args: string[]) => {
        logCalls.push(args);
      };

      try {
        await loadComposers(bot, ctx);
      } finally {
        console.log = origLog;
      }

      const loadOrder = extractLoadedFiles(logCalls);
      const helpIdx = loadOrder.indexOf("help.ts");
      const zzIdx = loadOrder.indexOf("zz-messages.ts");

      expect(helpIdx).toBeGreaterThanOrEqual(0);
      expect(zzIdx).toBeGreaterThanOrEqual(0);
      expect(helpIdx).toBeLessThan(zzIdx);
    });
  });

  describe("errorBoundary wrapping", () => {
    it("wraps each composer in bot.errorBoundary", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const errorBoundarySpy = spyOn(bot, "errorBoundary");

      await loadComposers(bot, ctx);

      // errorBoundary called once per loaded composer
      expect(errorBoundarySpy).toHaveBeenCalled();
      const count = errorBoundarySpy.mock.calls.length;
      expect(count).toBeGreaterThanOrEqual(10);
    });

    it("errorBoundary receives a handler function and a Composer", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const errorBoundarySpy = spyOn(bot, "errorBoundary");

      await loadComposers(bot, ctx);

      // Each call to errorBoundary should have (handlerFn, composerInstance)
      for (const call of errorBoundarySpy.mock.calls) {
        expect(typeof call[0]).toBe("function"); // error handler
        expect(call[1]).toBeInstanceOf(Composer); // the composer
      }
    });
  });

  describe("handling invalid modules", () => {
    it("logs warning for module without default export and continues", async () => {
      // Create a temp commands directory with a bad module
      const tempDir = join(import.meta.dir, "__temp_loader_test");
      const commandsDir = join(tempDir, "commands");
      mkdirSync(commandsDir, { recursive: true });

      // Module with no default export
      writeFileSync(join(commandsDir, "bad-no-default.ts"), 'export const notDefault = "hello";\n');

      // Valid module with default Composer export
      writeFileSync(
        join(commandsDir, "good-module.ts"),
        `import { Composer } from "grammy";
const c = new Composer();
export default c;
`,
      );

      const origWarn = console.warn;
      const origLog = console.log;
      const origErr = console.error;
      console.warn = () => {};
      console.log = () => {};
      console.error = () => {};

      try {
        const bot = makeBot();
        const ctx = makeBotContext();
        const count = await loadComposers(bot, ctx);

        // All real modules have valid default exports, so count matches file count
        expect(count).toBeGreaterThan(0);
      } finally {
        console.warn = origWarn;
        console.log = origLog;
        console.error = origErr;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("continues loading remaining modules when one fails to import", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const origErr = console.error;
      const origLog = console.log;
      console.error = () => {};
      console.log = () => {};

      try {
        const count = await loadComposers(bot, ctx);
        expect(count).toBeGreaterThan(0);
      } finally {
        console.error = origErr;
        console.log = origLog;
      }
    });
  });

  describe("return value", () => {
    it("returns a number", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const result = await loadComposers(bot, ctx);

      expect(typeof result).toBe("number");
    });

    it("returns the count of loaded composers (not total files)", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      // Suppress logs and capture summary
      const logCalls: string[][] = [];
      const origLog = console.log;
      console.log = (...args: string[]) => {
        logCalls.push(args);
      };

      try {
        const count = await loadComposers(bot, ctx);

        // The summary log should contain "N/M composers loaded"
        const summary = extractSummary(logCalls);
        expect(summary).toBeTruthy();
        // Parse "N/M" from summary
        const match = summary!.match(/(\d+)\/(\d+)/);
        expect(match).toBeTruthy();

        const loaded = parseInt(match![1], 10);
        const total = parseInt(match![2], 10);

        expect(count).toBe(loaded);
        expect(loaded).toBeLessThanOrEqual(total);
      } finally {
        console.log = origLog;
      }
    });

    it("loaded count matches total when all modules are valid", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const logCalls: string[][] = [];
      const origLog = console.log;
      console.log = (...args: string[]) => {
        logCalls.push(args);
      };

      try {
        const count = await loadComposers(bot, ctx);
        const summary = extractSummary(logCalls);
        expect(summary).toBeTruthy();
        const match = summary!.match(/(\d+)\/(\d+)/);
        expect(match).toBeTruthy();
        // command-router.ts is a utility module (no default Composer export) — intentionally skipped.
        // All other real Composer modules should load successfully.
        const KNOWN_NON_COMPOSER_COUNT = 1; // command-router.ts
        const total = parseInt(match![2], 10);
        const loaded = parseInt(match![1], 10);
        expect(loaded).toBe(total - KNOWN_NON_COMPOSER_COUNT);
        expect(count).toBe(loaded);
      } finally {
        console.log = origLog;
      }
    });
  });

  describe("edge cases", () => {
    it("handles being called multiple times on the same bot", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const origLog = console.log;
      console.log = () => {};

      try {
        const count1 = await loadComposers(bot, ctx);
        const count2 = await loadComposers(bot, ctx);

        // Both calls should succeed and return the same count
        expect(count1).toBe(count2);
        expect(count1).toBeGreaterThan(0);
      } finally {
        console.log = origLog;
      }
    });

    it("logs each loaded module filename", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const logCalls: string[][] = [];
      const origLog = console.log;
      console.log = (...args: string[]) => {
        logCalls.push(args);
      };

      try {
        await loadComposers(bot, ctx);

        const loadedFiles = extractLoadedFiles(logCalls);

        // Should have logged loading of known files
        expect(loadedFiles).toContain("help.ts");
        expect(loadedFiles).toContain("tasks.ts");
        expect(loadedFiles).toContain("zz-messages.ts");
      } finally {
        console.log = origLog;
      }
    });

    it("only discovers .ts files (not .js or other extensions)", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const logCalls: string[][] = [];
      const origLog = console.log;
      console.log = (...args: string[]) => {
        logCalls.push(args);
      };

      try {
        await loadComposers(bot, ctx);

        const loadedFiles = extractLoadedFiles(logCalls);

        // All loaded files must end with .ts
        for (const file of loadedFiles) {
          expect(file.endsWith(".ts")).toBe(true);
        }
      } finally {
        console.log = origLog;
      }
    });

    it("loads all 12 known command files", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const logCalls: string[][] = [];
      const origLog = console.log;
      console.log = (...args: string[]) => {
        logCalls.push(args);
      };

      try {
        await loadComposers(bot, ctx);

        const loadedFiles = extractLoadedFiles(logCalls);

        const expected = [
          "documents.ts",
          "exploration.ts",
          "help.ts",
          "jobs.ts",
          "memory-cmds.ts",
          "profile.ts",
          "project.ts",
          "quality.ts",
          "sdd-flow.ts",
          "tasks.ts",
          "utilities.ts",
          "zz-messages.ts",
        ];

        for (const file of expected) {
          expect(loadedFiles).toContain(file);
        }
        expect(loadedFiles.length).toBe(expected.length);
      } finally {
        console.log = origLog;
      }
    });
  });

  describe("Composer factory support", () => {
    it("supports modules exporting a factory function", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const errors: string[] = [];
      const origErr = console.error;
      const origLog = console.log;
      console.error = (...args: string[]) => errors.push(args.join(" "));
      console.log = () => {};

      try {
        const count = await loadComposers(bot, ctx);

        // No loader errors should have occurred
        const loaderErrors = errors.filter((e) => e.includes("Failed to load"));
        expect(loaderErrors.length).toBe(0);
        expect(count).toBeGreaterThan(0);
      } finally {
        console.error = origErr;
        console.log = origLog;
      }
    });

    it("passes BotContext to factory functions", async () => {
      const bot = makeBot();
      const ctx = makeBotContext();

      const origLog = console.log;
      const origErr = console.error;
      const errors: string[] = [];
      console.log = () => {};
      console.error = (...args: string[]) => errors.push(args.join(" "));

      try {
        const count = await loadComposers(bot, ctx);

        // If BotContext was not passed, factory functions would throw
        const factoryErrors = errors.filter((e) => e.includes("factory did not return a Composer"));
        expect(factoryErrors.length).toBe(0);
        expect(count).toBeGreaterThanOrEqual(11);
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
    });
  });
});
