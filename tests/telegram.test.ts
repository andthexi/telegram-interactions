import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InteractionStore } from '../src/store.js';
import type { SubmissionRequest } from '../src/store.js';
import {
  DeliveryFailed,
  TelegramDelivery,
  TelegramDeliveryError,
  TelegramRenderer,
  interactionActions,
} from '../src/telegram.js';
import type { InlineButton, SentMessage, TelegramTransport } from '../src/telegram.js';

const common = {
  schemaVersion: 1 as const,
  revision: 1,
  title: 'Fixture title',
  body: 'Fixture body',
  effect: 'Fixture effect',
};
const option = (value: string, label: string) => ({ value, label, effect: `Records ${label}.` });

const submission = (type: SubmissionRequest['type'], schema: SubmissionRequest['schema']): SubmissionRequest => ({
  idempotencyKey: `packet-${type}`,
  type,
  schema,
  destination: { chatId: -100_123, threadId: 42 },
  allowedUserId: 777,
});

class FakeTransport implements TelegramTransport {
  calls = 0;
  lastButtons: InlineButton[][] = [];

  constructor(
    private failuresBeforeSuccess = 0,
    private readonly uncertain = false,
  ) {}

  async sendMessage(input: {
    chatId: number;
    threadId: number | null;
    text: string;
    buttons: InlineButton[][];
  }): Promise<SentMessage> {
    this.calls += 1;
    this.lastButtons = input.buttons;
    if (this.calls <= this.failuresBeforeSuccess) {
      throw new TelegramDeliveryError('fixture_failure', { uncertain: this.uncertain });
    }
    return { messageId: 9_001, chatId: input.chatId, threadId: input.threadId };
  }
}

describe('Telegram rendering and delivery', () => {
  let directory: string;
  let store: InteractionStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telegram-render-'));
    store = new InteractionStore(join(directory, 'interactions.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['notice', common, 0],
    ['notification', { ...common, acknowledgeLabel: 'Acknowledge' }, 1],
    ['single_enum', { ...common, options: [option('remote', 'Remote'), option('hybrid', 'Hybrid')] }, 2],
    ['reply_text', { ...common, minLength: 1, maxLength: 40, submitLabel: 'Reply directly' }, 0],
  ] as const)('renders one %s card using only opaque callbacks', (kind, schema, expectedRows) => {
    const actions = interactionActions(kind, schema, {});
    const tokens = Object.fromEntries(Object.keys(actions).map((key, index) => [key, `cb_${String(index + 1).padStart(24, '0')}`]));
    const card = new TelegramRenderer().render(kind, schema, {}, tokens);

    expect(card.text).toMatch(/^Fixture title\n\nFixture body/);
    expect(card.buttons).toHaveLength(expectedRows);
    const callbacks = card.buttons.flat().map((button) => button.callbackData);
    expect(callbacks).toEqual(Object.values(tokens));
    expect(callbacks.every((value) => !value.includes('remote') && !value.includes('hybrid'))).toBe(true);
    if (kind === 'reply_text') expect(card.text.toLowerCase()).toContain('direct reply');
  });

  it('advances a multi-field wizard to review and confirmation', () => {
    const schema = {
      ...common,
      fields: [
        { name: 'location', label: 'Location', options: [option('remote', 'Remote'), option('hybrid', 'Hybrid')] },
        { name: 'cadence', label: 'Cadence', options: [option('daily', 'Daily'), option('weekly', 'Weekly')] },
      ],
      reviewLabel: 'Review',
      confirmLabel: 'Confirm',
    };
    const renderer = new TelegramRenderer();
    const render = (progress: Record<string, unknown>) => {
      const actions = interactionActions('multi_enum_object', schema, progress);
      return renderer.render(
        'multi_enum_object',
        schema,
        progress,
        Object.fromEntries(Object.keys(actions).map((key, index) => [key, `cb_${String(index + 1).padStart(24, '0')}`])),
      );
    };

    expect(render({}).text).toContain('Location');
    expect(render({ location: 'remote' }).text).toContain('Cadence');
    const review = render({ location: 'remote', cadence: 'weekly' });
    expect(review.text).toContain('Location: Remote');
    expect(review.text).toContain('Cadence: Weekly');
    expect(review.buttons.flat().map((button) => button.label)).toEqual(['Confirm', 'Start over']);
  });

  it('retries twice then atomically persists the sent-message and callback bindings', async () => {
    const interaction = store.submit(
      'jobsearch',
      'job-search',
      submission('single_enum', {
        ...common,
        options: [option('remote', 'Remote'), option('hybrid', 'Hybrid')],
      }),
    );
    const transport = new FakeTransport(2);
    const delivery = new TelegramDelivery(store, transport, { sleep: async () => undefined });

    const sent = await delivery.deliver(interaction.interactionId);

    expect(sent.messageId).toBe(9_001);
    expect(transport.calls).toBe(3);
    expect(store.getInteraction(interaction.interactionId)).toMatchObject({
      state: 'delivered',
      messageId: 9_001,
      chatId: -100_123,
      threadId: 42,
    });
    const bindings = store.activeCallbackBindings(interaction.interactionId);
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((binding) => binding.action))).toEqual(new Set(['choose']));
    expect(bindings.every((binding) => /^cb_[A-Za-z0-9_-]{16,60}$/.test(binding.token))).toBe(true);
  });

  it('stops after three confirmed failures and leaves the interaction queued for reconciliation', async () => {
    const interaction = store.submit(
      'jobsearch',
      'job-search',
      submission('notification', { ...common, acknowledgeLabel: 'Acknowledge' }),
    );
    const transport = new FakeTransport(3);
    const delivery = new TelegramDelivery(store, transport, { sleep: async () => undefined });

    await expect(delivery.deliver(interaction.interactionId)).rejects.toThrowError(DeliveryFailed);
    expect(transport.calls).toBe(3);
    expect(store.getInteraction(interaction.interactionId).state).toBe('queued');
    expect(store.activeCallbackBindings(interaction.interactionId)).toEqual([]);
  });

  it('delivers a passive notice once without buttons or retry', async () => {
    const interaction = store.submit('jobsearch', 'job-search', submission('notice', common));
    const transport = new FakeTransport(1);
    const delivery = new TelegramDelivery(store, transport, { sleep: async () => undefined });

    await expect(delivery.deliver(interaction.interactionId)).rejects.toThrowError(DeliveryFailed);
    expect(transport.calls).toBe(1);
    expect(transport.lastButtons).toEqual([]);
  });
});
