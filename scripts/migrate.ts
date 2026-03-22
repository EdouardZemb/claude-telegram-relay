/**
 * Database Migration Runner — Idempotent, auto-bootstrapping
 *
 * Reads db/migrations/NNN_*.sql files, compares with schema_migrations table,
 * applies missing migrations in order. Each migration runs in its own transaction.
 *
 * Auto-creates schema_migrations table on first run.
 * Checksum (SHA-256) stored for drift detection (warning only).
 *
 * Usage: bun run migrate
 *        bun run migrate --dry-run
 */

import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  path: string;
}

export interface MigrationResult {
  version: string;
  name: string;
  status: "applied" | "skipped" | "drift-warning";
  durationMs?: number;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string | null;
  applied_at: string;
}

// ── Configuration ────────────────────────────────────────────

const MIGRATION_PATTERN = /^(\d{3})_(.+)\.sql$/;
const MIGRATIONS_DIR = join(import.meta.dir, "../db/migrations");

// ── Core Functions (exported for testing) ────────────────────

/** Scan db/migrations/ for files matching NNN_name.sql pattern */
export async function discoverMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = await readdir(dir);
  const migrations: MigrationFile[] = [];

  for (const file of files) {
    const match = MIGRATION_PATTERN.exec(file);
    if (match) {
      migrations.push({
        version: match[1],
        name: match[2],
        filename: file,
        path: join(dir, file),
      });
    }
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/** Compute SHA-256 checksum of a file's content */
export function computeChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Filter out already-applied migrations, warn on drift */
export function planMigrations(
  discovered: MigrationFile[],
  applied: AppliedMigration[],
  checksums: Map<string, string>,
): { toApply: MigrationFile[]; warnings: string[] } {
  const appliedVersions = new Set(applied.map((a) => a.version));
  const appliedByVersion = new Map(applied.map((a) => [a.version, a]));
  const toApply: MigrationFile[] = [];
  const warnings: string[] = [];

  for (const migration of discovered) {
    if (appliedVersions.has(migration.version)) {
      // Check for drift
      const record = appliedByVersion.get(migration.version)!;
      const currentChecksum = checksums.get(migration.version);
      if (record.checksum && currentChecksum && record.checksum !== currentChecksum) {
        warnings.push(
          `DRIFT: ${migration.filename} checksum changed since application (was ${record.checksum.slice(0, 8)}..., now ${currentChecksum.slice(0, 8)}...)`,
        );
      }
    } else {
      toApply.push(migration);
    }
  }

  return { toApply, warnings };
}

/** Bootstrap schema_migrations table */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
`;

/** Run the migration process with a given SQL executor */
export async function runMigrations(opts: {
  execute: (sql: string) => Promise<void>;
  query: <T>(sql: string) => Promise<T[]>;
  migrationsDir?: string;
  dryRun?: boolean;
}): Promise<{ results: MigrationResult[]; warnings: string[] }> {
  const { execute, query, migrationsDir, dryRun = false } = opts;

  // 1. Auto-bootstrap tracking table
  await execute(BOOTSTRAP_SQL);

  // 2. Discover migration files
  const discovered = await discoverMigrations(migrationsDir);
  if (discovered.length === 0) {
    console.log("No migration files found.");
    return { results: [], warnings: [] };
  }

  // 3. Read applied migrations
  const applied = await query<AppliedMigration>(
    "SELECT version, name, checksum, applied_at::text FROM schema_migrations ORDER BY version",
  );

  // 4. Compute checksums for discovered files
  const checksums = new Map<string, string>();
  for (const m of discovered) {
    const content = await readFile(m.path, "utf-8");
    checksums.set(m.version, computeChecksum(content));
  }

  // 5. Plan
  const { toApply, warnings } = planMigrations(discovered, applied, checksums);

  // 6. Apply
  const results: MigrationResult[] = [];

  // Report skipped
  for (const a of applied) {
    const found = discovered.find((d) => d.version === a.version);
    if (found) {
      const driftWarning = warnings.some((w) => w.includes(found.filename));
      results.push({
        version: a.version,
        name: a.name,
        status: driftWarning ? "drift-warning" : "skipped",
      });
    }
  }

  // Apply pending
  for (const migration of toApply) {
    if (dryRun) {
      console.log(`  [DRY-RUN] Would apply: ${migration.filename}`);
      results.push({ version: migration.version, name: migration.name, status: "applied" });
      continue;
    }

    const start = Date.now();
    const sql = await readFile(migration.path, "utf-8");
    const checksum = checksums.get(migration.version)!;

    // Execute migration SQL
    await execute(sql);

    // Record in tracking table
    await execute(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES ('${migration.version}', '${migration.name}', '${checksum}')`,
    );

    const durationMs = Date.now() - start;
    console.log(`  [OK] ${migration.filename} (${durationMs}ms)`);
    results.push({
      version: migration.version,
      name: migration.name,
      status: "applied",
      durationMs,
    });
  }

  return { results, warnings };
}

// ── Main (CLI entrypoint) ────────────────────────────────────

async function main() {
  // Load env
  await import("dotenv/config");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "ERROR: DATABASE_URL not set.\n" +
        "Get it from Supabase Dashboard > Settings > Database > Connection string (URI).\n" +
        "Format: postgres://postgres.[ref]:[password]@[host]:5432/postgres",
    );
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");

  // Dynamic import of postgres (devDependency)
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { connect_timeout: 30, idle_timeout: 10 });

  try {
    console.log(`Running migrations${dryRun ? " (dry-run)" : ""}...\n`);

    const { results, warnings } = await runMigrations({
      execute: async (query: string) => {
        await sql.unsafe(query);
      },
      query: async <T>(query: string): Promise<T[]> => {
        return (await sql.unsafe(query)) as unknown as T[];
      },
      dryRun,
    });

    // Print warnings
    for (const w of warnings) {
      console.log(`  [!!] ${w}`);
    }

    // Summary
    const applied = results.filter((r) => r.status === "applied").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const drift = results.filter((r) => r.status === "drift-warning").length;

    console.log("");
    console.log(`Done: ${applied} applied, ${skipped} skipped, ${drift} drift warnings`);

    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

// Only run main when executed directly
if (import.meta.main) {
  main();
}
