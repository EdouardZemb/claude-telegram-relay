import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "../..");

describe("tsconfig.json strict configuration", () => {
  const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf-8"));

  test("AC-1: strict mode is enabled", () => {
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  test("AC-1: noUncheckedIndexedAccess is enabled", () => {
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);
  });

  test("AC-1: exactOptionalPropertyTypes is enabled", () => {
    expect(tsconfig.compilerOptions.exactOptionalPropertyTypes).toBe(true);
  });

  test("AC-1: bun run typecheck passes with zero errors", () => {
    const result = spawnSync("npx", ["tsc", "--noEmit"], {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
      timeout: 120_000,
    });
    const stderr = result.stderr?.toString() ?? "";
    const stdout = result.stdout?.toString() ?? "";
    const output = stdout + stderr;
    const errorLines = output.split("\n").filter((l: string) => l.includes("error TS"));
    expect(errorLines).toEqual([]);
    expect(result.status).toBe(0);
  });

  test("AC-2: no implicit any in src/ (noImplicitAny via strict)", () => {
    // strict: true implies noImplicitAny — verified by zero typecheck errors above
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  test("AC-2: critical modules use unknown instead of any for external data", () => {
    // Verify key modules replaced any with unknown on external boundaries
    const filesToCheck = [
      { file: "src/blackboard.ts", pattern: /spec:\s*unknown\s*\|\s*null/ },
      { file: "src/agent-schemas.ts", pattern: /obj:\s*unknown/ },
      { file: "src/gate-evaluator.ts", pattern: /sectionData:\s*unknown/ },
      { file: "src/adversarial-challenge.ts", pattern: /raw:\s*unknown\[\]/ },
    ];

    for (const { file, pattern } of filesToCheck) {
      const content = readFileSync(join(ROOT, file), "utf-8");
      expect(content).toMatch(pattern);
    }
  });
});
