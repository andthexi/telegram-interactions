import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInteractionApplication } from '../src/application.js';
import type { RuntimeBot, RuntimeContext } from '../src/runtime.js';
import type { RuntimeConfig } from '../src/config.js';
import type { RenderedMessage, SentMessage, TelegramTransport } from '../src/telegram.js';

const roots: string[] = [];

class FakeBot implements RuntimeBot {
  readonly handlers = new Map<string, (context: RuntimeContext) => Promise<void>>();
  started = false;
  readonly api = {
    answerCallbackQuery: async (): Promise<void> => undefined,
    editMessageText: async (): Promise<void> => undefined,
    editMessageReplyMarkup: async (): Promise<void> => undefined,
  };
  on(filter: string, handler: (context: RuntimeContext) => Promise<void>): void { this.handlers.set(filter, handler); }
  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> { this.started = false; }
}

class FakeTransport implements TelegramTransport {
  async sendMessage(input: { chatId: number; threadId: number | null; text: string; buttons: RenderedMessage['buttons'] }): Promise<SentMessage> {
    return { messageId: 1, chatId: input.chatId, threadId: input.threadId };
  }
}

async function fixture(): Promise<{ root: string; config: RuntimeConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'telegram-application-'));
  roots.push(root);
  return {
    root,
    config: {
      databasePath: join(root, 'interactions.db'),
      socketPath: join(root, 'service.sock'),
      telegram: { tokenEnvironmentVariable: 'FIXTURE_TOKEN' },
      reconciliationIntervalMs: 300_000,
      deliveryIntervalMs: 60_000,
      token: 'fixture-token',
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('standalone interaction application composition', () => {
  it('composes and starts the service with injected bot/transport dependencies', async () => {
    const { root, config } = await fixture();
    const bot = new FakeBot();
    const application = createInteractionApplication(config, { bot, transport: new FakeTransport() });

    await application.runtime.start();
    expect(bot.started).toBe(true);
    expect((await stat(config.socketPath)).mode & 0o777).toBe(0o600);
    await application.shutdown();
    expect(bot.started).toBe(false);
    await expect(stat(config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'interactions.db'))).resolves.toBeTruthy();
  });
});
