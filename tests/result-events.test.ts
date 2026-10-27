import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResultEventServer } from '../src/result-events.js';

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

function readLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      socket.off('data', onData);
      resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')) as Record<string, unknown>);
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

describe('result-ready event socket', () => {
  let directory: string;
  let path: string;
  let server: ResultEventServer;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telegram-result-events-'));
    path = join(directory, 'events.sock');
    server = new ResultEventServer(path);
    await server.start();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('removes a stale socket inode before listening', async () => {
    await server.stop();
    const { spawn } = await import('node:child_process');
    const stale = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)},()=>process.stdout.write('ready\\n'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      stale.once('error', reject);
      stale.stdout.once('data', () => resolve());
    });
    stale.kill('SIGKILL');
    await new Promise<void>((resolve) => stale.once('exit', () => resolve()));

    await server.start();
    const socket = await connect(path);
    sockets.push(socket);
  });

  it('subscribes one owner to a scope and emits metadata-only result-ready events', async () => {
    const socket = await connect(path);
    sockets.push(socket);
    socket.write(`${JSON.stringify({ op: 'subscribe', namespace: 'jobsearch', workflow: 'alerts', eventTypes: ['interaction.result_ready'] })}\n`);
    const response = await readLine(socket);

    expect(response).toMatchObject({ ok: true });
    expect(typeof response.subscriptionId).toBe('string');
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    server.emitResultReady({ namespace: 'jobsearch', workflow: 'alerts', interactionId: 'interaction-1', revision: 3 });
    const event = await readLine(socket);
    expect(event).toMatchObject({
      eventVersion: 1,
      eventType: 'interaction.result_ready',
      scope: { namespace: 'jobsearch', workflow: 'alerts' },
      interaction: { interactionId: 'interaction-1', revision: 3 },
    });
    expect(typeof event.eventId).toBe('string');
    expect(typeof event.occurredAt).toBe('string');
    expect(event).not.toHaveProperty('result');
  });

  it('rejects a duplicate active owner and releases ownership on disconnect', async () => {
    const first = await connect(path);
    const duplicate = await connect(path);
    sockets.push(first, duplicate);
    const request = `${JSON.stringify({ op: 'subscribe', namespace: 'jobsearch', workflow: 'alerts', eventTypes: ['interaction.result_ready'] })}\n`;
    first.write(request);
    await expect(readLine(first)).resolves.toMatchObject({ ok: true });
    duplicate.write(request);
    await expect(readLine(duplicate)).resolves.toEqual({
      ok: false,
      error: { code: 'subscription_conflict', message: 'scope already has an active owner' },
    });

    first.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    const replacement = await connect(path);
    sockets.push(replacement);
    replacement.write(request);
    await expect(readLine(replacement)).resolves.toMatchObject({ ok: true });
  });

  it('rejects malformed subscriptions', async () => {
    const socket = await connect(path);
    sockets.push(socket);
    socket.write(`${JSON.stringify({ op: 'subscribe', namespace: '../escape', workflow: 'alerts', eventTypes: [] })}\n`);
    await expect(readLine(socket)).resolves.toMatchObject({ ok: false, error: { code: 'invalid_subscription' } });
  });
});
