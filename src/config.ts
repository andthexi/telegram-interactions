import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const configSchema = z.object({
  databasePath: z.string().min(1),
  socketPath: z.string().min(1),
  telegram: z.object({ tokenEnvironmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  reconciliationIntervalMs: z.number().int().min(1_000).default(300_000),
  deliveryIntervalMs: z.number().int().min(100).default(1_000),
});

export type RuntimeConfig = z.output<typeof configSchema> & { token: string };

export async function loadRuntimeConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<RuntimeConfig> {
  const parsed = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const token = env[parsed.telegram.tokenEnvironmentVariable];
  if (token === undefined || token.trim().length === 0) {
    throw new Error(`missing Telegram token environment variable: ${parsed.telegram.tokenEnvironmentVariable}`);
  }
  return { ...parsed, token };
}
