import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSnapshotInventory } from '../src/inventory.js';

describe('explicit-path pre-cutover inventory scaffolding', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telegram-inventory-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('hashes read-only snapshots and restore-checks SQLite without leaking row content to the manifest', async () => {
    const sourceDatabase = join(directory, 'state.db');
    const sourceFile = join(directory, 'jobs.json');
    const database = new Database(sourceDatabase);
    database.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, profile_name TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
      INSERT INTO sessions VALUES ('job-1', 'jobsearch'), ('default-1', 'default');
      INSERT INTO messages(session_id, body) VALUES ('job-1', 'private fixture text'), ('default-1', 'other text');
    `);
    database.close();
    await writeFile(sourceFile, '{"jobs": []}\n');

    const manifestPath = join(directory, 'inventory.json');
    const inventory = await createSnapshotInventory({
      sources: [
        { name: 'default-state', path: sourceDatabase, kind: 'sqlite' },
        { name: 'default-cron', path: sourceFile, kind: 'file' },
      ],
      snapshotRoot: join(directory, 'snapshots'),
      manifestPath,
      selectors: [
        { sourceName: 'default-state', table: 'sessions', column: 'profile_name', values: ['jobsearch'] },
      ],
      capturedSessionIds: { 'default-state': ['job-1'] },
      capturedAt: '2026-08-07T12:00:00.000Z',
    });

    expect(JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'))).toEqual(inventory);
    expect(inventory.status).toBe('captured');
    const stateRecord = inventory.sources.find((item) => item.name === 'default-state');
    expect(stateRecord).toMatchObject({
      integrityCheck: 'ok',
      restoreIntegrityCheck: 'ok',
      rowCounts: { messages: 2, sessions: 2 },
      attributedRowCounts: { 'sessions.profile_name': 1 },
      sessionIds: ['job-1'],
    });
    expect(stateRecord?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8')).not.toContain('private fixture text');
    for (const record of inventory.sources) {
      expect((await stat(record.snapshotPath)).mode & 0o777).toBe(0o400);
    }
  });

  it('refuses to overwrite an existing inventory manifest', async () => {
    const source = join(directory, 'jobs.json');
    const manifestPath = join(directory, 'inventory.json');
    await writeFile(source, '{}\n');
    await writeFile(manifestPath, 'reserved');
    await chmod(manifestPath, 0o400);

    await expect(
      createSnapshotInventory({
        sources: [{ name: 'cron', path: source, kind: 'file' }],
        snapshotRoot: join(directory, 'snapshots'),
        manifestPath,
        selectors: [],
        capturedSessionIds: {},
        capturedAt: '2026-08-07T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
