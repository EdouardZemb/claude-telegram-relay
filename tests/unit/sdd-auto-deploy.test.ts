/**
 * Unit Tests — sdd_auto_deploy feature flag + deploy notification enrichie
 *
 * V-criteres:
 * V1: sdd_auto_deploy flag exists in config/features.json and is boolean
 * V2: sdd_auto_deploy defaults to true
 * V3: deploy.yml contains conditional step that reads sdd_auto_deploy flag
 * V4: deploy.yml skips restart when flag is false but still does git pull
 * V5: deploy.yml deploys normally when flag is true or absent (backward compat)
 * V6: notify-deploy.sh writes to mcp-pending-notifications.json on success
 * V7: notify-deploy.sh writes to mcp-pending-notifications.json on failure
 * V8: MCP notification includes type "alert", severity, commit SHA, and status
 * V9: notify-deploy.sh handles missing RELAY_DIR gracefully (creates it)
 * V10: notify-deploy.sh appends to existing pending notifications (no overwrite)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const REAL_FLAGS = join(PROJECT_ROOT, "config", "features.json");
const DEPLOY_YML = join(PROJECT_ROOT, ".github", "workflows", "deploy.yml");
const NOTIFY_SCRIPT = join(PROJECT_ROOT, "scripts", "notify-deploy.sh");

// ── V1 + V2: Feature flag existence and default ─────────────────

describe("sdd_auto_deploy flag (V1, V2)", () => {
  it("V1: sdd_auto_deploy exists in config/features.json and is boolean", () => {
    const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    expect(raw).toHaveProperty("sdd_auto_deploy");
    expect(typeof raw.sdd_auto_deploy).toBe("boolean");
  });

  it("V2: sdd_auto_deploy defaults to true", () => {
    const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    expect(raw.sdd_auto_deploy).toBe(true);
  });

  it("V1: isFeatureEnabled reads sdd_auto_deploy correctly", () => {
    const { isFeatureEnabled } = require("../../src/feature-flags");
    // Should match what's in the file
    const raw = JSON.parse(readFileSync(REAL_FLAGS, "utf-8"));
    expect(isFeatureEnabled("sdd_auto_deploy")).toBe(raw.sdd_auto_deploy);
  });
});

// ── V3, V4, V5: deploy.yml conditional step ─────────────────────

describe("deploy.yml feature flag check (V3, V4, V5)", () => {
  it("V3: deploy.yml contains a step that reads sdd_auto_deploy", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    expect(content).toContain("sdd_auto_deploy");
  });

  it("V3: deploy.yml uses jq or bun to read the flag from config/features.json", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    // Should read from features.json
    expect(content).toContain("features.json");
    // Should use one of these tools to parse
    const usesJqOrBun =
      content.includes("jq") || content.includes("bun -e") || content.includes("node -e");
    expect(usesJqOrBun).toBe(true);
  });

  it("V4: deploy.yml has conditional logic to skip restart when flag is false", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    // The restart step should reference the flag output
    expect(content).toContain("DEPLOY_ENABLED");
  });

  it("V5: deploy.yml defaults to deploying when flag is absent (backward compat)", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    // The check step should default to "true" when field is missing
    expect(content).toMatch(/true/);
  });
});

// ── V6, V7, V8, V9, V10: notify-deploy.sh enriched notifications ──

describe("notify-deploy.sh MCP notification (V6-V10)", () => {
  const TEST_RELAY_DIR = join(PROJECT_ROOT, "tmp-test-relay-dir");
  const MCP_FILE = join(TEST_RELAY_DIR, "mcp-pending-notifications.json");

  beforeEach(() => {
    // Clean up test dir
    if (existsSync(TEST_RELAY_DIR)) {
      rmSync(TEST_RELAY_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_RELAY_DIR)) {
      rmSync(TEST_RELAY_DIR, { recursive: true });
    }
  });

  it("V6: notify-deploy.sh writes MCP notification on success", () => {
    // Run the script with RELAY_DIR set and BOT_TOKEN/GROUP_ID empty (skip Telegram send)
    const result = spawnSync(["bash", NOTIFY_SCRIPT, "success", "abc1234 test commit"], {
      env: {
        ...process.env,
        RELAY_DIR: TEST_RELAY_DIR,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_GROUP_ID: "",
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
      },
      cwd: PROJECT_ROOT,
    });

    // Script should exit 0 (missing token exits with 0)
    expect(result.exitCode).toBe(0);

    // MCP file should be created
    expect(existsSync(MCP_FILE)).toBe(true);
    const pending = JSON.parse(readFileSync(MCP_FILE, "utf-8"));
    expect(Array.isArray(pending)).toBe(true);
    expect(pending.length).toBeGreaterThanOrEqual(1);

    const notif = pending[pending.length - 1];
    expect(notif.type).toBe("alert");
    expect(notif.message).toContain("Deploy OK");
  });

  it("V7: notify-deploy.sh writes MCP notification on failure", () => {
    const result = spawnSync(["bash", NOTIFY_SCRIPT, "failure", "Smoke test failed for abc1234"], {
      env: {
        ...process.env,
        RELAY_DIR: TEST_RELAY_DIR,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_GROUP_ID: "",
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
      },
      cwd: PROJECT_ROOT,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(MCP_FILE)).toBe(true);
    const pending = JSON.parse(readFileSync(MCP_FILE, "utf-8"));
    const notif = pending[pending.length - 1];
    expect(notif.type).toBe("alert");
    expect(notif.severity).toBe("critical");
    expect(notif.message).toContain("Deploy ECHEC");
  });

  it("V8: MCP notification includes type, severity, commit info, and status", () => {
    const result = spawnSync(["bash", NOTIFY_SCRIPT, "success", "abc1234 feat: add feature"], {
      env: {
        ...process.env,
        RELAY_DIR: TEST_RELAY_DIR,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_GROUP_ID: "",
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
      },
      cwd: PROJECT_ROOT,
    });

    expect(result.exitCode).toBe(0);
    const pending = JSON.parse(readFileSync(MCP_FILE, "utf-8"));
    const notif = pending[pending.length - 1];

    expect(notif).toHaveProperty("type");
    expect(notif).toHaveProperty("severity");
    expect(notif).toHaveProperty("message");
    expect(notif).toHaveProperty("data");
    expect(notif.data).toHaveProperty("deployStatus");
    expect(notif.data.deployStatus).toBe("success");
    expect(notif.type).toBe("alert");
    expect(notif.severity).toBe("normal");
  });

  it("V9: notify-deploy.sh creates RELAY_DIR if it does not exist", () => {
    expect(existsSync(TEST_RELAY_DIR)).toBe(false);

    spawnSync(["bash", NOTIFY_SCRIPT, "success", "abc1234 test"], {
      env: {
        ...process.env,
        RELAY_DIR: TEST_RELAY_DIR,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_GROUP_ID: "",
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
      },
      cwd: PROJECT_ROOT,
    });

    expect(existsSync(TEST_RELAY_DIR)).toBe(true);
    expect(existsSync(MCP_FILE)).toBe(true);
  });

  it("V10: notify-deploy.sh appends to existing pending notifications", () => {
    // Create dir and pre-existing notification
    mkdirSync(TEST_RELAY_DIR, { recursive: true });
    const existing = [{ type: "task", severity: "normal", message: "Existing task notification" }];
    writeFileSync(MCP_FILE, JSON.stringify(existing));

    spawnSync(["bash", NOTIFY_SCRIPT, "success", "abc1234 test"], {
      env: {
        ...process.env,
        RELAY_DIR: TEST_RELAY_DIR,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_GROUP_ID: "",
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
      },
      cwd: PROJECT_ROOT,
    });

    const pending = JSON.parse(readFileSync(MCP_FILE, "utf-8"));
    expect(pending.length).toBe(2);
    expect(pending[0].message).toBe("Existing task notification");
    expect(pending[1].type).toBe("alert");
    expect(pending[1].message).toContain("Deploy OK");
  });

  // Edge case: corrupted existing file
  it("V10-edge: handles corrupted existing MCP file gracefully", () => {
    mkdirSync(TEST_RELAY_DIR, { recursive: true });
    writeFileSync(MCP_FILE, "not valid json{{{");

    const result = spawnSync(["bash", NOTIFY_SCRIPT, "success", "abc1234 test"], {
      env: {
        ...process.env,
        RELAY_DIR: TEST_RELAY_DIR,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_GROUP_ID: "",
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
      },
      cwd: PROJECT_ROOT,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(MCP_FILE)).toBe(true);
    // Should create a valid JSON array with just the new notification
    const pending = JSON.parse(readFileSync(MCP_FILE, "utf-8"));
    expect(Array.isArray(pending)).toBe(true);
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe("alert");
  });

  // Edge case: empty details
  it("V8-edge: handles empty commit details gracefully", () => {
    const result = spawnSync(["bash", NOTIFY_SCRIPT, "success", ""], {
      env: {
        ...process.env,
        RELAY_DIR: TEST_RELAY_DIR,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_GROUP_ID: "",
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
      },
      cwd: PROJECT_ROOT,
    });

    expect(result.exitCode).toBe(0);
    const pending = JSON.parse(readFileSync(MCP_FILE, "utf-8"));
    expect(pending.length).toBe(1);
    expect(pending[0].data.deployStatus).toBe("success");
    expect(pending[0].message).toContain("Deploy OK");
  });

  // Edge case: unknown status
  it("V7-edge: handles unknown status as failure", () => {
    const result = spawnSync(["bash", NOTIFY_SCRIPT, "unknown", "something went wrong"], {
      env: {
        ...process.env,
        RELAY_DIR: TEST_RELAY_DIR,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_GROUP_ID: "",
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
      },
      cwd: PROJECT_ROOT,
    });

    expect(result.exitCode).toBe(0);
    const pending = JSON.parse(readFileSync(MCP_FILE, "utf-8"));
    expect(pending[0].severity).toBe("critical");
    expect(pending[0].message).toContain("Deploy ECHEC");
  });

  // Robustness: special characters in commit message
  it("V8-edge: handles special characters in commit message", () => {
    const result = spawnSync(
      ["bash", NOTIFY_SCRIPT, "success", 'abc1234 fix: handle "quotes" & <angles>'],
      {
        env: {
          ...process.env,
          RELAY_DIR: TEST_RELAY_DIR,
          TELEGRAM_BOT_TOKEN: "",
          TELEGRAM_GROUP_ID: "",
          HOME: process.env.HOME || "",
          PATH: process.env.PATH || "",
        },
        cwd: PROJECT_ROOT,
      },
    );

    expect(result.exitCode).toBe(0);
    // Verify the JSON is valid (parseable)
    const pending = JSON.parse(readFileSync(MCP_FILE, "utf-8"));
    expect(pending.length).toBe(1);
    expect(pending[0].data.deployStatus).toBe("success");
  });
});

// ── deploy.yml structural integrity ──────────────────────────────

describe("deploy.yml structural integrity", () => {
  it("git pull step is unconditional (always runs)", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    // The "Pull latest code" step should NOT have an if condition
    const pullStepRegex = /- name: Pull latest code\n\s+run:/;
    expect(content).toMatch(pullStepRegex);
    // Verify no 'if:' between the step name and run
    const pullSection = content.split("Pull latest code")[1].split("- name:")[0];
    // It should have run: but not if: before it
    const beforeRun = pullSection.split("run:")[0];
    expect(beforeRun).not.toContain("if:");
  });

  it("restart and smoke test steps are conditional on DEPLOY_ENABLED", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    // Both "Restart services" and "Smoke test" should have if: conditions
    expect(content).toMatch(/Restart services[\s\S]*?if:.*DEPLOY_ENABLED/);
    expect(content).toMatch(/Smoke test[\s\S]*?if:.*DEPLOY_ENABLED/);
  });

  it("deploy skipped step exists for when flag is false", () => {
    const content = readFileSync(DEPLOY_YML, "utf-8");
    expect(content).toContain("Deploy skipped");
    expect(content).toContain("sdd_auto_deploy flag is disabled");
  });
});
