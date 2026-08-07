import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import Database from 'better-sqlite3';

export interface SnapshotSource {
  name: string;
  path: string;
  kind: 'sqlite' | 'file' | 'directory';
}

export interface AttributionSelector {
  sourceName: string;
  table: string;
  column: string;
  values: string[];
}

export interface SnapshotRecord {
  name: string;
  kind: SnapshotSource['kind'];
  sourcePath: string;
  snapshotPath: string;
  sha256: string;
  integrityCheck?: string;
  restoreIntegrityCheck?: string;
  rowCounts?: Record<string, number>;
  attributedRowCounts?: Record<string, number>;
  sessionIds?: string[];
  fileCount?: number;
}

export interface SnapshotInventory {
  formatVersion: 1;
  status: 'captured';
  capturedAt: string;
  sources: SnapshotRecord[];
}

export interface SnapshotInventoryOptions {
  sources: SnapshotSource[];
  snapshotRoot: string;
  manifestPath: string;
  selectors: AttributionSelector[];
  capturedSessionIds: Record<string, string[]>;
  capturedAt: string;
}

export async function createSnapshotInventory(options: SnapshotInventoryOptions): Promise<SnapshotInventory> {
  if (options.sources.length === 0) throw new RangeError('at least one snapshot source is required');
  await assertMissing(options.manifestPath);
  for (const source of options.sources) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source.name)) {
      throw new RangeError(`snapshot source name is not bounded: ${source.name}`);
    }
  }

  const timestampDirectory = join(options.snapshotRoot, options.capturedAt.replaceAll(':', '-'));
  await mkdir(options.snapshotRoot, { recursive: true, mode: 0o700 });
  await mkdir(timestampDirectory, { recursive: false, mode: 0o700 });
  const records: SnapshotRecord[] = [];

  for (const source of options.sources) {
    await access(source.path);
    const destination = join(timestampDirectory, source.name);
    if (source.kind === 'sqlite') {
      await captureSqlite(source.path, destination);
      const relevantSelectors = options.selectors.filter((selector) => selector.sourceName === source.name);
      records.push({
        name: source.name,
        kind: source.kind,
        sourcePath: source.path,
        snapshotPath: destination,
        sha256: await sha256(destination),
        integrityCheck: sqliteIntegrity(destination),
        restoreIntegrityCheck: await restoreIntegrity(destination),
        rowCounts: sqliteRowCounts(destination),
        attributedRowCounts: attributedCounts(destination, relevantSelectors),
        sessionIds: [...(options.capturedSessionIds[source.name] ?? [])].sort(),
      });
    } else if (source.kind === 'file') {
      await copyFile(source.path, destination);
      await chmod(destination, 0o400);
      records.push({
        name: source.name,
        kind: source.kind,
        sourcePath: source.path,
        snapshotPath: destination,
        sha256: await sha256(destination),
      });
    } else {
      await cp(source.path, destination, { recursive: true, errorOnExist: true, force: false });
      const files = await filesBelow(destination);
      for (const file of files) await chmod(file, 0o400);
      const directories = await directoriesBelow(destination);
      for (const directory of directories) await chmod(directory, 0o500);
      await chmod(destination, 0o500);
      records.push({
        name: source.name,
        kind: source.kind,
        sourcePath: source.path,
        snapshotPath: destination,
        sha256: await treeSha256(destination, files),
        fileCount: files.length,
      });
    }
  }

  const inventory: SnapshotInventory = {
    formatVersion: 1,
    status: 'captured',
    capturedAt: options.capturedAt,
    sources: records,
  };
  await mkdir(dirname(options.manifestPath), { recursive: true, mode: 0o700 });
  const file = await open(options.manifestPath, 'wx', 0o400);
  try {
    await file.writeFile(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  } finally {
    await file.close();
  }
  await chmod(options.manifestPath, 0o400);
  return inventory;
}

async function assertMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  const error = new Error(`inventory manifest already exists: ${path}`) as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  throw error;
}

async function captureSqlite(source: string, destination: string): Promise<void> {
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
  await chmod(destination, 0o400);
}

function sqliteIntegrity(path: string): string {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (database.pragma('integrity_check', { simple: true }) as string | undefined) ?? 'missing-result';
  } finally {
    database.close();
  }
}

async function restoreIntegrity(path: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-interactions-restore-'));
  try {
    const restored = join(directory, 'restored.db');
    await copyFile(path, restored);
    return sqliteIntegrity(restored);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sqliteRowCounts(path: string): Record<string, number> {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => {
        const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as {
          count: number;
        };
        return [name, row.count];
      }),
    );
  } finally {
    database.close();
  }
}

function attributedCounts(path: string, selectors: AttributionSelector[]): Record<string, number> {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(
      selectors.map((selector) => {
        if (selector.values.length === 0) return [`${selector.table}.${selector.column}`, 0];
        const placeholders = selector.values.map(() => '?').join(',');
        const row = database
          .prepare(
            `SELECT COUNT(*) AS count FROM ${quoteIdentifier(selector.table)} WHERE ${quoteIdentifier(
              selector.column,
            )} IN (${placeholders})`,
          )
          .get(...selector.values) as { count: number };
        return [`${selector.table}.${selector.column}`, row.count];
      }),
    );
  } finally {
    database.close();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return digest.digest('hex');
}

async function treeSha256(root: string, files: string[]): Promise<string> {
  const digest = createHash('sha256');
  for (const file of [...files].sort()) {
    digest.update(relative(root, file));
    digest.update(Buffer.from(await sha256(file), 'hex'));
  }
  return digest.digest('hex');
}

async function filesBelow(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await filesBelow(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function directoriesBelow(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await directoriesBelow(path)), path);
    }
  }
  return output;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
