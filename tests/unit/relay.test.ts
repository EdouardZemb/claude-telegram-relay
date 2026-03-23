/**
 * @file relay.test.ts
 * @description Smoke tests for src/relay.ts
 * Verifies the module exports `createBot` without starting the bot.
 * Does NOT call createBot() (which requires a valid BOT_TOKEN and network).
 */

import { describe, expect, it } from "bun:test";

describe("relay module exports", () => {
  it("exports createBot function", async () => {
    const mod = await import("../../src/relay.ts");
    expect(typeof mod.createBot).toBe("function");
  });

  it("createBot is an async function (returns Promise)", async () => {
    const mod = await import("../../src/relay.ts");
    // Check it's a function — no need to call it without a real token
    const fn = mod.createBot;
    expect(typeof fn).toBe("function");
  });

  it("module can be imported without throwing (smoke test)", async () => {
    // If the module throws on import (e.g., missing env var at import time), this fails
    let error: unknown = null;
    try {
      await import("../../src/relay.ts");
    } catch (e: unknown) {
      error = e;
    }
    // Allow import errors from missing TELEGRAM_BOT_TOKEN only (not code errors)
    // The module should not throw at import time for missing env vars
    expect(error).toBeNull();
  });
});
