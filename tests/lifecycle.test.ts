import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResultLifecycle } from '../src/lifecycle.js';
import { Reconciler } from '../src/reconciler.js';
import { InteractionService } from '../src/service.js';
import { InteractionStore, StaleCallback, UnauthorizedContext } from '../src/store.js';
import type { ActionBinding, InteractionRecord, SubmissionRequest } from '../src/store.js';
import { TelegramDelivery, TelegramDeliveryError } from '../src/telegram.js';
import type { InlineButton, SentMessage, TelegramTransport } from '../src/telegram.js';

const common = {
  schemaVersion: 1 as const,
  revision: 1,
  title: 'Fixture',
  body: 'Fixture body',
  effect: 'Fixture effect',
};
const option = (value: string, label: string) => ({ value, label, effect: `Records ${label}.` });

const request = (
  key: string,
  type: SubmissionRequest['type'] = 'notification',
  schema: SubmissionRequest['schema'] = { ...common, acknowledgeLabel: 'Acknowledge' },
): SubmissionRequest => ({
  idempotencyKey: key,
  type,
  schema,
  destination: { chatId: -100_123, threadId: 42 },
  allowedUserId: 777,
});

const deliverWithBinding = (
  store: InteractionStore,
  interaction: InteractionRecord,
  token = 'cb_1234567890abcdefghijklmnop',
  binding: ActionBinding = { action: 'acknowledge', value: true },
): string => {
  store.recordDeliverySuccess(interaction.interactionId, {
    messageId: 9_001,
    chatId: -100_123,
    threadId: 42,
    bindings: { [token]: binding },
  });
  return token;
};

class RecoveringTransport implements TelegramTransport {
  calls = 0;
  constructor(private failuresRemaining: number) {}
  async sendMessage(input: {
    chatId: number;
    threadId: number | null;
    text: string;
    buttons: InlineButton[][];
  }): Promise<SentMessage> {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new TelegramDeliveryError('offline');
    }
    return { messageId: 9_002, chatId: input.chatId, threadId: input.threadId };
  }
}

