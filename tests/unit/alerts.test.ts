/**
 * Unit Tests — src/alerts.ts
 *
 * Tests for proactive alert detection and formatting.
 */

import { describe, expect, it } from "bun:test";
import {
  checkReworkRate,
  checkSprintPace,
  checkStuckTasks,
  formatAlerts,
  runAllChecks,
} from "../../src/alerts";
import { createMockSupabase } from "../fixtures/mock-supabase";

describe("Stuck Task Detection", () => {
  it("detects tasks stuck for too long", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const supabase = createMockSupabase({
      tasks: [
        {
          id: "t1",
          title: "Stuck task",
          status: "in_progress",
          updated_at: twoDaysAgo,
          sprint: "S12",
        },
      ],
    });

    const alerts = await checkStuckTasks(supabase, {
      stuckThresholdHours: 24,
      reworkThresholdPercent: 40,
      scheduleCheckEnabled: true,
    });
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe("stuck_task");
    expect(alerts[0].data.title).toBe("Stuck task");
  });

  it("does not flag recent tasks", async () => {
    const now = new Date().toISOString();
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Active task", status: "in_progress", updated_at: now, sprint: "S12" },
      ],
    });

    const alerts = await checkStuckTasks(supabase, {
      stuckThresholdHours: 24,
      reworkThresholdPercent: 40,
      scheduleCheckEnabled: true,
    });
    expect(alerts.length).toBe(0);
  });

  it("ignores non-in_progress tasks", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Done task", status: "done", updated_at: twoDaysAgo, sprint: "S12" },
        {
          id: "t2",
          title: "Backlog task",
          status: "backlog",
          updated_at: twoDaysAgo,
          sprint: "S12",
        },
      ],
    });

    const alerts = await checkStuckTasks(supabase);
    expect(alerts.length).toBe(0);
  });
});

describe("Rework Rate Detection", () => {
  it("detects high rework rate", async () => {
    const supabase = createMockSupabase({
      workflow_logs: [
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-01" },
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-02" },
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-03" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-04" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-05" },
      ],
    });

    const alerts = await checkReworkRate(supabase, "S12", {
      stuckThresholdHours: 24,
      reworkThresholdPercent: 40,
      scheduleCheckEnabled: true,
    });
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe("high_rework");
    expect(alerts[0].data.reworkRate).toBe(60);
  });

  it("does not alert on low rework rate", async () => {
    const supabase = createMockSupabase({
      workflow_logs: [
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-01" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-02" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-03" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-04" },
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-05" },
      ],
    });

    const alerts = await checkReworkRate(supabase, "S12");
    expect(alerts.length).toBe(0);
  });

  it("requires minimum data points", async () => {
    const supabase = createMockSupabase({
      workflow_logs: [
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-01" },
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-02" },
      ],
    });

    const alerts = await checkReworkRate(supabase, "S12");
    expect(alerts.length).toBe(0);
  });
});

describe("Sprint Pace Detection", () => {
  it("detects behind-schedule sprint", async () => {
    // Sprint started 5 days ago with 10 tasks, only 1 done
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", status: "done", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t2", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t3", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t4", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t5", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t6", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t7", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t8", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t9", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
        { id: "t10", status: "backlog", sprint: "S12", created_at: fiveDaysAgo },
      ],
    });

    const alerts = await checkSprintPace(supabase, "S12");
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe("behind_schedule");
  });

  it("does not alert on healthy pace", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", status: "done", sprint: "S12", created_at: threeDaysAgo },
        { id: "t2", status: "done", sprint: "S12", created_at: threeDaysAgo },
        { id: "t3", status: "in_progress", sprint: "S12", created_at: threeDaysAgo },
        { id: "t4", status: "backlog", sprint: "S12", created_at: threeDaysAgo },
      ],
    });

    const alerts = await checkSprintPace(supabase, "S12");
    expect(alerts.length).toBe(0);
  });
});

describe("runAllChecks", () => {
  it("combines all alert types", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Stuck", status: "in_progress", updated_at: twoDaysAgo, sprint: "S12" },
      ],
      workflow_logs: [
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-01" },
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-02" },
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-03" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-04" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-05" },
      ],
    });

    const alerts = await runAllChecks(supabase, "S12");
    expect(alerts.length).toBeGreaterThanOrEqual(2); // At least stuck + rework
  });

  it("works without sprint ID", async () => {
    const supabase = createMockSupabase({ tasks: [] });
    const alerts = await runAllChecks(supabase);
    expect(alerts.length).toBe(0);
  });
});

describe("Alert Formatting", () => {
  it("formats alerts with severity icons", () => {
    const result = formatAlerts([
      { type: "stuck_task", severity: "critical", message: "Tache bloquee", data: {} },
      { type: "high_rework", severity: "warning", message: "Rework eleve", data: {} },
    ]);

    expect(result).toContain("2 alertes");
    expect(result).toContain("!! Tache bloquee");
    expect(result).toContain("! Rework eleve");
  });

  it("formats empty alerts", () => {
    const result = formatAlerts([]);
    expect(result).toContain("Aucune alerte");
  });

  // V13: formatAlerts escapes dynamic message content
  it("V13: formatAlerts escapes HTML special chars in alert messages", () => {
    const result = formatAlerts([
      { type: "stuck_task", severity: "critical", message: "a <b> c", data: {} },
    ]);
    expect(result).toContain("a &lt;b&gt; c");
    expect(result).not.toContain("a <b> c");
  });

  // V13-spec: header uses <b> HTML tag
  it("V13-spec: formatAlerts uses <b> for alert count header", () => {
    const result = formatAlerts([
      { type: "stuck_task", severity: "critical", message: "Test", data: {} },
    ]);
    expect(result).toContain("<b>");
    expect(result).toContain("alerte");
  });
});
