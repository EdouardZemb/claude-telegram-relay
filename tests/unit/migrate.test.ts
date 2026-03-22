/**
 * @module migrate.test
 * @description Tests for scripts/migrate.ts — DB migration runner.
 * Covers: discovery, checksums, planning, idempotence, regex filtering.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  type AppliedMigration,
  BOOTSTRAP_SQL,
  computeChecksum,
  discoverMigrations,
  type MigrationFile,
  planMigrations,
  runMigrations,
} from "../../scripts/migrate.ts";

// ── Helpers ──────────────────────────────────────────────────

/** Create a temp directory with migration files */
async function createTempMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migrate-test-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** In-memory SQL executor that tracks calls and manages schema_migrations state */
function createMockExecutor() {
  const executedQueries: string[] = [];
  const appliedMigrations: AppliedMigration[] = [];
  let bootstrapped = false;

  return {
    executedQueries,
    appliedMigrations,

    async execute(sql: string): Promise<void> {
      executedQueries.push(sql);
      // Track bootstrap
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        bootstrapped = true;
      }
      // Track migration recordings
      const insertMatch = sql.match(
        /INSERT INTO schema_migrations \(version, name, checksum\) VALUES \('(\d{3})', '([^']+)', '([^']+)'\)/,
      );
      if (insertMatch) {
        appliedMigrations.push({
          version: insertMatch[1],
          name: insertMatch[2],
          checksum: insertMatch[3],
          applied_at: new Date().toISOString(),
        });
      }
    },

    async query<T>(_sql: string): Promise<T[]> {
      // Return current state of applied migrations
      return appliedMigrations as unknown as T[];
    },

    get isBootstrapped() {
      return bootstrapped;
    },
  };
}

// ── discoverMigrations ───────────────────────────────────────

describe("discoverMigrations", () => {
  test("finds NNN_name.sql files and ignores others", async () => {
    const dir = await createTempMigrations({
      "001_initial.sql": "-- initial",
      "002_add_column.sql": "-- add column",
      "migration-schema-sync.sql": "-- legacy",
      "llm-ops-schema.sql": "-- legacy",
      "README.md": "# ignore",
      ".gitkeep": "",
    });

    const migrations = await discoverMigrations(dir);

    expect(migrations).toHaveLength(2);
    expect(migrations[0].version).toBe("001");
    expect(migrations[0].name).toBe("initial");
    expect(migrations[0].filename).toBe("001_initial.sql");
    expect(migrations[1].version).toBe("002");
    expect(migrations[1].name).toBe("add_column");

    await rm(dir, { recursive: true });
  });

  test("returns empty array for directory with no matching files", async () => {
    const dir = await createTempMigrations({
      "migration-schema-sync.sql": "-- legacy",
      "notes.txt": "some notes",
    });

    const migrations = await discoverMigrations(dir);
    expect(migrations).toHaveLength(0);

    await rm(dir, { recursive: true });
  });

  test("sorts by version number", async () => {
    const dir = await createTempMigrations({
      "003_third.sql": "-- third",
      "001_first.sql": "-- first",
      "002_second.sql": "-- second",
    });

    const migrations = await discoverMigrations(dir);
    expect(migrations.map((m) => m.version)).toEqual(["001", "002", "003"]);

    await rm(dir, { recursive: true });
  });
});

// ── computeChecksum ──────────────────────────────────────────

