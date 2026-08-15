import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IdempotencyConflict, InteractionStore } from '../src/store.js';
import type { SubmissionRequest } from '../src/store.js';

const DAY = 24 * 60 * 60 * 1_000;

const request = (key: string, title = 'Review'): SubmissionRequest => ({
  idempotencyKey: key,
  type: 'notification',
  schema: {
    schemaVersion: 1,
    revision: 1,
    title,
    body: 'A bounded fixture body',
    effect: 'Acknowledges this fixture notification',
    acknowledgeLabel: 'Acknowledge',
  },
  destination: { chatId: -100_123, threadId: 42 },
  allowedUserId: 777,
});

describe('InteractionStore', () => {
  let directory: string;
  let now: Date;
  let store: InteractionStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telegram-store-'));
    now = new Date('2026-08-01T12:00:00.000Z');
    store = new InteractionStore(join(directory, 'interactions.db'), { clock: () => now });
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('initializes every transactional table and passes SQLite integrity checking', () => {
    expect(store.health()).toEqual({
      integrity: 'ok',
      tables: [
        'callback_bindings',
        'delivery_attempts',
        'health_events',
        'interactions',
        'namespaces',
        'results',
      ],
    });
  });

  it('returns the original interaction for an identical idempotent submission', () => {
    const first = store.submit('jobsearch', 'job-search', request('packet-17-r1'));
    const second = store.submit('jobsearch', 'job-search', request('packet-17-r1'));

    expect(second).toEqual(first);
    expect(first.state).toBe('queued');
    expect(store.listInteractions('jobsearch', 'job-search')).toHaveLength(1);
  });

  it('rejects idempotency-key reuse with different immutable content', () => {
    store.submit('jobsearch', 'job-search', request('packet-17-r1'));
    expect(() => store.submit('jobsearch', 'job-search', request('packet-17-r1', 'Changed'))).toThrowError(
      IdempotencyConflict,
    );
  });

  it('strictly scopes interaction listing by namespace and workflow', () => {
    const expected = store.submit('jobsearch', 'job-search', request('job-1'));
    store.submit('default', 'alerts', request('default-1'));
    store.submit('jobsearch', 'other-workflow', request('job-other-1'));

    expect(store.listInteractions('jobsearch', 'job-search').map((item) => item.interactionId)).toEqual([
      expected.interactionId,
    ]);
  });

  it('does not requeue a failed passive notice for delivery retry', () => {
    const notice = store.submit('jobsearch', 'job-search', {
      idempotencyKey: 'scheduler-failure-1',
      type: 'notice',
      schema: {
        schemaVersion: 1,
        revision: 1,
        title: 'Scheduler failed',
        body: 'No substantive work ran.',
        effect: 'Review repair state.',
      },
      destination: { chatId: -100_123, threadId: 42 },
      allowedUserId: 777,
    });

    store.recordDeliveryAttempt(notice.interactionId, 'failed', 'transport_failed');

    expect(store.listPendingDelivery().map((item) => item.interactionId)).not.toContain(notice.interactionId);
  });

  it('records one immutable result and exposes it until a revision-bound acknowledgement', () => {
    const interaction = store.submit('jobsearch', 'job-search', request('result-1'));
    const first = store.recordResult(interaction.interactionId, { acknowledged: true }, 1);
    const second = store.recordResult(interaction.interactionId, { acknowledged: true }, 1);

    expect(second).toEqual(first);
    expect(store.pollResults('jobsearch', 'job-search')).toEqual([first]);
    store.ackResult('jobsearch', 'job-search', interaction.interactionId, 1);
    expect(store.pollResults('jobsearch', 'job-search')).toEqual([]);
  });

  it('only cleans answered records older than seven days after workflow acknowledgement', () => {
    const oldAcknowledged = store.submit('jobsearch', 'job-search', request('old-acked'));
    const oldUnacknowledged = store.submit('jobsearch', 'job-search', request('old-open'));
    const unresolved = store.submit('jobsearch', 'job-search', request('unresolved'));
    store.recordResult(oldAcknowledged.interactionId, { acknowledged: true }, 1);
    store.ackResult('jobsearch', 'job-search', oldAcknowledged.interactionId, 1);
    store.recordResult(oldUnacknowledged.interactionId, { acknowledged: true }, 1);

    now = new Date(now.getTime() + 8 * DAY);

    expect(store.cleanupEligible('jobsearch', 'job-search', 7 * DAY).map((item) => item.interactionId)).toEqual([
      oldAcknowledged.interactionId,
    ]);
    expect(store.deleteCleanupEligible(7 * DAY)).toEqual([oldAcknowledged.interactionId]);
    expect(store.listInteractions('jobsearch', 'job-search').map((item) => item.interactionId)).toEqual(
      expect.arrayContaining([oldUnacknowledged.interactionId, unresolved.interactionId]),
    );
  });
});
