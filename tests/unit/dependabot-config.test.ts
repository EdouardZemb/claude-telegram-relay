import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { parse } from "yaml";

describe("Dependabot configuration", () => {
  const dependabotPath = ".github/dependabot.yml";

  test("dependabot.yml exists", () => {
    expect(existsSync(dependabotPath)).toBe(true);
  });

  test("version is 2", () => {
    const content = readFileSync(dependabotPath, "utf-8");
    const config = parse(content);
    expect(config.version).toBe(2);
  });

  test("has updates array with at least one entry", () => {
    const content = readFileSync(dependabotPath, "utf-8");
    const config = parse(content);
    expect(Array.isArray(config.updates)).toBe(true);
    expect(config.updates.length).toBeGreaterThanOrEqual(1);
  });

  test("npm ecosystem is configured for root directory", () => {
    const content = readFileSync(dependabotPath, "utf-8");
    const config = parse(content);
    const npmUpdate = config.updates.find(
      (u: { "package-ecosystem": string }) => u["package-ecosystem"] === "npm",
    );
    expect(npmUpdate).toBeDefined();
    expect(npmUpdate.directory).toBe("/");
  });

  test("schedule interval is weekly", () => {
    const content = readFileSync(dependabotPath, "utf-8");
    const config = parse(content);
    const npmUpdate = config.updates[0];
    expect(npmUpdate.schedule).toBeDefined();
    expect(npmUpdate.schedule.interval).toBe("weekly");
  });

  test("schedule day is monday", () => {
    const content = readFileSync(dependabotPath, "utf-8");
    const config = parse(content);
    const npmUpdate = config.updates[0];
    expect(npmUpdate.schedule.day).toBe("monday");
  });

  test("open-pull-requests-limit is defined and <= 5", () => {
    const content = readFileSync(dependabotPath, "utf-8");
    const config = parse(content);
    const npmUpdate = config.updates[0];
    expect(npmUpdate["open-pull-requests-limit"]).toBeDefined();
    expect(npmUpdate["open-pull-requests-limit"]).toBeLessThanOrEqual(5);
  });

  test("labels include dependabot", () => {
    const content = readFileSync(dependabotPath, "utf-8");
    const config = parse(content);
    const npmUpdate = config.updates[0];
    expect(Array.isArray(npmUpdate.labels)).toBe(true);
    expect(npmUpdate.labels).toContain("dependabot");
  });
});
