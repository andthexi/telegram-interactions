import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InteractionRuntime } from '../src/runtime.js';
import { ResultLifecycle } from '../src/lifecycle.js';
import { InteractionService } from '../src/service.js';
import { InteractionStore } from '../src/store.js';
import { TelegramDelivery } from '../src/telegram.js';
import type { RenderedMessage, SentMessage, TelegramTransport } from '../src/telegram.js';
import type { RuntimeBot, RuntimeContext } from '../src/runtime.js';

const schema = {
  schemaVersion: 1 as const,
  revision: 1,
  title: 'Fixture',
  body: 'Body',
  effect: 'Effect',
  acknowledgeLabel: 'Acknowledge',
};

class FakeBot implements RuntimeBot {
  readonly handlers = new Map<string, (context: RuntimeContext) => Promise<void>>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  started = false;

  api = {
    answerCallbackQuery: async (id: string, options?: { text?: string }): Promise<boolean> => {
      this.calls.push({ method: 'answerCallbackQuery', args: [id, options] });
      return true;
    },
    editMessageText: async (chatId: number, messageId: number, text: string, options?: unknown): Promise<unknown> => {
      this.calls.push({ method: 'editMessageText', args: [chatId, messageId, text, options] });
      return {};
    },
    editMessageReplyMarkup: async (chatId: number, messageId: number, options?: unknown): Promise<unknown> => {
      this.calls.push({ method: 'editMessageReplyMarkup', args: [chatId, messageId, options] });
      return {};
    },
    sendMessage: async (chatId: number, text: string, options?: unknown): Promise<unknown> => {
      this.calls.push({ method: 'sendMessage', args: [chatId, text, options] });
      return {};
    },
  };

  on(filter: string, handler: (context: RuntimeContext) => Promise<void>): void {
    this.handlers.set(filter, handler);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async emit(filter: string, context: RuntimeContext): Promise<void> {
    await this.handlers.get(filter)?.(context);
  }
}

class FakeTransport implements TelegramTransport {
  async sendMessage(input: { chatId: number; threadId: number | null; text: string; buttons: RenderedMessage['buttons'] }): Promise<SentMessage> {
    return { messageId: 9001, chatId: input.chatId, threadId: input.threadId };
  }
}

describe('InteractionRuntime', () => {
  let directory: string;
  let store: InteractionStore;
  let bot: FakeBot;
  let runtime: InteractionRuntime;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telegram-runtime-'));
    store = new InteractionStore(join(directory, 'interactions.db'));
    bot = new FakeBot();
    runtime = new InteractionRuntime({
      bot,
      store,
      service: new InteractionService(store, { defaultDestination: { chatId: -100, threadId: 7 }, defaultAllowedUserId: 42 }),
      lifecycle: new ResultLifecycle(store),
      delivery: new TelegramDelivery(store, new FakeTransport()),
      socketPath: join(directory, 'runtime.sock'),
      deliveryIntervalMs: 60_000,
    });
    await runtime.start();
  });

  afterEach(async () => {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('starts grammY handlers and delivers queued interactions', async () => {
    const interaction = store.submit('jobsearch', 'alerts', {
      idempotencyKey: 'runtime-delivery',
      type: 'notification',
      schema,
      destination: { chatId: -100, threadId: 7 },
      allowedUserId: 42,
    });

    await runtime.deliverPending();

    expect(bot.started).toBe(true);
    expect(store.getInteraction(interaction.interactionId)).toMatchObject({ state: 'delivered', messageId: 9001 });
  });

  it('maps callback context, edits wizard cards, and answers callback queries', async () => {
    const interaction = store.submit('jobsearch', 'alerts', {
      idempotencyKey: 'runtime-callback',
      type: 'notification',
      schema,
      destination: { chatId: -100, threadId: 7 },
      allowedUserId: 42,
    });
    await runtime.deliverPending();
    const token = store.activeCallbackBindings(interaction.interactionId)[0]?.token;
    if (token === undefined) throw new Error('fixture callback token was not persisted');

    await bot.emit('callback_query:data', {
      callbackQuery: { id: 'callback-1', data: token, message: { chat: { id: -100 }, message_id: 9001, message_thread_id: 7 }, from: { id: 42 } },
    });

    expect(bot.calls.map((call) => call.method)).toEqual(['editMessageReplyMarkup', 'answerCallbackQuery']);
    expect(store.getInteraction(interaction.interactionId).state).toBe('answered');
  });

  it('maps direct replies to the persisted parent message', async () => {
    const interaction = store.submit('jobsearch', 'alerts', {
      idempotencyKey: 'runtime-reply',
      type: 'reply_text',
      schema: { schemaVersion: 1, revision: 1, title: 'Fixture', body: 'Body', effect: 'Effect', minLength: 1, maxLength: 20, submitLabel: 'Reply' }, 
      destination: { chatId: -100, threadId: 7 },
      allowedUserId: 42,
    });
    await runtime.deliverPending();

    await bot.emit('message:text', {
      message: { text: 'hello', message_id: 9002, message_thread_id: 7, chat: { id: -100 }, from: { id: 42 }, reply_to_message: { message_id: 9001 } },
    });

    expect(store.getInteraction(interaction.interactionId).state).toBe('answered');
    expect(store.pollResults('jobsearch', 'alerts')[0]?.result).toEqual({ text: 'hello' });
  });
});
