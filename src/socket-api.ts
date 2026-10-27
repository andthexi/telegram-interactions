import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { dirname } from 'node:path';

import type { ServiceResponse } from './service.js';
import { removeStaleSocket } from './stale-socket.js';

export type RequestHandler = (message: unknown) => ServiceResponse;

const errorResponse = (code: string, message: string): ServiceResponse => ({
  ok: false,
  error: { code, message },
});

export class UnixSocketServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly maxRequestBytes: number;

  constructor(
    readonly path: string,
    private readonly handler: RequestHandler,
    options: { maxRequestBytes?: number } = {},
  ) {
    this.maxRequestBytes = options.maxRequestBytes ?? 64 * 1_024;
    if (this.maxRequestBytes < 256) throw new RangeError('maxRequestBytes must be at least 256');
  }

  async start(): Promise<void> {
    if (this.server !== null) throw new Error('socket server is already started');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.path);

    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === null) return reject(new Error('socket server was not created'));
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(this.path, () => {
        server.off('error', onError);
        resolve();
      });
    });
    await chmod(this.path, 0o600);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    await rm(this.path, { force: true });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let closed = false;

    const respond = (response: ServiceResponse, end = false): void => {
      if (closed) return;
      socket.write(`${JSON.stringify(response)}\n`, () => {
        if (end) socket.end();
      });
    };

    socket.on('data', (chunk: Buffer) => {
      if (closed) return;
      buffered = Buffer.concat([buffered, chunk]);
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (frame.length > this.maxRequestBytes) {
          respond(errorResponse('request_too_large', `request exceeds ${this.maxRequestBytes} bytes`), true);
          closed = true;
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
        try {
          respond(this.handler(message));
        } catch {
          respond(errorResponse('internal_error', 'request failed internally'));
        }
        newline = buffered.indexOf(0x0a);
      }
      if (buffered.length > this.maxRequestBytes) {
        respond(
          errorResponse('request_too_large', `request exceeds ${this.maxRequestBytes} bytes`),
          true,
        );
        closed = true;
      }
    });
    socket.once('close', () => {
      closed = true;
      this.sockets.delete(socket);
    });
    socket.once('error', () => {
      closed = true;
      this.sockets.delete(socket);
    });
  }
}
