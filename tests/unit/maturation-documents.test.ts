import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  _setBaseDirForTests,
  getMaturationDir,
  getRunDir,
  initRun,
  listRuns,
  loadRunMeta,
  readDocument,
  saveRunMeta,
  writeDocument,
} from "../../src/maturation/documents.ts";
import { createEmptyRun } from "../../src/maturation/types.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-maturation-docs");

describe("maturation/documents", () => {
  beforeEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await mkdir(TEST_DIR, { recursive: true });
    _setBaseDirForTests(TEST_DIR);
  });

  afterEach(async () => {
    _setBaseDirForTests(undefined);
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("getMaturationDir", () => {
    it("V1: returns .maturation path under base dir", () => {
      expect(getMaturationDir()).toBe(join(TEST_DIR, ".maturation"));
    });
  });

  describe("getRunDir", () => {
    it("V1: returns runs/<id> path", () => {
      expect(getRunDir("abc-123")).toBe(join(TEST_DIR, ".maturation", "runs", "abc-123"));
    });
  });

  describe("initRun", () => {
    it("V1: creates run directory and meta.json", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      const meta = await loadRunMeta(run.id);
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("test");
    });
  });

  describe("writeDocument / readDocument", () => {
    it("V1: writes and reads markdown document", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      await writeDocument(run.id, "UNDERSTANDING", "# Understanding\n\nContent here.");
      const content = await readDocument(run.id, "UNDERSTANDING");
      expect(content).toBe("# Understanding\n\nContent here.");
    });

    it("V2: returns null for missing document", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      const content = await readDocument(run.id, "EXPAND");
      expect(content).toBeNull();
    });
  });

  describe("saveRunMeta / loadRunMeta", () => {
    it("V1: persists and loads run state atomically", async () => {
      const run = createEmptyRun(1, undefined, "test", "input");
      await initRun(run);
      run.currentPhase = "explore";
      run.steps.understand.status = "ok";
      await saveRunMeta(run);
      const loaded = await loadRunMeta(run.id);
      expect(loaded!.currentPhase).toBe("explore");
      expect(loaded!.steps.understand.status).toBe("ok");
    });

    it("V2: returns null for nonexistent run", async () => {
      const loaded = await loadRunMeta("nonexistent");
      expect(loaded).toBeNull();
    });
  });

  describe("listRuns", () => {
    it("V1: lists all run IDs sorted by createdAt desc", async () => {
      const run1 = createEmptyRun(1, undefined, "first", "a");
      const run2 = createEmptyRun(1, undefined, "second", "b");
      await initRun(run1);
      await initRun(run2);
      const runs = await listRuns();
      expect(runs.length).toBe(2);
    });

    it("V2: returns empty array if no runs", async () => {
      const runs = await listRuns();
      expect(runs).toEqual([]);
    });
  });
});
