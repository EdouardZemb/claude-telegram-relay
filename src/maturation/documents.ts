/**
 * @module maturation/documents
 * @description Document I/O for maturation runs: atomic writes, run lifecycle management.
 * Each run is stored under .maturation/runs/<id>/ with a meta.json and document files.
 */

import { randomUUID } from "crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { getConfig } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { MaturationDocType, MaturationRun } from "./types.ts";

const log = createLogger("maturation/documents");

// ── Base directory resolution ─────────────────────────────────

let _testBaseDir: string | undefined;

/**
 * Test hook: override the base directory for all path resolution.
 * Pass undefined to restore default resolution.
 */
export function _setBaseDirForTests(dir: string | undefined): void {
  _testBaseDir = dir;
}

function getBaseDir(): string {
  if (_testBaseDir !== undefined) return _testBaseDir;
  try {
    const config = getConfig();
    if (config.projectDir) return config.projectDir;
    if (config.relayDir) return config.relayDir;
  } catch {
    // Degrade gracefully if config is not available
  }
  return process.cwd();
}

// ── Path helpers ──────────────────────────────────────────────

/**
 * Returns the .maturation directory path under the project base dir.
 */
export function getMaturationDir(): string {
  return join(getBaseDir(), ".maturation");
}

/**
 * Returns the directory path for a specific run.
 */
export function getRunDir(runId: string): string {
  return join(getMaturationDir(), "runs", runId);
}

function getMetaPath(runId: string): string {
  return join(getRunDir(runId), "meta.json");
}

function getDocPath(runId: string, docType: MaturationDocType): string {
  return join(getRunDir(runId), `${docType}.md`);
}

// ── Run lifecycle ─────────────────────────────────────────────

/**
 * Creates the run directory and writes the initial meta.json.
 * Idempotent: uses { recursive: true } on mkdir.
 */
export async function initRun(run: MaturationRun): Promise<void> {
  const dir = getRunDir(run.id);
  await mkdir(dir, { recursive: true });
  await saveRunMeta(run);
  log.info("maturation run initialized", { runId: run.id, name: run.name });
}

/**
 * Atomically writes meta.json for a run (write to .tmp then rename).
 */
export async function saveRunMeta(run: MaturationRun): Promise<void> {
  const metaPath = getMetaPath(run.id);
  const tmp = `${metaPath}.tmp.${randomUUID().substring(0, 8)}`;
  try {
    await writeFile(tmp, JSON.stringify(run, null, 2), "utf-8");
    await rename(tmp, metaPath);
  } catch (error) {
    log.error("failed to save run meta", { runId: run.id, error: String(error) });
    throw error;
  }
}

/**
 * Loads meta.json for a run. Returns null if the file does not exist.
 */
export async function loadRunMeta(runId: string): Promise<MaturationRun | null> {
  const metaPath = getMetaPath(runId);
  try {
    const content = await readFile(metaPath, "utf-8");
    return JSON.parse(content) as MaturationRun;
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") return null;
    log.error("failed to load run meta", { runId, error: String(error) });
    return null;
  }
}

// ── Document I/O ──────────────────────────────────────────────

/**
 * Atomically writes a document for a run. Returns the absolute path of the written file.
 */
export async function writeDocument(
  runId: string,
  docType: MaturationDocType,
  content: string,
): Promise<string> {
  const docPath = getDocPath(runId, docType);
  const tmp = `${docPath}.tmp.${randomUUID().substring(0, 8)}`;
  try {
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, docPath);
    log.info("document written", { runId, docType });
    return docPath;
  } catch (error) {
    log.error("failed to write document", { runId, docType, error: String(error) });
    throw error;
  }
}

/**
 * Reads a document for a run. Returns null if the file does not exist.
 */
export async function readDocument(
  runId: string,
  docType: MaturationDocType,
): Promise<string | null> {
  const docPath = getDocPath(runId, docType);
  try {
    return await readFile(docPath, "utf-8");
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") return null;
    log.error("failed to read document", { runId, docType, error: String(error) });
    return null;
  }
}

// ── Run listing ───────────────────────────────────────────────

/**
 * Lists all maturation runs, sorted by createdAt descending.
 * Returns an empty array if the runs directory does not exist.
 */
export async function listRuns(): Promise<MaturationRun[]> {
  const runsDir = join(getMaturationDir(), "runs");
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") return [];
    log.error("failed to list runs", { error: String(error) });
    return [];
  }

  const runs: MaturationRun[] = [];
  for (const entry of entries) {
    const meta = await loadRunMeta(entry);
    if (meta !== null) {
      runs.push(meta);
    }
  }

  // Sort by createdAt descending (newest first)
  runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return runs;
}
