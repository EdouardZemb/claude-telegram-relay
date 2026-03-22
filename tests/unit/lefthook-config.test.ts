import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { parse } from "yaml";

describe("Lefthook pre-commit hook configuration", () => {
  const lefthookPath = "lefthook.yml";
  const biomePath = "biome.json";
  const packageJsonPath = "package.json";

  test("lefthook.yml exists", () => {
    expect(existsSync(lefthookPath)).toBe(true);
  });

  test("lefthook.yml contains pre-commit hook with biome check command", () => {
    const content = readFileSync(lefthookPath, "utf-8");
    const config = parse(content);

    expect(config["pre-commit"]).toBeDefined();
    expect(config["pre-commit"].commands).toBeDefined();

    const commands = config["pre-commit"].commands;
    const biomeCommand = commands["biome-check"];
    expect(biomeCommand).toBeDefined();
    expect(biomeCommand.run).toContain("biome check");
    expect(biomeCommand.run).toContain("{staged_files}");
  });

  test("lefthook.yml targets only TypeScript and JSON files via glob", () => {
    const content = readFileSync(lefthookPath, "utf-8");
    const config = parse(content);

    const biomeCommand = config["pre-commit"].commands["biome-check"];
    expect(biomeCommand.glob).toContain("ts");
    expect(biomeCommand.glob).toContain("json");
  });

  test("biome.json exists with correct formatter settings", () => {
    expect(existsSync(biomePath)).toBe(true);

    const content = readFileSync(biomePath, "utf-8");
    const config = JSON.parse(content);

    expect(config.formatter.enabled).toBe(true);
    expect(config.formatter.indentStyle).toBe("space");
    expect(config.formatter.indentWidth).toBe(2);
    expect(config.linter.enabled).toBe(true);
  });

  test("biome is installed as devDependency", () => {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);

    expect(pkg.devDependencies["@biomejs/biome"]).toBeDefined();
  });

  test("lefthook is installed as devDependency", () => {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);

    expect(pkg.devDependencies.lefthook).toBeDefined();
  });

  test("package.json has prepare script for lefthook install", () => {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);

    expect(pkg.scripts.prepare).toBe("lefthook install");
  });

  test("biome check passes on the codebase with no errors", () => {
    const result = Bun.spawnSync(["bunx", "biome", "check", "src/", "mcp/", "tests/"], {
      cwd: process.cwd(),
    });
    const stderr = new TextDecoder().decode(result.stderr);
    // Should not contain "Found N errors" (warnings are OK)
    expect(stderr).not.toMatch(/Found \d+ errors/);
  });
});
