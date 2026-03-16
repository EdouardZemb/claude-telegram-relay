/**
 * Unit Tests — Feature-level monitoring in src/alerts.ts (S29-T10)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  recordResponseTime,
  getResponseTimeStats,
  recordSpawnResult,
  getSpawnStats,
  recordModuleError,
  getModuleErrorCounts,
  checkResponseTime,
  checkSpawnFailures,
  checkModuleErrors,
  formatMonitoringStats,
} from "../../src/alerts";

describe("Response Time Monitoring", () => {
  it("records and retrieves response times", () => {
    // Record several times
    for (let i = 0; i < 10; i++) {
      recordResponseTime(1000 + i * 100);
    }
    const stats = getResponseTimeStats();
    expect(stats.count).toBeGreaterThanOrEqual(10);
    expect(stats.p50).toBeGreaterThan(0);
    expect(stats.p95).toBeGreaterThan(stats.p50);
  });

  it("calculates percentiles correctly", () => {
    // Add known values
    for (let i = 0; i < 100; i++) {
      recordResponseTime(i * 100); // 0ms to 9900ms
    }
    const stats = getResponseTimeStats();
    expect(stats.p50).toBeGreaterThanOrEqual(4000);
    expect(stats.p50).toBeLessThanOrEqual(6000);
    expect(stats.p95).toBeGreaterThanOrEqual(9000);
  });

  it("checkResponseTime alerts when p95 > 30s", () => {
    // Fill buffer with high values
    for (let i = 0; i < 100; i++) {
      recordResponseTime(35000); // 35s each
    }
    const alerts = checkResponseTime();
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].type).toBe("long_running_step");
  });
});

describe("Spawn Stats Monitoring", () => {
  it("records spawn results per role", () => {
    recordSpawnResult("dev", true);
    recordSpawnResult("dev", true);
    recordSpawnResult("dev", false);
    recordSpawnResult("qa", true);

    const stats = getSpawnStats();
    expect(stats.dev.success).toBeGreaterThanOrEqual(2);
    expect(stats.dev.failure).toBeGreaterThanOrEqual(1);
    expect(stats.qa.success).toBeGreaterThanOrEqual(1);
  });

  it("calculates failure rate", () => {
    // Add enough failures to trigger
    for (let i = 0; i < 5; i++) {
      recordSpawnResult("analyst", false);
    }
    recordSpawnResult("analyst", true);

    const stats = getSpawnStats();
    expect(stats.analyst.failureRate).toBeGreaterThan(50);
  });

  it("checkSpawnFailures alerts on high failure rate", () => {
    for (let i = 0; i < 5; i++) {
      recordSpawnResult("sm_test", false);
    }
    const alerts = checkSpawnFailures();
    const smAlert = alerts.find(a => a.message.includes("sm_test"));
    expect(smAlert).toBeDefined();
  });
});

describe("Module Error Monitoring", () => {
  it("records and counts module errors", () => {
    recordModuleError("relay");
    recordModuleError("relay");
    recordModuleError("agent");

    const counts = getModuleErrorCounts();
    expect(counts.relay).toBeGreaterThanOrEqual(2);
    expect(counts.agent).toBeGreaterThanOrEqual(1);
  });

  it("checkModuleErrors alerts when count > 10", () => {
    for (let i = 0; i < 15; i++) {
      recordModuleError("test_module");
    }
    const alerts = checkModuleErrors();
    const modAlert = alerts.find(a => a.message.includes("test_module"));
    expect(modAlert).toBeDefined();
  });
});

describe("formatMonitoringStats", () => {
  it("formats monitoring output", () => {
    const output = formatMonitoringStats();
    expect(output).toContain("Monitoring Production");
    expect(output).toContain("Temps de reponse");
    expect(output).toContain("Spawn Claude par role");
    expect(output).toContain("Erreurs modules");
  });
});
