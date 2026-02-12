/**
 * Unit Tests — src/profile-evolution.ts
 *
 * Tests for profile analysis and formatting.
 */

import { describe, it, expect } from "bun:test";
import {
  formatProfileInsights,
  formatProfileUpdates,
  type ProfileInsights,
  type ProfileUpdate,
} from "../../src/profile-evolution";

describe("formatProfileInsights", () => {
  it("formats insights correctly", () => {
    const insights: ProfileInsights = {
      communicationStyle: {
        avgMessageLength: 45,
        prefersBrief: false,
        language: "francais",
      },
      activityPattern: {
        activeHours: [22, 23, 10],
        activeDays: ["mardi", "mercredi"],
        peakHour: 22,
      },
      taskPreferences: {
        topTaskTypes: [
          { type: "feature", count: 8 },
          { type: "fix", count: 3 },
        ],
        avgTasksPerSprint: 10,
        preferredPriority: 1,
      },
      workflowPreferences: {
        autonomyLevel: "high",
        checkpointOverrides: 2,
      },
    };

    const output = formatProfileInsights(insights);
    expect(output).toContain("Analyse du profil");
    expect(output).toContain("45 car.");
    expect(output).toContain("detaille");
    expect(output).toContain("francais");
    expect(output).toContain("22h");
    expect(output).toContain("feature (8)");
    expect(output).toContain("P1");
  });

  it("formats brief style correctly", () => {
    const insights: ProfileInsights = {
      communicationStyle: { avgMessageLength: 20, prefersBrief: true, language: "francais" },
      activityPattern: { activeHours: [9], activeDays: ["lundi"], peakHour: 9 },
      taskPreferences: { topTaskTypes: [], avgTasksPerSprint: 5, preferredPriority: 2 },
      workflowPreferences: { autonomyLevel: "medium", checkpointOverrides: 0 },
    };

    const output = formatProfileInsights(insights);
    expect(output).toContain("concis");
  });
});

describe("formatProfileUpdates", () => {
  it("formats empty updates", () => {
    const output = formatProfileUpdates([]);
    expect(output).toContain("Aucune mise a jour");
  });

  it("formats update proposals", () => {
    const updates: ProfileUpdate[] = [
      { field: "peak_hour", currentValue: "21h", proposedValue: "23h", reason: "Activite decalee" },
    ];

    const output = formatProfileUpdates(updates);
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });
});
