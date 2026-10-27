import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InteractionService } from '../src/service.js';
import { UnixSocketServer } from '../src/socket-api.js';
import { InteractionStore } from '../src/store.js';

const submitMessage = (key = 'packet-1', includeTarget = true) => ({
  op: 'submit',
  namespace: 'jobsearch',
  workflow: 'job-search',
  request: {
    idempotencyKey: key,
    type: 'notification',
    schema: {
      schemaVersion: 1,
      revision: 1,
      title: 'Review',
      body: 'Fixture body',
      effect: 'Acknowledge the fixture',
      acknowledgeLabel: 'Acknowledge',
    },
    ...(includeTarget ? { destination: { chatId: -100_123, threadId: 42 }, allowedUserId: 777 } : {}),
  },
});

const roundTrip = async (socketPath: string, payload: Buffer): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = Buffer.alloc(0);
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const newline = response.indexOf(0x0a);
      if (newline >= 0) {
        socket.end();
        resolve(JSON.parse(response.subarray(0, newline).toString('utf8')) as Record<string, unknown>);
      }
    });
    socket.once('connect', () => socket.write(Buffer.concat([payload, Buffer.from('\n')])));
  });

describe('Unix socket NDJSON API', () => {
  let directory: string;
  let socketPath: string;
  let store: InteractionStore;
  let server: UnixSocketServer;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telegram-socket-'));
    socketPath = join(directory, 'service.sock');
    store = new InteractionStore(join(directory, 'interactions.db'));
    server = new UnixSocketServer(socketPath, new InteractionService(store, {
      defaultDestination: { chatId: -100_123, threadId: 42 },
      defaultAllowedUserId: 777,
    }).handle);
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('removes a stale socket inode before listening', async () => {
    const { spawn } = await import('node:child_process');
    const stale = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(socketPath)},()=>process.stdout.write('ready\\n'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      stale.once('error', reject);
      stale.stdout.once('data', () => resolve());
    });
    stale.kill('SIGKILL');
    await new Promise<void>((resolve) => stale.once('exit', () => resolve()));

    await server.start();
    await expect(roundTrip(socketPath, Buffer.from(JSON.stringify(submitMessage('recovered'))))).resolves.toMatchObject({ ok: true });
  });

  it('submits idempotently over an owner-only socket and removes the socket on stop', async () => {
    await server.start();
    const payload = Buffer.from(JSON.stringify(submitMessage()));
    const first = await roundTrip(socketPath, payload);
    const second = await roundTrip(socketPath, payload);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, state: 'queued', revision: 1 });
    expect(typeof first.interactionId).toBe('string');
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await server.stop();
    await expect(readFile(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid JSON and unknown operations deterministically', async () => {
    await server.start();
    await expect(roundTrip(socketPath, Buffer.from('{not-json'))).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_json', message: 'request must be one JSON object' },
    });
    await expect(roundTrip(socketPath, Buffer.from('{"op":"erase-everything"}'))).resolves.toEqual({
      ok: false,
      error: { code: 'unknown_operation', message: 'unsupported operation: erase-everything' },
    });
  });

  it('rejects malformed submissions before touching the store', () => {
    const service = new InteractionService(store, {
      defaultDestination: { chatId: -100_123, threadId: 42 },
      defaultAllowedUserId: 777,
    });
    expect(service.handle({ ...submitMessage(), namespace: '../escape' })).toEqual({
      ok: false,
      error: {
        code: 'invalid_scope',
        message: 'namespace must be a bounded lowercase namespace',
      },
    });
    expect(store.listInteractions('jobsearch', 'job-search')).toEqual([]);
  });

  it('bounds request frames without stopping the server', async () => {
    server = new UnixSocketServer(socketPath, new InteractionService(store, {
      defaultDestination: { chatId: -100_123, threadId: 42 },
      defaultAllowedUserId: 777,
    }).handle, { maxRequestBytes: 1_024 });
    await server.start();
    await expect(roundTrip(socketPath, Buffer.alloc(1_025, 'x'))).resolves.toEqual({
      ok: false,
      error: { code: 'request_too_large', message: 'request exceeds 1024 bytes' },
    });
    await expect(roundTrip(socketPath, Buffer.from(JSON.stringify(submitMessage('packet-2'))))).resolves.toMatchObject({
      ok: true,
      state: 'queued',
    });
  });

  it('uses service defaults when target fields are omitted', () => {
    const service = new InteractionService(store, {
      defaultDestination: { chatId: -100_123, threadId: 42 },
      defaultAllowedUserId: 777,
    });
    const response = service.handle(submitMessage('defaults', false));
    expect(response).toMatchObject({ ok: true, state: 'queued' });
    expect(store.listInteractions('jobsearch', 'job-search')[0]).toMatchObject({
      destination: { chatId: -100_123, threadId: 42 },
      allowedUserId: 777,
    });
  });
});