describe('result lifecycle and reconciliation', () => {
  let directory: string;
  let now: Date;
  let store: InteractionStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telegram-lifecycle-'));
    now = new Date('2026-08-01T12:00:00.000Z');
    store = new InteractionStore(join(directory, 'interactions.db'), { clock: () => now });
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('records exactly one callback result and rejects replay', () => {
    const interaction = store.submit('jobsearch', 'job-search', request('callback-once'));
    const token = deliverWithBinding(store, interaction);
    const lifecycle = new ResultLifecycle(store);

    expect(
      lifecycle.handleCallback({ token, userId: 777, chatId: -100_123, threadId: 42 }),
    ).toMatchObject({ resolved: true, result: { acknowledged: true } });
    expect(() =>
      lifecycle.handleCallback({ token, userId: 777, chatId: -100_123, threadId: 42 }),
    ).toThrowError(StaleCallback);
    expect(store.pollResults('jobsearch', 'job-search')).toHaveLength(1);
  });

  it.each([
    [778, -100_123, 42],
    [777, -100_999, 42],
    [777, -100_123, 99],
  ])('rejects wrong user/chat/topic without mutation', (userId, chatId, threadId) => {
    const interaction = store.submit('jobsearch', 'job-search', request(`wrong-${userId}-${chatId}-${threadId}`));
    const token = deliverWithBinding(store, interaction);
    expect(() => new ResultLifecycle(store).handleCallback({ token, userId, chatId, threadId })).toThrowError(
      UnauthorizedContext,
    );
    expect(store.getInteraction(interaction.interactionId).state).toBe('delivered');
    expect(store.pollResults('jobsearch', 'job-search')).toEqual([]);
    expect(store.activeCallbackBindings(interaction.interactionId)[0]?.active).toBe(true);
  });

  it('advances a wizard, invalidates old tokens, then records the confirmed object', () => {
    const schema = {
      ...common,
      fields: [
        { name: 'location', label: 'Location', options: [option('remote', 'Remote')] },
        { name: 'cadence', label: 'Cadence', options: [option('weekly', 'Weekly')] },
      ],
      reviewLabel: 'Review',
      confirmLabel: 'Confirm',
    };
    const interaction = store.submit(
      'jobsearch',
      'job-search',
      request('wizard', 'multi_enum_object', schema),
    );
    const firstToken = deliverWithBinding(store, interaction, 'cb_first_1234567890abcdefghij', {
      action: 'wizard_select',
      value: { field: 'location', value: 'remote' },
    });
    const lifecycle = new ResultLifecycle(store);
    const second = lifecycle.handleCallback({
      token: firstToken,
      userId: 777,
      chatId: -100_123,
      threadId: 42,
    });
    expect(second.card?.text).toContain('Cadence');
    const secondToken = store.activeCallbackBindings(interaction.interactionId)[0]?.token as string;
    const review = lifecycle.handleCallback({
      token: secondToken,
      userId: 777,
      chatId: -100_123,
      threadId: 42,
    });
    expect(review.card?.text).toContain('Location: Remote');
    expect(() =>
      lifecycle.handleCallback({ token: firstToken, userId: 777, chatId: -100_123, threadId: 42 }),
    ).toThrowError(StaleCallback);
    const confirm = store.activeCallbackBindings(interaction.interactionId).find(
      (binding) => binding.action === 'wizard_confirm',
    );
    expect(
      lifecycle.handleCallback({
        token: confirm?.token as string,
        userId: 777,
        chatId: -100_123,
        threadId: 42,
      }).result,
    ).toEqual({ values: { location: 'remote', cadence: 'weekly' } });
  });

  it('only accepts reply text bound to the persisted parent message', () => {
    const interaction = store.submit(
      'jobsearch',
      'job-search',
      request('reply', 'reply_text', {
        ...common,
        minLength: 3,
        maxLength: 40,
        pattern: '^[A-Za-z ]+$',
        submitLabel: 'Reply directly',
      }),
    );
    deliverWithBinding(store, interaction, 'cb_unused_1234567890abcdef', { action: 'unused', value: null });
    const lifecycle = new ResultLifecycle(store);

    expect(
      lifecycle.handleReply({
        userId: 777,
        chatId: -100_123,
        threadId: 42,
        replyToMessageId: 9_999,
        text: 'Valid text',
      }),
    ).toBeNull();
    expect(
      lifecycle.handleReply({
        userId: 777,
        chatId: -100_123,
        threadId: 42,
        replyToMessageId: 9_001,
        text: 'Valid text',
      })?.result,
    ).toEqual({ text: 'Valid text' });
  });

  it('keeps choice and custom guidance in one interaction', () => {
    const interaction = store.submit('jobsearch', 'job-search', request('mixed', 'choice_with_optional_reply', {
      ...common,
      options: [option('drop_lead', 'Drop lead'), option('custom_guidance', 'Custom guidance')],
      replyOption: 'custom_guidance',
      reply: { minLength: 3, maxLength: 40, pattern: '^[A-Za-z ]+$', submitLabel: 'Send instructions' },
    }));
    const token = deliverWithBinding(store, interaction, 'cb_mixed_1234567890abcdef', { action: 'choose', value: 'custom_guidance' });
    const lifecycle = new ResultLifecycle(store);
    const advanced = lifecycle.handleCallback({ token, userId: 777, chatId: -100_123, threadId: 42 });
    expect(advanced.resolved).toBe(false);
    expect(advanced.result).toBeNull();
    expect(advanced.card?.text).toContain('Send instructions');
    expect(store.pollResults('jobsearch', 'job-search')).toEqual([]);
    expect(store.getInteraction(interaction.interactionId).progress).toEqual({ phase: 'awaiting_reply', selectedValue: 'custom_guidance' });

    expect(() => lifecycle.handleReply({ userId: 777, chatId: -100_123, threadId: 42, replyToMessageId: 9_001, text: 'bad!' })).toThrowError();
    const result = lifecycle.handleReply({ userId: 777, chatId: -100_123, threadId: 42, replyToMessageId: 9_001, text: 'Check eligibility' });
    expect(result?.result).toEqual({ value: 'custom_guidance', text: 'Check eligibility' });
    expect(store.pollResults('jobsearch', 'job-search')).toHaveLength(1);
  });
  it('polls and acknowledges results through the scoped socket-service operations', () => {
    const interaction = store.submit('jobsearch', 'job-search', request('service-result'));
    const token = deliverWithBinding(store, interaction);
    new ResultLifecycle(store).handleCallback({ token, userId: 777, chatId: -100_123, threadId: 42 });
    const service = new InteractionService(store);

    expect(service.handle({ op: 'poll-results', namespace: 'default', workflow: 'alerts' })).toEqual({
      ok: true,
      results: [],
    });
    const pending = service.handle({ op: 'poll-results', namespace: 'jobsearch', workflow: 'job-search' });
    expect(pending).toMatchObject({
      ok: true,
      results: [{ interactionId: interaction.interactionId, revision: 1, result: { acknowledged: true } }],
    });
    expect(
      service.handle({
        op: 'ack-result',
        namespace: 'jobsearch',
        workflow: 'job-search',
        interactionId: interaction.interactionId,
        revision: 99,
      }),
    ).toEqual({ ok: false, error: { code: 'stale_revision', message: 'result revision is stale' } });
    expect(
      service.handle({
        op: 'ack-result',
        namespace: 'jobsearch',
        workflow: 'job-search',
        interactionId: interaction.interactionId,
        revision: 1,
      }),
    ).toMatchObject({ ok: true, acknowledged: true });
  });

  it('retries unresolved delivery on a later reconciliation pass', async () => {
    const interaction = store.submit('jobsearch', 'job-search', request('retry'));
    const transport = new RecoveringTransport(3);
    const delivery = new TelegramDelivery(store, transport, { sleep: async () => undefined });
    const reconciler = new Reconciler(store, { delivery });

    expect(await reconciler.runOnce()).toMatchObject({ retried: 1, delivered: 0, failed: 1 });
    expect(await reconciler.runOnce()).toMatchObject({ retried: 1, delivered: 1, failed: 0 });
    expect(transport.calls).toBe(4);
    expect(store.getInteraction(interaction.interactionId).state).toBe('delivered');
  });

  it('records heartbeats and emits one delayed recovery notice after reconnect', async () => {
    store.recordHealthEvent('telegram_disconnected', { code: 'offline' });
    const notices: string[] = [];
    const reconciler = new Reconciler(store, { recoveryNotifier: async (message) => notices.push(message) });

    expect((await reconciler.runOnce()).recoveryNoticeEmitted).toBe(true);
    expect((await reconciler.runOnce()).recoveryNoticeEmitted).toBe(false);
    expect(notices).toEqual(['Telegram interaction delivery recovered after an outage.']);
    expect(store.healthEvents('heartbeat')).toHaveLength(2);
    expect(store.healthEvents('telegram_recovery_notice')).toHaveLength(1);
  });

  it('allows at most one service restart attempt per outage and has no gateway restart hook', async () => {
    let attempts = 0;
    const reconciler = new Reconciler(store, {
      restartService: async () => {
        attempts += 1;
        return true;
      },
    });

    expect((await reconciler.runOnce({ telegramConnected: false })).restartAttempted).toBe(true);
    expect((await reconciler.runOnce({ telegramConnected: false })).restartAttempted).toBe(false);
    expect(attempts).toBe(1);
    expect(store.healthEvents('service_restart_attempt')).toHaveLength(1);
  });

  it('deletes only acknowledged answers after the seven-day retention window', () => {
    const old = store.submit('jobsearch', 'job-search', request('cleanup'));
    store.recordResult(old.interactionId, { acknowledged: true }, 1);
    store.ackResult('jobsearch', 'job-search', old.interactionId, 1);
    now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1_000);

    expect(new Reconciler(store).cleanup()).toEqual([old.interactionId]);
  });
});
