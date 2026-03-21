/**
 * Unit Tests — src/spec-lite.ts (P1)
 *
 * Tests for proto-spec generation: parsing, structure, edge cases, fallback.
 * V1: Valid ProtoSpec with 3-5 V-criteria.
 * V2: Default ProtoSpec on spawnClaude failure.
 */

import { describe, it, expect } from "bun:test";
import { parseProtoSpec } from "../../src/spec-lite";
import type { ProtoSpec } from "../../src/agent-schemas";

const mockTask = {
  id: "test-123",
  title: "Implement user authentication",
  description: "Add login/logout functionality",
  status: "backlog" as const,
  priority: 2,
  created_at: new Date().toISOString(),
  sprint: null,
  project_id: null,
  tags: [],
  acceptance_criteria: null,
  dev_notes: null,
};

describe("parseProtoSpec", () => {
  it("[V1] parses valid JSON proto-spec with V-criteria", () => {
    const output = JSON.stringify({
      objective: "Implement user authentication with login/logout",
      v_criteria: [
        { id: "V1", description: "Login returns a valid JWT token", level: "unit" },
        { id: "V2", description: "Logout invalidates the session", level: "integration" },
        { id: "V3", description: "Invalid credentials return 401", level: "unit" },
      ],
      impacted_files: ["src/auth.ts", "src/session.ts"],
    });

    const result = parseProtoSpec(output, mockTask, Date.now() - 1000);

    expect(result.objective).toBe("Implement user authentication with login/logout");
    expect(result.v_criteria).toHaveLength(3);
    expect(result.v_criteria[0].id).toBe("V1");
    expect(result.v_criteria[0].description).toBe("Login returns a valid JWT token");
    expect(result.v_criteria[0].level).toBe("unit");
    expect(result.v_criteria[1].level).toBe("integration");
    expect(result.impacted_files).toEqual(["src/auth.ts", "src/session.ts"]);
    expect(result.agent_model).toBe("claude-haiku-4-5");
    expect(result.generated_at).toBeTruthy();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("extracts JSON from mixed output", () => {
    const output = `Here is the proto-spec:
${JSON.stringify({
  objective: "Test objective",
  v_criteria: [
    { id: "V1", description: "Test criterion", level: "unit" },
    { id: "V2", description: "Another criterion", level: "E2E" },
    { id: "V3", description: "Third criterion", level: "integration" },
  ],
  impacted_files: ["src/test.ts"],
})}
End of spec.`;

    const result = parseProtoSpec(output, mockTask, Date.now());

    expect(result.objective).toBe("Test objective");
    expect(result.v_criteria).toHaveLength(3);
    expect(result.impacted_files).toEqual(["src/test.ts"]);
  });

  it("[V2] returns default proto-spec on unparseable output", () => {
    const result = parseProtoSpec("This is not JSON", mockTask, Date.now() - 500);

    expect(result.objective).toBe(mockTask.title);
    expect(result.v_criteria).toHaveLength(0);
    expect(result.impacted_files).toHaveLength(0);
    expect(result.agent_model).toBe("claude-haiku-4-5");
  });

  it("caps V-criteria at 5", () => {
    const output = JSON.stringify({
      objective: "Test",
      v_criteria: Array.from({ length: 8 }, (_, i) => ({
        id: `V${i + 1}`,
        description: `Criterion ${i + 1}`,
        level: "unit",
      })),
      impacted_files: [],
    });

    const result = parseProtoSpec(output, mockTask, Date.now());
    expect(result.v_criteria).toHaveLength(5);
  });

  it("normalizes invalid level values to 'unit'", () => {
    const output = JSON.stringify({
      objective: "Test",
      v_criteria: [
        { id: "V1", description: "Test", level: "invalid" },
        { id: "V2", description: "Test 2", level: "E2E" },
        { id: "V3", description: "Test 3", level: "unit" },
      ],
      impacted_files: [],
    });

    const result = parseProtoSpec(output, mockTask, Date.now());
    expect(result.v_criteria[0].level).toBe("unit"); // normalized
    expect(result.v_criteria[1].level).toBe("E2E"); // valid
  });

  it("filters out invalid V-criteria entries", () => {
    const output = JSON.stringify({
      objective: "Test",
      v_criteria: [
        { id: "V1", description: "Valid criterion", level: "unit" },
        { description: "Missing id" }, // no id
        "not an object",
        null,
        { id: "V4", description: "Another valid", level: "integration" },
        { id: "V5", description: "Third valid", level: "unit" },
      ],
      impacted_files: [],
    });

    const result = parseProtoSpec(output, mockTask, Date.now());
    // Only entries with both id and description survive
    expect(result.v_criteria.length).toBeGreaterThanOrEqual(2);
    expect(result.v_criteria[0].id).toBe("V1");
  });

  it("handles empty objective gracefully", () => {
    const output = JSON.stringify({
      objective: "",
      v_criteria: [
        { id: "V1", description: "Test", level: "unit" },
        { id: "V2", description: "Test 2", level: "unit" },
        { id: "V3", description: "Test 3", level: "unit" },
      ],
      impacted_files: [],
    });

    const result = parseProtoSpec(output, mockTask, Date.now());
    expect(result.objective).toBe("Objectif non specifie");
  });

  it("filters non-string entries from impacted_files", () => {
    const output = JSON.stringify({
      objective: "Test",
      v_criteria: [
        { id: "V1", description: "Test", level: "unit" },
        { id: "V2", description: "Test 2", level: "unit" },
        { id: "V3", description: "Test 3", level: "unit" },
      ],
      impacted_files: ["src/valid.ts", 42, null, "src/also-valid.ts"],
    });

    const result = parseProtoSpec(output, mockTask, Date.now());
    expect(result.impacted_files).toEqual(["src/valid.ts", "src/also-valid.ts"]);
  });

  it("records duration_ms from startTime", () => {
    const startTime = Date.now() - 2000;
    const output = JSON.stringify({
      objective: "Test",
      v_criteria: [
        { id: "V1", description: "Test", level: "unit" },
        { id: "V2", description: "Test 2", level: "unit" },
        { id: "V3", description: "Test 3", level: "unit" },
      ],
      impacted_files: [],
    });

    const result = parseProtoSpec(output, mockTask, startTime);
    expect(result.duration_ms).toBeGreaterThanOrEqual(1900);
  });
});
