import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { dirname } from 'node:path';
import { removeStaleSocket } from './stale-socket.js';

const scopePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const eventType = 'interaction.result_ready' as const;

export interface ResultReadyInput {
  namespace: string;
  workflow: string;
  interactionId: string;
  revision: number;
}

interface Subscription {
  id: string;
  key: string;
  socket: Socket;
  congested: boolean;
}

type EventResponse = Record<string, unknown> & { ok: boolean };
const errorResponse = (code: string, message: string): EventResponse => ({ ok: false, error: { code, message } });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ResultEventServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly owners = new Map<string, Subscription>();
  private readonly subscriptions = new Map<Socket, Subscription>();
  private readonly maxRequestBytes: number;
  private readonly maxPendingBytes: number;

  constructor(readonly path: string, options: { maxRequestBytes?: number; maxPendingBytes?: number } = {}) {
    this.maxRequestBytes = options.maxRequestBytes ?? 64 * 1_024;
    this.maxPendingBytes = options.maxPendingBytes ?? 64 * 1_024;
  }

  async start(): Promise<void> {
    if (this.server !== null) throw new Error('result event server is already started');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.path);
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === null) return reject(new Error('result event server was not created'));
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(this.path, () => { server.off('error', onError); resolve(); });
    });
    await chmod(this.path, 0o600);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.owners.clear();
    this.subscriptions.clear();
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
    await rm(this.path, { force: true });
  }

  emitResultReady(input: ResultReadyInput): void {
    const subscription = this.owners.get(this.scopeKey(input.namespace, input.workflow));
    if (subscription === undefined || subscription.congested || subscription.socket.destroyed) return;
    if (subscription.socket.writableLength >= this.maxPendingBytes) return;
    const event = {
      eventVersion: 1,
      eventId: randomUUID(),
      eventType,
      occurredAt: new Date().toISOString(),
      scope: { namespace: input.namespace, workflow: input.workflow },
      interaction: { interactionId: input.interactionId, revision: input.revision },
    };
    subscription.congested = !subscription.socket.write(`${JSON.stringify(event)}\n`);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let closed = false;
    const respond = (response: EventResponse, end = false): void => {
      if (closed) return;
      socket.write(`${JSON.stringify(response)}\n`, () => { if (end) socket.end(); });
    };
    const release = (): void => {
      if (closed) return;
      closed = true;
      this.sockets.delete(socket);
      const subscription = this.subscriptions.get(socket);
      if (subscription !== undefined) {
        this.subscriptions.delete(socket);
        if (this.owners.get(subscription.key) === subscription) this.owners.delete(subscription.key);
      }
    };
    socket.on('drain', () => {
      const subscription = this.subscriptions.get(socket);
      if (subscription !== undefined) subscription.congested = false;
    });
    socket.on('data', (chunk: Buffer) => {
      if (closed) return;
      buffered = Buffer.concat([buffered, chunk]);
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (frame.length > this.maxRequestBytes) {
          respond(errorResponse('request_too_large', `request exceeds ${this.maxRequestBytes} bytes`), true);
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(frame.toString('utf8')) as unknown;
        } catch {
          respond(errorResponse('invalid_json', 'request must be one JSON object'));
          newline = buffered.indexOf(0x0a);
          continue;
        }
        respond(this.subscribe(socket, message));
        newline = buffered.indexOf(0x0a);
      }
      if (buffered.length > this.maxRequestBytes) respond(errorResponse('request_too_large', `request exceeds ${this.maxRequestBytes} bytes`), true);
    });
    socket.once('close', release);
    socket.once('error', release);
  }

  private subscribe(socket: Socket, message: unknown): EventResponse {
    if (!isRecord(message) || message.op !== 'subscribe') return errorResponse('invalid_subscription', 'request must be a subscribe operation');
    if (this.subscriptions.has(socket)) return errorResponse('invalid_subscription', 'connection already has a subscription');
    const { namespace, workflow, eventTypes } = message;
    if (typeof namespace !== 'string' || !scopePattern.test(namespace)
      || typeof workflow !== 'string' || !scopePattern.test(workflow)
      || !Array.isArray(eventTypes) || eventTypes.length !== 1 || eventTypes[0] !== eventType) {
      return errorResponse('invalid_subscription', 'subscription scope or eventTypes is invalid');
    }
    const key = this.scopeKey(namespace, workflow);
    if (this.owners.has(key)) return errorResponse('subscription_conflict', 'scope already has an active owner');
    const subscription = { id: randomUUID(), key, socket, congested: false };
    this.owners.set(key, subscription);
    this.subscriptions.set(socket, subscription);
    return { ok: true, subscriptionId: subscription.id };
  }

  private scopeKey(namespace: string, workflow: string): string {
    return `${namespace}\u0000${workflow}`;
  }
}
