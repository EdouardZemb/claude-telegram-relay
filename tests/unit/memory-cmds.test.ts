/**
 * Unit Tests — src/commands/memory-cmds.ts
 *
 * Structural verification of /brain health dispatch and memory health integration.
 * V11, V18: Verify that /brain health dispatches correctly to memoryHealthStats.
 */

import { describe, expect, it } from "bun:test";

describe("/brain health dispatch", () => {
  let memoryCmdsSource: string;

  it("loads memory-cmds source", async () => {
    const fs = await import("fs");
    memoryCmdsSource = fs.readFileSync("src/commands/memory-cmds.ts", "utf-8");
    expect(memoryCmdsSource.length).toBeGreaterThan(0);
  });

  it("[V11] /brain health responds with formatted memory health metrics", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/commands/memory-cmds.ts", "utf-8");

    // V11: memoryHealthStats is imported
    expect(source).toContain("memoryHealthStats");
    expect(source).toContain("formatMemoryHealth");

    // V11: When brainInput === "health", memoryHealthStats is called
    const healthBlock = source.match(
      /if\s*\(\s*brainInput\s*===\s*["']health["']\s*\)\s*\{[\s\S]*?memoryHealthStats\(/,
    );
    expect(healthBlock).not.toBeNull();

    // V11: The formatted result is sent via sendResponseHtml (HTML formatting)
    const sendMatch = source.match(
      /memoryHealthStats\([\s\S]*?formatMemoryHealth\(\s*stats\s*\)[\s\S]*?sendResponseHtml/,
    );
    expect(sendMatch).not.toBeNull();
  });

  it("[V18] /brain health dispatches only on exact match 'health'", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/commands/memory-cmds.ts", "utf-8");

    // V18: The input is trimmed before comparison
    const trimMatch = source.match(
      /const\s+brainInput\s*=\s*\(ctx\.match\s*\|\|\s*["']["']\)\.toString\(\)\.trim\(\)/,
    );
    expect(trimMatch).not.toBeNull();

    // V18: Strict equality comparison (===) with "health", not includes/startsWith
    const exactMatch = source.match(/brainInput\s*===\s*["']health["']/);
    expect(exactMatch).not.toBeNull();

    // V18: "healthy" would NOT match because === "health" is strict
    // Verify there is no .startsWith("health") or .includes("health") pattern
    const looseMatch = source.match(/brainInput\.(startsWith|includes)\(\s*["']health["']\s*\)/);
    expect(looseMatch).toBeNull();

    // V18: The health block has an early return, so non-matching text falls through to LLM
    const earlyReturn = source.match(
      /if\s*\(\s*brainInput\s*===\s*["']health["']\s*\)\s*\{[\s\S]*?return;\s*\}/,
    );
    expect(earlyReturn).not.toBeNull();
  });
});
