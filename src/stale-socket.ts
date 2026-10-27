import { connect } from 'node:net';
import { rm, stat } from 'node:fs/promises';

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function probe(path: string): Promise<'active' | 'stale'> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let settled = false;
    const finish = (result: 'active' | 'stale'): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish('active'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish('stale');
      else reject(error);
    });
  });
}

export async function removeStaleSocket(path: string): Promise<void> {
  try {
    const entry = await stat(path);
    if (!entry.isSocket()) throw new Error(`socket path exists and is not a socket: ${path}`);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (await probe(path) === 'active') throw new Error(`socket path already has an active listener: ${path}`);
  await rm(path);
}
