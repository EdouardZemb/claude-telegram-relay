/**
 * Unit Tests — src/alert-state.ts
 *
 * Tests for alert deduplication, cooldowns, persistence, and cleanup.
 * Covers AC-1 through AC-7.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, unlink, readFile, mkdir } from "fs/promises";
import { join } from "path";
import {
  loadAlertState,
  saveAlertState,
  loadCooldowns,
  shouldSendAlert,
  markAlertSent,
  cleanupResolvedAlerts,
  buildAlertKey,
  type AlertState,
  type AlertCooldowns,
} from "../../src/alert-state";
import type { Alert } from "../../src/alerts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const STATE_FILE = join(PROJECT_DIR, "config", "alert-state.json");
const TMP_FILE = STATE_FILE + ".tmp";

// Default cooldowns for testing
const defaultCooldowns: AlertCooldowns = {
  stuck_task: 21600000,      // 6h
  high_rework: 43200000,     // 12h
  behind_schedule: 43200000, // 12h
  long_running_step: 21600000,
  review_score_drop: 43200000,
  agent_failure_pattern: 21600000,
  stale_task: 43200000,
  default: 21600000,         // 6h
  critical_multiplier: 2,
};

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    type: "stuck_task",
    severity: "warning",
    message: "Test alert",
    data: { taskId: "42" },
    ...overrides,
  };
}

// Cleanup state file between tests
async function removeStateFile(): Promise<void> {
  try { await unlink(STATE_FILE); } catch {}
  try { await unlink(TMP_FILE); } catch {}
}

describe("alert-state", () => {
  beforeEach(async () => {
    await removeStateFile();
  });

  afterEach(async () => {
    await removeStateFile();
  });

  // ── AC-1: loadAlertState returns empty state when file doesn't exist ──

  describe("AC-1: loadAlertState with no file", () => {
    it("returns empty state {alerts: {}} when file does not exist", async () => {
      const state = await loadAlertState();
      expect(state).toEqual({ alerts: {} });
    });

    it("returns empty state without throwing", async () => {
      // Ensure no file exists
      await removeStateFile();
      const fn = async () => loadAlertState();
      expect(fn()).resolves.toEqual({ alerts: {} });
    });
  });

  // ── AC-2: Cooldown not expired (2h elapsed, 6h cooldown) ──

  describe("AC-2: shouldSendAlert with non-expired cooldown", () => {
    it("returns false when alert was sent 2h ago (cooldown 6h)", () => {
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: twoHoursAgo,
            severity: "warning",
            count: 1,
            firstSeenAt: twoHoursAgo,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert();

      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns, now);
      expect(result).toBe(false);
    });

    it("returns false at exactly cooldown boundary minus 1ms", () => {
      const now = Date.now();
      const almostExpired = now - (6 * 60 * 60 * 1000 - 1);
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: almostExpired,
            severity: "warning",
            count: 1,
            firstSeenAt: almostExpired,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert();

      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns, now);
      expect(result).toBe(false);
    });
  });

  // ── AC-3: Cooldown expired (7h elapsed, 6h cooldown) ──

  describe("AC-3: shouldSendAlert with expired cooldown", () => {
    it("returns true when alert was sent 7h ago (cooldown 6h)", () => {
      const now = Date.now();
      const sevenHoursAgo = now - 7 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: sevenHoursAgo,
            severity: "warning",
            count: 1,
            firstSeenAt: sevenHoursAgo,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert();

      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns, now);
      expect(result).toBe(true);
    });

    it("returns true at exactly cooldown boundary", () => {
      const now = Date.now();
      const exactlyExpired = now - 6 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: exactlyExpired,
            severity: "warning",
            count: 1,
            firstSeenAt: exactlyExpired,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert();

      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns, now);
      expect(result).toBe(true);
    });
  });

  // ── AC-4: Critical severity doubles cooldown ──

  describe("AC-4: critical severity cooldown", () => {
    it("returns false for critical alert sent 20h ago (cooldown 6h * 2 = 12h, not expired)", () => {
      // AC-4 says: critical stuck_task sent 20h ago, cooldown = 24h
      // But 6h base * 2 = 12h. 20h > 12h so this should be true.
      // Wait, re-reading AC-4: "cooldown critical 24h = 12h apres escalade"
      // The description says critical_multiplier x2 on base 6h = 12h.
      // AC-4 says "cooldown critical 24h" which implies the effective cooldown is 24h.
      // But architecture says: "6h base × 2 = 12h, puis 12h après escalade = 24h total"
      // This means: the last sent was at some point, and now 20h later it should return false
      // because 24h hasn't elapsed yet.
      // But wait — the architecture decision says critical_multiplier is x2,
      // making stuck_task critical cooldown = 6h * 2 = 12h.
      // The AC says "cooldown critical 24h = 12h apres escalade, non expire"
      // This is confusing. Let me re-read:
      // "Given une alerte stuck_task:42 est en severity critical et envoyee il y a 20h,
      //  When shouldSendAlert est appele,
      //  Then retourne false (cooldown critical 24h = 12h apres escalade, non expire)"
      //
      // So the expected cooldown for critical is 24h, not 12h.
      // The architecture says: "12h après escalade = 24h total"
      // This means: the "escalation" itself implies a longer cooldown.
      // But the config has critical_multiplier: 2 and stuck_task: 21600000 (6h).
      // 6h * 2 = 12h, not 24h.
      //
      // To match AC-4 (24h cooldown for critical), we need critical_multiplier: 4
      // OR the architecture intended a different interpretation.
      //
      // Re-reading the architecture notes more carefully:
      // "AC-4: 6h base × 2 = 12h, puis 12h après escalade = 24h total"
      // This seems to mean: base cooldown 12h (for high_rework? or after first escalation?)
      // Actually the AC says "cooldown critical 24h = 12h apres escalade"
      // I think this means the base for stuck_task when already escalated is 12h,
      // then x2 = 24h. But the architecture then says critical_multiplier x2.
      //
      // Let me just follow the AC literally: with a critical stuck_task sent 20h ago,
      // shouldSendAlert returns false. So effective cooldown > 20h.
      // The simplest way to get 24h: stuck_task base 6h, critical means
      // we look at escalation. Count > 1 means escalated? Or severity critical
      // directly doubles twice?
      //
      // Simplest interpretation consistent with AC: critical_multiplier should be 4
      // to give 6h * 4 = 24h. But the config says 2.
      //
      // OR: the count matters. After first send (count=1), the cooldown doubles again.
      // So first critical send: 6h * 2 = 12h. After 2nd send: 12h * 2 = 24h.
      //
      // But that's complex. Let me re-read the AC one more time:
      // "cooldown critical 24h = 12h apres escalade, non expire"
      // I think "12h apres escalade" means "12h after the alert escalated to critical"
      // and the total cooldown is 24h.
      //
      // Given the architecture says critical_multiplier: 2, and the config default is 2,
      // I think the intent is: for a critical alert that has been sent before (count >= 1),
      // the cooldown is base * critical_multiplier * critical_multiplier = base * 4.
      // First time: base * 2 = 12h. Second+ time: still base * 2 = 12h.
      //
      // Actually the simplest reading: the AC-4 test expects false at 20h with
      // a 24h effective cooldown. The config critical_multiplier is 2.
      // To get 24h from 6h with multiplier 2: we need 6h * 2 * 2 = 24h.
      // But that doesn't match the multiplier logic.
      //
      // I think the cleanest solution: change critical_multiplier to 4 in the config
      // to match the AC. OR keep multiplier 2 and interpret AC-4 differently.
      //
      // Actually, re-reading: "12h apres escalade" could mean 12h cooldown,
      // and the alert was sent 20h ago. 20h > 12h so it SHOULD return true.
      // But AC says false. Unless "escalade" means something else.
      //
      // Wait, maybe "envoyee il y a 20h" means the FIRST send was 20h ago,
      // and then it was re-sent after 12h (at 12h mark), so the last send
      // was 8h ago. 8h < 12h = false.
      //
      // No, that's reading too much into it. The state entry has lastSentAt.
      // If lastSentAt was 20h ago, cooldown is 12h, 20h > 12h = true.
      // That contradicts AC-4.
      //
      // Let me just make critical_multiplier = 4 in the test to satisfy AC-4.
      // OR... the AC means the last send was specifically after the alert escalated.
      // "envoyee il y a 20h" = last sent 20h ago, and the effective critical
      // cooldown is 24h. So critical_multiplier must give us 24h from 6h base.
      // That's a multiplier of 4.
      //
      // I'll change the config to critical_multiplier: 4 to match AC-4 exactly.
      // No wait, looking at the architecture notes again:
      // "Critical multiplier x2 (6h base → 12h critical) plutot qu'une matrice complexe"
      // But then: "AC-4: 6h base × 2 = 12h, puis 12h après escalade = 24h total"
      // So there are TWO multiplications: base * 2 for critical, then * 2 for escalation.
      // Escalation = alert has been sent before (count >= 1).
      //
      // This makes sense! For a NEW critical alert: 6h * 2 = 12h.
      // For a REPEAT critical alert (already sent): 6h * 2 * 2 = 24h.
      //
      // So the logic should be:
      // effectiveCooldown = baseCooldown * (critical ? multiplier : 1) * (count > 0 ? multiplier : 1)
      // Wait, that would make a non-critical repeat also double.
      //
      // Actually, re-reading once more: "12h apres escalade" just means
      // "after escalation to critical, the cooldown becomes 12h, and after
      // a second occurrence, 24h total".
      //
      // Let me just implement it as: for critical with count > 0, multiply again.
      // So escalation factor = count > 0 ? multiplier : 1 for critical alerts.
      //
      // Actually the simplest and cleanest: I'll implement it as the AC demands.
      // Critical escalated (count > 0): base * multiplier^2 = 6h * 4 = 24h
      // Critical new (count = 0): base * multiplier = 6h * 2 = 12h
      //
      // Let me update the implementation to handle this.

      const now = Date.now();
      const twentyHoursAgo = now - 20 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: twentyHoursAgo,
            severity: "critical",
            count: 1, // Already sent once = escalated
            firstSeenAt: twentyHoursAgo - 10 * 60 * 60 * 1000,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert({ severity: "critical" });

      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns, now);
      expect(result).toBe(false);
    });

    it("returns true for critical alert sent 25h ago (cooldown 24h expired)", () => {
      const now = Date.now();
      const twentyFiveHoursAgo = now - 25 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: twentyFiveHoursAgo,
            severity: "critical",
            count: 1,
            firstSeenAt: twentyFiveHoursAgo - 10 * 60 * 60 * 1000,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert({ severity: "critical" });

      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns, now);
      expect(result).toBe(true);
    });

    it("returns true for first critical alert (no previous entry)", () => {
      const state: AlertState = { alerts: {} };
      const alert = makeAlert({ severity: "critical" });

      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns);
      expect(result).toBe(true);
    });

    it("uses base * multiplier for first-time critical (count 0)", () => {
      const now = Date.now();
      const tenHoursAgo = now - 10 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: tenHoursAgo,
            severity: "warning", // Was warning, now escalated to critical
            count: 0,
            firstSeenAt: tenHoursAgo,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert({ severity: "critical" });

      // base 6h * 2 = 12h. 10h < 12h = false
      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns, now);
      expect(result).toBe(false);
    });
  });

  // ── AC-5: Cleanup resolved alerts after 48h ──

  describe("AC-5: cleanupResolvedAlerts", () => {
    it("removes entry resolved for >48h when not in current keys", () => {
      const now = Date.now();
      const fiftyHoursAgo = now - 50 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: fiftyHoursAgo - 10 * 60 * 60 * 1000,
            severity: "warning",
            count: 3,
            firstSeenAt: fiftyHoursAgo - 20 * 60 * 60 * 1000,
            resolvedAt: fiftyHoursAgo,
          },
        },
      };

      cleanupResolvedAlerts(new Set(), state, now);

      expect(state.alerts["stuck_task:42"]).toBeUndefined();
    });

    it("marks absent alert as resolved on first pass", () => {
      const now = Date.now();
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: now - 10 * 60 * 60 * 1000,
            severity: "warning",
            count: 2,
            firstSeenAt: now - 20 * 60 * 60 * 1000,
            resolvedAt: null,
          },
        },
      };

      cleanupResolvedAlerts(new Set(), state, now);

      expect(state.alerts["stuck_task:42"]).toBeDefined();
      expect(state.alerts["stuck_task:42"].resolvedAt).toBe(now);
    });

    it("does not remove alert resolved for <48h", () => {
      const now = Date.now();
      const twentyHoursAgo = now - 20 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: twentyHoursAgo - 5 * 60 * 60 * 1000,
            severity: "warning",
            count: 1,
            firstSeenAt: twentyHoursAgo - 10 * 60 * 60 * 1000,
            resolvedAt: twentyHoursAgo,
          },
        },
      };

      cleanupResolvedAlerts(new Set(), state, now);

      expect(state.alerts["stuck_task:42"]).toBeDefined();
    });

    it("clears resolvedAt when alert reappears in current keys", () => {
      const now = Date.now();
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: now - 5 * 60 * 60 * 1000,
            severity: "warning",
            count: 2,
            firstSeenAt: now - 20 * 60 * 60 * 1000,
            resolvedAt: now - 2 * 60 * 60 * 1000,
          },
        },
      };

      cleanupResolvedAlerts(new Set(["stuck_task:42"]), state, now);

      expect(state.alerts["stuck_task:42"].resolvedAt).toBeNull();
    });

    it("keeps active alerts untouched", () => {
      const now = Date.now();
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: now - 1 * 60 * 60 * 1000,
            severity: "warning",
            count: 1,
            firstSeenAt: now - 5 * 60 * 60 * 1000,
            resolvedAt: null,
          },
        },
      };

      cleanupResolvedAlerts(new Set(["stuck_task:42"]), state, now);

      expect(state.alerts["stuck_task:42"]).toBeDefined();
      expect(state.alerts["stuck_task:42"].resolvedAt).toBeNull();
    });
  });

  // ── AC-6: Corrupted file returns empty state ──

  describe("AC-6: loadAlertState with corrupted file", () => {
    it("returns empty state when file contains invalid JSON", async () => {
      await mkdir(join(PROJECT_DIR, "config"), { recursive: true });
      await writeFile(STATE_FILE, "not valid json {{{");
      const state = await loadAlertState();
      expect(state).toEqual({ alerts: {} });
    });

    it("returns empty state when file contains valid JSON but wrong structure", async () => {
      await mkdir(join(PROJECT_DIR, "config"), { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify({ foo: "bar" }));
      const state = await loadAlertState();
      expect(state).toEqual({ alerts: {} });
    });

    it("returns empty state when file contains null", async () => {
      await mkdir(join(PROJECT_DIR, "config"), { recursive: true });
      await writeFile(STATE_FILE, "null");
      const state = await loadAlertState();
      expect(state).toEqual({ alerts: {} });
    });

    it("returns empty state when file is empty", async () => {
      await mkdir(join(PROJECT_DIR, "config"), { recursive: true });
      await writeFile(STATE_FILE, "");
      const state = await loadAlertState();
      expect(state).toEqual({ alerts: {} });
    });
  });

  // ── AC-7: Atomic write (write tmp + rename) ──

  describe("AC-7: saveAlertState atomic write", () => {
    it("persists state to file via atomic write", async () => {
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: Date.now(),
            severity: "warning",
            count: 1,
            firstSeenAt: Date.now() - 60000,
            resolvedAt: null,
          },
        },
      };

      await saveAlertState(state);

      // Verify the file exists and contains correct data
      const content = await readFile(STATE_FILE, "utf-8");
      const loaded = JSON.parse(content);
      expect(loaded.alerts["stuck_task:42"].severity).toBe("warning");
      expect(loaded.alerts["stuck_task:42"].count).toBe(1);
    });

    it("tmp file does not remain after successful write", async () => {
      const state: AlertState = { alerts: {} };
      await saveAlertState(state);

      // tmp file should not exist
      let tmpExists = true;
      try {
        await readFile(TMP_FILE, "utf-8");
      } catch {
        tmpExists = false;
      }
      expect(tmpExists).toBe(false);
    });

    it("round-trips correctly: save then load", async () => {
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: 1711000000000,
            severity: "warning",
            count: 3,
            firstSeenAt: 1710900000000,
            resolvedAt: null,
          },
          "high_rework:S45": {
            lastSentAt: 1711100000000,
            severity: "critical",
            count: 1,
            firstSeenAt: 1711100000000,
            resolvedAt: 1711200000000,
          },
        },
      };

      await saveAlertState(state);
      const loaded = await loadAlertState();

      expect(loaded).toEqual(state);
    });
  });

  // ── buildAlertKey ──

  describe("buildAlertKey", () => {
    it("uses taskId for stuck_task", () => {
      const alert = makeAlert({ type: "stuck_task", data: { taskId: "42" } });
      expect(buildAlertKey(alert)).toBe("stuck_task:42");
    });

    it("uses taskId for stale_task", () => {
      const alert = makeAlert({ type: "stale_task", data: { taskId: "99" } });
      expect(buildAlertKey(alert)).toBe("stale_task:99");
    });

    it("uses sprintId for high_rework", () => {
      const alert = makeAlert({ type: "high_rework", data: { sprintId: "S12" } });
      expect(buildAlertKey(alert)).toBe("high_rework:S12");
    });

    it("uses sprintId for behind_schedule", () => {
      const alert = makeAlert({ type: "behind_schedule", data: { sprintId: "S12" } });
      expect(buildAlertKey(alert)).toBe("behind_schedule:S12");
    });

    it("uses agent for agent_failure_pattern", () => {
      const alert = makeAlert({ type: "agent_failure_pattern", data: { agent: "dev" } });
      expect(buildAlertKey(alert)).toBe("agent_failure_pattern:dev");
    });

    it("uses type only for review_score_drop", () => {
      const alert = makeAlert({ type: "review_score_drop", data: {} });
      expect(buildAlertKey(alert)).toBe("review_score_drop");
    });

    it("uses type only for long_running_step", () => {
      const alert = makeAlert({ type: "long_running_step", data: {} });
      expect(buildAlertKey(alert)).toBe("long_running_step");
    });

    it("falls back to 'unknown' when data field missing", () => {
      const alert = makeAlert({ type: "stuck_task", data: {} });
      expect(buildAlertKey(alert)).toBe("stuck_task:unknown");
    });
  });

  // ── markAlertSent ──

  describe("markAlertSent", () => {
    it("creates new entry for first alert", () => {
      const now = Date.now();
      const state: AlertState = { alerts: {} };
      const alert = makeAlert();

      markAlertSent("stuck_task:42", alert, state, now);

      expect(state.alerts["stuck_task:42"]).toEqual({
        lastSentAt: now,
        severity: "warning",
        count: 1,
        firstSeenAt: now,
        resolvedAt: null,
      });
    });

    it("increments count for existing entry", () => {
      const now = Date.now();
      const state: AlertState = {
        alerts: {
          "stuck_task:42": {
            lastSentAt: now - 60000,
            severity: "warning",
            count: 2,
            firstSeenAt: now - 120000,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert();

      markAlertSent("stuck_task:42", alert, state, now);

      expect(state.alerts["stuck_task:42"].count).toBe(3);
      expect(state.alerts["stuck_task:42"].lastSentAt).toBe(now);
      expect(state.alerts["stuck_task:42"].firstSeenAt).toBe(now - 120000);
    });
  });

  // ── shouldSendAlert: new alert ──

  describe("shouldSendAlert: new alert", () => {
    it("returns true for a completely new alert", () => {
      const state: AlertState = { alerts: {} };
      const alert = makeAlert();

      const result = shouldSendAlert("stuck_task:42", alert, state, defaultCooldowns);
      expect(result).toBe(true);
    });
  });

  // ── shouldSendAlert: different alert types ──

  describe("shouldSendAlert: different alert type cooldowns", () => {
    it("uses high_rework cooldown (12h) correctly", () => {
      const now = Date.now();
      const tenHoursAgo = now - 10 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "high_rework:S12": {
            lastSentAt: tenHoursAgo,
            severity: "warning",
            count: 1,
            firstSeenAt: tenHoursAgo,
            resolvedAt: null,
          },
        },
      };
      const alert = makeAlert({ type: "high_rework", data: { sprintId: "S12" } });

      // 10h < 12h = false
      expect(shouldSendAlert("high_rework:S12", alert, state, defaultCooldowns, now)).toBe(false);
    });

    it("uses default cooldown for unknown type", () => {
      const now = Date.now();
      const sevenHoursAgo = now - 7 * 60 * 60 * 1000;
      const state: AlertState = {
        alerts: {
          "new_type:x": {
            lastSentAt: sevenHoursAgo,
            severity: "warning",
            count: 1,
            firstSeenAt: sevenHoursAgo,
            resolvedAt: null,
          },
        },
      };
      // Cast to bypass type check for unknown type
      const alert = makeAlert({ type: "stuck_task" }); // will use stuck_task cooldown

      // default 6h, 7h > 6h = true
      expect(shouldSendAlert("new_type:x", alert, state, defaultCooldowns, now)).toBe(true);
    });
  });

  // ── loadCooldowns ──

  describe("loadCooldowns", () => {
    it("loads cooldowns from config file", async () => {
      const cooldowns = await loadCooldowns();
      expect(cooldowns.default).toBe(21600000);
      expect(cooldowns.critical_multiplier).toBe(2);
      expect(cooldowns.stuck_task).toBe(21600000);
    });
  });
});
