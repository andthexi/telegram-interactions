import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bot } from 'grammy';

import { loadRuntimeConfig } from './config.js';
import { createInteractionApplication } from './application.js';
import { GrammyTransport } from './telegram.js';
import type { RuntimeBot } from './runtime.js';

export async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const bot = new Bot(config.token);
  const application = createInteractionApplication(config, {
    bot: bot as unknown as RuntimeBot,
    transport: new GrammyTransport(bot.api),
  });

  const shutdown = async (): Promise<void> => {
    await application.shutdown();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  try {
    await application.runtime.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