describe("computeChecksum", () => {
  test("returns consistent SHA-256 hex digest", () => {
    const content = "CREATE TABLE test (id INT);";
    const hash1 = computeChecksum(content);
    const hash2 = computeChecksum(content);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test("different content produces different checksums", () => {
    const hash1 = computeChecksum("CREATE TABLE a (id INT);");
    const hash2 = computeChecksum("CREATE TABLE b (id INT);");

    expect(hash1).not.toBe(hash2);
  });
});

// ── planMigrations ───────────────────────────────────────────

describe("planMigrations", () => {
  test("all migrations pending when none applied", () => {
    const discovered: MigrationFile[] = [
      {
        version: "001",
        name: "initial",
        filename: "001_initial.sql",
        path: "/tmp/001_initial.sql",
      },
      {
        version: "002",
        name: "add_col",
        filename: "002_add_col.sql",
        path: "/tmp/002_add_col.sql",
      },
    ];

    const { toApply, warnings } = planMigrations(discovered, [], new Map());

    expect(toApply).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  test("skips already-applied migrations", () => {
    const discovered: MigrationFile[] = [
      {
        version: "001",
        name: "initial",
        filename: "001_initial.sql",
        path: "/tmp/001_initial.sql",
      },
      {
        version: "002",
        name: "add_col",
        filename: "002_add_col.sql",
        path: "/tmp/002_add_col.sql",
      },
    ];
    const applied: AppliedMigration[] = [
      { version: "001", name: "initial", checksum: "abc123", applied_at: "2026-01-01T00:00:00Z" },
    ];

    const { toApply, warnings } = planMigrations(discovered, applied, new Map([["001", "abc123"]]));

    expect(toApply).toHaveLength(1);
    expect(toApply[0].version).toBe("002");
    expect(warnings).toHaveLength(0);
  });

  test("detects drift when checksum changes", () => {
    const discovered: MigrationFile[] = [
      {
        version: "001",
        name: "initial",
        filename: "001_initial.sql",
        path: "/tmp/001_initial.sql",
      },
    ];
    const applied: AppliedMigration[] = [
      {
        version: "001",
        name: "initial",
        checksum: "old_checksum",
        applied_at: "2026-01-01T00:00:00Z",
      },
    ];

    const { toApply, warnings } = planMigrations(
      discovered,
      applied,
      new Map([["001", "new_checksum"]]),
    );

    expect(toApply).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DRIFT");
    expect(warnings[0]).toContain("001_initial.sql");
  });

  test("no drift warning when checksums match", () => {
    const discovered: MigrationFile[] = [
      {
        version: "001",
        name: "initial",
        filename: "001_initial.sql",
        path: "/tmp/001_initial.sql",
      },
    ];
    const applied: AppliedMigration[] = [
      {
        version: "001",
        name: "initial",
        checksum: "same_hash",
        applied_at: "2026-01-01T00:00:00Z",
      },
    ];

    const { toApply, warnings } = planMigrations(
      discovered,
      applied,
      new Map([["001", "same_hash"]]),
    );

    expect(toApply).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

// ── runMigrations (integration with mock executor) ───────────

describe("runMigrations", () => {
  test("AC-1: first execution applies migration and records it", async () => {
    const dir = await createTempMigrations({
      "001_initial.sql": "CREATE TABLE IF NOT EXISTS test_table (id INT);",
    });
    const mock = createMockExecutor();

    const { results, warnings } = await runMigrations({
      execute: mock.execute,
      query: mock.query,
      migrationsDir: dir,
    });

    // Bootstrap table was created
    expect(mock.isBootstrapped).toBe(true);

    // Migration was applied
    expect(results).toHaveLength(1);
    expect(results[0].version).toBe("001");
    expect(results[0].status).toBe("applied");

    // Migration SQL was executed
    const migrationSql = mock.executedQueries.find((q) => q.includes("test_table"));
    expect(migrationSql).toBeDefined();

    // Migration was recorded in tracking table
    expect(mock.appliedMigrations).toHaveLength(1);
    expect(mock.appliedMigrations[0].version).toBe("001");
    expect(mock.appliedMigrations[0].name).toBe("initial");
    expect(mock.appliedMigrations[0].checksum).toHaveLength(64);

    expect(warnings).toHaveLength(0);

    await rm(dir, { recursive: true });
  });

  test("AC-2: re-execution is idempotent — no re-application", async () => {
    const dir = await createTempMigrations({
      "001_initial.sql": "CREATE TABLE IF NOT EXISTS test_table (id INT);",
    });

    // First run
    const mock1 = createMockExecutor();
    await runMigrations({
      execute: mock1.execute,
      query: mock1.query,
      migrationsDir: dir,
    });

    // Second run — simulate applied state by pre-seeding the query
    const content = await readFile(join(dir, "001_initial.sql"), "utf-8");
    const checksum = computeChecksum(content);
    const preApplied: AppliedMigration[] = [
      { version: "001", name: "initial", checksum, applied_at: "2026-01-01T00:00:00Z" },
    ];
    const executedQueries: string[] = [];

    const { results } = await runMigrations({
      execute: async (sql: string) => {
        executedQueries.push(sql);
      },
      query: async <T>(_sql: string): Promise<T[]> => {
        return preApplied as unknown as T[];
      },
      migrationsDir: dir,
    });

    // 001 should be skipped
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("skipped");

    // No migration SQL executed (only bootstrap)
    const nonBootstrap = executedQueries.filter((q) => !q.includes("schema_migrations"));
    expect(nonBootstrap).toHaveLength(0);

    await rm(dir, { recursive: true });
  });

  test("AC-3: only new migrations are applied when 001 already done", async () => {
    const dir = await createTempMigrations({
      "001_initial.sql": "CREATE TABLE IF NOT EXISTS t1 (id INT);",
      "002_add_column.sql": "ALTER TABLE t1 ADD COLUMN name TEXT;",
    });

    const content001 = await readFile(join(dir, "001_initial.sql"), "utf-8");
    const checksum001 = computeChecksum(content001);
    const preApplied: AppliedMigration[] = [
      {
        version: "001",
        name: "initial",
        checksum: checksum001,
        applied_at: "2026-01-01T00:00:00Z",
      },
    ];
    const executedQueries: string[] = [];
    const newlyApplied: AppliedMigration[] = [];

    const { results } = await runMigrations({
      execute: async (sql: string) => {
        executedQueries.push(sql);
        const insertMatch = sql.match(
          /INSERT INTO schema_migrations \(version, name, checksum\) VALUES \('(\d{3})', '([^']+)', '([^']+)'\)/,
        );
        if (insertMatch) {
          newlyApplied.push({
            version: insertMatch[1],
            name: insertMatch[2],
            checksum: insertMatch[3],
            applied_at: new Date().toISOString(),
          });
        }
      },
      query: async <T>(_sql: string): Promise<T[]> => {
        return preApplied as unknown as T[];
      },
      migrationsDir: dir,
    });

    // 001 skipped, 002 applied
    expect(results).toHaveLength(2);
    expect(results[0].version).toBe("001");
    expect(results[0].status).toBe("skipped");
    expect(results[1].version).toBe("002");
    expect(results[1].status).toBe("applied");

    // Only 002 SQL was executed (plus bootstrap)
    const alterQuery = executedQueries.find((q) => q.includes("ADD COLUMN"));
    expect(alterQuery).toBeDefined();

    // Only 002 was recorded
    expect(newlyApplied).toHaveLength(1);
    expect(newlyApplied[0].version).toBe("002");

    await rm(dir, { recursive: true });
  });

  test("dry-run mode does not execute SQL", async () => {
    const dir = await createTempMigrations({
      "001_initial.sql": "CREATE TABLE test (id INT);",
    });
    const executedQueries: string[] = [];

    const { results } = await runMigrations({
      execute: async (sql: string) => {
        executedQueries.push(sql);
      },
      query: async <T>(_sql: string): Promise<T[]> => {
        return [] as T[];
      },
      migrationsDir: dir,
      dryRun: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("applied"); // reported as would-be-applied

    // Only bootstrap SQL was executed, not the migration itself
    const migrationSql = executedQueries.find((q) => q.includes("CREATE TABLE test"));
    expect(migrationSql).toBeUndefined();

    await rm(dir, { recursive: true });
  });

  test("returns empty results when no migration files exist", async () => {
    const dir = await createTempMigrations({
      "README.md": "nothing here",
    });
    const mock = createMockExecutor();

    const { results } = await runMigrations({
      execute: mock.execute,
      query: mock.query,
      migrationsDir: dir,
    });

    expect(results).toHaveLength(0);

    await rm(dir, { recursive: true });
  });
});

// ── BOOTSTRAP_SQL ────────────────────────────────────────────

describe("BOOTSTRAP_SQL", () => {
  test("contains CREATE TABLE IF NOT EXISTS schema_migrations", () => {
    expect(BOOTSTRAP_SQL).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
    expect(BOOTSTRAP_SQL).toContain("version TEXT PRIMARY KEY");
    expect(BOOTSTRAP_SQL).toContain("name TEXT NOT NULL");
    expect(BOOTSTRAP_SQL).toContain("checksum TEXT");
    expect(BOOTSTRAP_SQL).toContain("applied_at TIMESTAMPTZ");
  });
});

// ── 001_initial.sql ──────────────────────────────────────────

describe("001_initial.sql", () => {
  const migrationPath = join(import.meta.dir, "../../db/migrations/001_initial.sql");
  const schemaPath = join(import.meta.dir, "../../db/schema.sql");

  test("exists and is non-empty", async () => {
    const content = await readFile(migrationPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  test("CREATE EXTENSION lines are commented out", async () => {
    const content = await readFile(migrationPath, "utf-8");
    const extensionLines = content.split("\n").filter((l) => l.includes("CREATE EXTENSION"));

    for (const line of extensionLines) {
      expect(line.trimStart().startsWith("--")).toBe(true);
    }
  });

  test("matches schema.sql except for commented extensions", async () => {
    const migration = await readFile(migrationPath, "utf-8");
    const schema = await readFile(schemaPath, "utf-8");

    // Uncomment the extensions in migration to compare
    const normalized = migration
      .replace(
        /^-- CREATE EXTENSION IF NOT EXISTS vector;.*$/m,
        "CREATE EXTENSION IF NOT EXISTS vector;",
      )
      .replace(
        /^-- CREATE EXTENSION IF NOT EXISTS pg_net;.*$/m,
        "CREATE EXTENSION IF NOT EXISTS pg_net;",
      );

    expect(normalized).toBe(schema);
  });

  test("contains IF NOT EXISTS for all CREATE TABLE statements (idempotent)", async () => {
    const content = await readFile(migrationPath, "utf-8");
    const createTableLines = content
      .split("\n")
      .filter((l) => l.trim().startsWith("CREATE TABLE") && !l.trim().startsWith("--"));

    for (const line of createTableLines) {
      expect(line).toContain("IF NOT EXISTS");
    }
  });
});

// ── Regex filter edge cases ──────────────────────────────────

describe("migration file regex filtering", () => {
  test("rejects files without leading digits", async () => {
    const dir = await createTempMigrations({
      "abc_initial.sql": "-- no match",
      "initial.sql": "-- no match",
    });

    const migrations = await discoverMigrations(dir);
    expect(migrations).toHaveLength(0);

    await rm(dir, { recursive: true });
  });

  test("rejects files with wrong digit count", async () => {
    const dir = await createTempMigrations({
      "01_short.sql": "-- only 2 digits",
      "0001_long.sql": "-- 4 digits",
    });

    const migrations = await discoverMigrations(dir);
    expect(migrations).toHaveLength(0);

    await rm(dir, { recursive: true });
  });

  test("rejects legacy migration files from db/migrations", async () => {
    const dir = await createTempMigrations({
      "migration-schema-sync.sql": "-- legacy",
      "llm-ops-schema.sql": "-- legacy",
      "001_initial.sql": "-- matches",
    });

    const migrations = await discoverMigrations(dir);
    expect(migrations).toHaveLength(1);
    expect(migrations[0].version).toBe("001");

    await rm(dir, { recursive: true });
  });
});
