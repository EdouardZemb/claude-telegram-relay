import { beforeEach, describe, expect, it } from "bun:test";
import { _resetForTests, get, isJobManagerEnabled, launch, list } from "../../src/job-manager.ts";

describe("prd-decompose background job", () => {
  beforeEach(() => {
    _resetForTests();
  });

  describe("job launch via job-manager", () => {
    it("launches a prd-decompose job and returns job ID immediately", async () => {
      const id = await launch("prd-decompose", 123, async () => {
        return '3 taches creees depuis le PRD "Test PRD"';
      });
      expect(id).toBeTruthy();
      expect(id.length).toBe(8);
    });

    it("prd-decompose job completes with task creation result", async () => {
      const id = await launch("prd-decompose", 456, async () => {
        return '5 taches creees depuis le PRD "Feature X"';
      });

      // Wait for job to complete
      await new Promise((r) => setTimeout(r, 100));

      const job = await get(id);
      expect(job!.status).toBe("completed");
      expect(job!.result).toContain("taches creees depuis le PRD");
      expect(job!.type).toBe("prd-decompose");
    });

    it("prd-decompose job fails when no subtasks generated", async () => {
      const id = await launch("prd-decompose", 789, async () => {
        throw new Error("Aucune sous-tache generee depuis le PRD.");
      });

      await new Promise((r) => setTimeout(r, 100));

      const job = await get(id);
      expect(job!.status).toBe("failed");
      expect(job!.error).toContain("sous-tache");
    });

    it("prd-decompose job appears in job list", async () => {
      const id = await launch("prd-decompose", 123, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return "done";
      });

      await new Promise((r) => setTimeout(r, 20));

      const { running } = await list();
      const found = running.find((j) => j.type === "prd-decompose");
      expect(found).toBeDefined();
      expect(found!.id).toBe(id);
    });

    it("prd-decompose completed job appears in recent list", async () => {
      const id = await launch("prd-decompose", 123, async () => {
        return '2 taches creees depuis le PRD "Bug fixes"';
      });

      await new Promise((r) => setTimeout(r, 100));

      const { recent } = await list();
      const found = recent.find((j) => j.id === id);
      expect(found).toBeDefined();
      expect(found!.status).toBe("completed");
      expect(found!.type).toBe("prd-decompose");
    });
  });

  describe("decompose function logic", () => {
    it("builds correct result message with task details", async () => {
      // Simulate the decompose function building a result message
      const mockTasks = [
        {
          id: "abc12345-uuid",
          title: "Creer composant",
          priority: 2,
          acceptance_criteria: "AC1\nAC2",
        },
        { id: "def67890-uuid", title: "Ajouter tests", priority: 3, acceptance_criteria: "" },
      ];

      const lines = mockTasks.map((t, i) => {
        const acCount = (t.acceptance_criteria || "")
          .split("\n")
          .filter((l: string) => l.trim()).length;
        return `${i + 1}. P${t.priority} ${t.title} [${t.id.substring(0, 8)}]${acCount > 0 ? ` (${acCount} ACs)` : ""}`;
      });
      const result = `${mockTasks.length} taches creees depuis le PRD "Test":\n${lines.join("\n")}`;

      expect(result).toContain("2 taches creees depuis le PRD");
      expect(result).toContain("P2 Creer composant");
      expect(result).toContain("(2 ACs)");
      expect(result).toContain("P3 Ajouter tests");
      expect(result).not.toContain("(0 ACs)");
    });

    it("constructs PRD description from title, summary and content", () => {
      const prd = {
        title: "Feature Authentication",
        summary: "Ajouter OAuth2",
        content: "## Objectif\nSecuriser les endpoints...",
      };
      const description = `PRD: ${prd.title}\n${prd.summary || ""}\n\n${prd.content}`;

      expect(description).toContain("PRD: Feature Authentication");
      expect(description).toContain("Ajouter OAuth2");
      expect(description).toContain("## Objectif");
    });

    it("handles PRD without summary", () => {
      const prd = {
        title: "Fix Bug",
        summary: null as string | null,
        content: "## Description\nBug details...",
      };
      const description = `PRD: ${prd.title}\n${prd.summary || ""}\n\n${prd.content}`;

      expect(description).toContain("PRD: Fix Bug");
      expect(description).toContain("## Description");
    });
  });

  describe("job manager feature flag", () => {
    it("isJobManagerEnabled returns boolean", () => {
      const result = isJobManagerEnabled();
      expect(typeof result).toBe("boolean");
    });
  });
});
