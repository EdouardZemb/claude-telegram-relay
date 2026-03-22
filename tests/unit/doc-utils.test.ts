/**
 * @module doc-utils.test
 * @description Tests for documentation parsing utilities (doc-utils.ts).
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  type DocState,
  extractCommands,
  extractModules,
  findGaps,
  parseClaudeMdCommands,
  parseClaudeMdModuleCount,
  parseClaudeMdModules,
  parseClaudeMdTestCount,
} from "../../scripts/doc-utils.ts";

const ROOT = join(import.meta.dir, "../..");
const SRC_DIR = join(ROOT, "src");
const RELAY_PATH = join(SRC_DIR, "relay.ts");
const CLAUDE_MD_PATH = join(ROOT, "CLAUDE.md");

describe("doc-utils", () => {
  describe("extractModules", () => {
    test("returns all .ts files from src/", async () => {
      const modules = await extractModules(SRC_DIR);
      expect(modules.length).toBeGreaterThanOrEqual(39);
      expect(modules).toContain("relay.ts");
      expect(modules).toContain("agent.ts");
      expect(modules).toContain("autonomy-scanner.ts");
      expect(modules).not.toContain("autonomy-cron.ts");
    });

    test("returns sorted array", async () => {
      const modules = await extractModules(SRC_DIR);
      const sorted = [...modules].sort();
      expect(modules).toEqual(sorted);
    });
  });

  describe("extractCommands", () => {
    test("extracts all bot.command registrations", async () => {
      const commands = await extractCommands(RELAY_PATH);
      expect(commands.length).toBeGreaterThanOrEqual(29);
      expect(commands).toContain("/help");
      expect(commands).toContain("/task");
      expect(commands).toContain("/notify");
      expect(commands).toContain("/brain");
      expect(commands).toContain("/ideas");
    });

    test("returns sorted array with / prefix", async () => {
      const commands = await extractCommands(RELAY_PATH);
      for (const cmd of commands) {
        expect(cmd.startsWith("/")).toBe(true);
      }
      const sorted = [...commands].sort();
      expect(commands).toEqual(sorted);
    });
  });

  describe("parseClaudeMdModules", () => {
    test("extracts modules from CLAUDE.md table", async () => {
      const modules = await parseClaudeMdModules(CLAUDE_MD_PATH);
      expect(modules.length).toBeGreaterThanOrEqual(39);
      expect(modules).toContain("relay.ts");
      expect(modules).toContain("autonomy-scanner.ts");
    });
  });

  describe("parseClaudeMdCommands", () => {
    test("extracts commands from CLAUDE.md table", async () => {
      const commands = await parseClaudeMdCommands(CLAUDE_MD_PATH);
      expect(commands.length).toBeGreaterThanOrEqual(29);
      expect(commands).toContain("/help");
      expect(commands).toContain("/notify");
    });
  });

  describe("parseClaudeMdTestCount", () => {
    test("extracts test count from conventions section", () => {
      const content = `### Conventions\n- Tests: \`bun test\` (640 tests, all must pass)\n---`;
      expect(parseClaudeMdTestCount(content)).toBe(640);
    });

    test("returns 0 if no match", () => {
      expect(parseClaudeMdTestCount("no tests here")).toBe(0);
    });
  });

  describe("parseClaudeMdModuleCount", () => {
    test("extracts module count from project structure", () => {
      const content = `src/                    40 TypeScript modules (core logic)`;
      expect(parseClaudeMdModuleCount(content)).toBe(40);
    });
  });

  describe("findGaps", () => {
    test("detects missing module", () => {
      const state: DocState = {
        srcModules: ["relay.ts", "newmodule.ts"],
        claudeMdModules: ["relay.ts"],
        srcCommands: ["/help"],
        claudeMdCommands: ["/help"],
        actualTestCount: 100,
        claudeMdTestCount: 100,
      };
      const gaps = findGaps(state);
      expect(gaps.length).toBe(1);
      expect(gaps[0].type).toBe("missing_module");
      expect(gaps[0].item).toBe("newmodule.ts");
    });

    test("detects extra module in docs", () => {
      const state: DocState = {
        srcModules: ["relay.ts"],
        claudeMdModules: ["relay.ts", "deleted.ts"],
        srcCommands: [],
        claudeMdCommands: [],
        actualTestCount: 100,
        claudeMdTestCount: 100,
      };
      const gaps = findGaps(state);
      expect(gaps.length).toBe(1);
      expect(gaps[0].type).toBe("extra_module");
    });

    test("detects missing command", () => {
      const state: DocState = {
        srcModules: [],
        claudeMdModules: [],
        srcCommands: ["/help", "/newcmd"],
        claudeMdCommands: ["/help"],
        actualTestCount: 100,
        claudeMdTestCount: 100,
      };
      const gaps = findGaps(state);
      expect(gaps.length).toBe(1);
      expect(gaps[0].type).toBe("missing_command");
    });

    test("detects test count drift beyond tolerance", () => {
      const state: DocState = {
        srcModules: [],
        claudeMdModules: [],
        srcCommands: [],
        claudeMdCommands: [],
        actualTestCount: 680,
        claudeMdTestCount: 640,
      };
      const gaps = findGaps(state);
      expect(gaps.length).toBe(1);
      expect(gaps[0].type).toBe("test_count");
    });

    test("allows test count drift within tolerance (±10)", () => {
      const state: DocState = {
        srcModules: [],
        claudeMdModules: [],
        srcCommands: [],
        claudeMdCommands: [],
        actualTestCount: 645,
        claudeMdTestCount: 640,
      };
      const gaps = findGaps(state);
      expect(gaps.length).toBe(0);
    });

    test("returns empty array when all is in sync", () => {
      const state: DocState = {
        srcModules: ["relay.ts", "agent.ts"],
        claudeMdModules: ["agent.ts", "relay.ts"],
        srcCommands: ["/help"],
        claudeMdCommands: ["/help"],
        actualTestCount: 640,
        claudeMdTestCount: 640,
      };
      const gaps = findGaps(state);
      expect(gaps.length).toBe(0);
    });
  });
});
