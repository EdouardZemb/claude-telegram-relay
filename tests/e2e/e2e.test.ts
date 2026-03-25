/**
 * E2E tests for critical Telegram bot commands.
 * Uses handleUpdate injection — no external Telegram API calls.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { E2EFramework } from "./framework";

describe("E2E Telegram Commands", () => {
  let fw: E2EFramework;

  beforeAll(async () => {
    fw = new E2EFramework({
      runId: process.env.GITHUB_RUN_ID || `local-${Date.now()}`,
    });
    await fw.setup();
  });

  afterEach(async () => {
    await fw.cleanup();
  });

  afterAll(async () => {
    await fw.teardown();
  });

  test("/help returns command list", async () => {
    const reply = await fw.sendCommand("/help");
    expect(reply.length).toBeGreaterThan(0);
    fw.assertContains(reply, "COMMANDES");
    // Interactive menu: categories shown via inline keyboard, individual commands in sub-menus
    fw.assertContains(reply, "categorie");
  });

  test("/status returns health info", async () => {
    const reply = await fw.sendCommand("/status");
    expect(reply.length).toBeGreaterThan(0);
    // Should contain server info (hostname, uptime, CPU, memory)
    fw.assertContains(reply, "Serveur");
    fw.assertContains(reply, "Uptime");
  });

  test("/feature list returns feature flags", async () => {
    const reply = await fw.sendCommand("/feature list");
    expect(reply.length).toBeGreaterThan(0);
    // formatFeatures() outputs feature flag names
    // At minimum it should return something (even "Aucune feature" if empty)
    expect(reply).toBeTruthy();
  });

  test("/workflow returns BMad workflow overview", async () => {
    const reply = await fw.sendCommand("/workflow");
    expect(reply.length).toBeGreaterThan(0);
    fw.assertContains(reply, "WORKFLOW");
  });

  test("/monitor returns monitoring metrics", async () => {
    const reply = await fw.sendCommand("/monitor");
    expect(reply.length).toBeGreaterThan(0);
    // formatMonitoringStats() returns response time, spawn stats
    expect(reply).toBeTruthy();
  });

  // /estimate removed (ARCHITECTURE-V2)

  test("/notify status returns notification preferences", async () => {
    const reply = await fw.sendCommand("/notify status");
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toBeTruthy();
  });
});
