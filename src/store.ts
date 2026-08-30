import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { InteractionKind, InteractionSchema } from './schemas.js';

export type InteractionState = 'queued' | 'delivered' | 'delivery_uncertain' | 'answered' | 'failed';

export interface Destination {
  chatId: number;
  threadId?: number;
}

export interface SubmissionRequest {
  idempotencyKey: string;
  type: InteractionKind;
  schema: InteractionSchema;
  destination: Destination;
  allowedUserId: number;
}

export interface InteractionRecord {
  interactionId: string;
  namespace: string;
  workflow: string;
  idempotencyKey: string;
  kind: InteractionKind;
  schema: InteractionSchema;
  destination: Destination;
  allowedUserId: number;
  revision: number;
  token: string;
  state: InteractionState;
  progress: Record<string, unknown>;
  messageId: number | null;
  chatId: number | null;
  threadId: number | null;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
}

export interface ResultRecord {
  interactionId: string;
  namespace: string;
  workflow: string;
  revision: number;
  result: Record<string, unknown>;
  recordedAt: string;
  acknowledgedAt: string | null;
}

export interface CallbackBinding {
  token: string;
  interactionId: string;
  action: string;
  value: unknown;
  revision: number;
  active: boolean;
  createdAt: string;
  consumedAt: string | null;
}

export interface CallbackContext {
  binding: CallbackBinding;
  interaction: InteractionRecord;
}

export interface HealthEvent {
  eventId: number;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ActionBinding {
  action: string;
  value: unknown;
}

export interface InboundContext {
  userId: number;
  chatId: number;
  threadId: number | null;
}

export class StoreError extends Error {
  readonly code: string = 'store_error';

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IdempotencyConflict extends StoreError {
  override readonly code = 'idempotency_conflict';
}

export class InteractionNotFound extends StoreError {
  override readonly code = 'interaction_not_found';
}

export class InvalidTransition extends StoreError {
  override readonly code = 'invalid_transition';
}

export class StaleRevision extends StoreError {
  override readonly code = 'stale_revision';
}

export class StaleCallback extends StoreError {
  override readonly code = 'stale_callback';
}

export class UnauthorizedContext extends StoreError {
  override readonly code = 'unauthorized_context';
}

interface InteractionRow {
  id: string;
  namespace: string;
  workflow: string;
  idempotency_key: string;
  kind: InteractionKind;
  schema_json: string;
  destination_json: string;
  allowed_user_id: number;
  revision: number;
  token: string;
  state: InteractionState;
  progress_json: string;
  message_id: number | null;
  chat_id: number | null;
  thread_id: number | null;
  created_at: string;
  updated_at: string;
  answered_at: string | null;
  request_hash: string;
}

interface ResultRow {
  id: string;
  interaction_id: string;
  revision: number;
  result_json: string;
  recorded_at: string;
  acked_at: string | null;
  namespace?: string;
  workflow?: string;
}

interface CallbackRow {
  token: string;
  interaction_id: string;
  action: string;
  value_json: string | null;
  revision: number;
  active: number;
  created_at: string;
  consumed_at: string | null;
}

interface HealthRow {
  id: number;
  kind: string;
  detail_json: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS namespaces (
  id INTEGER PRIMARY KEY,
  namespace TEXT NOT NULL,
  workflow TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(namespace, workflow)
);
CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  namespace_id INTEGER NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('notice', 'notification', 'single_enum', 'multi_enum_object', 'reply_text', 'choice_with_optional_reply')),
  schema_json TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  allowed_user_id INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('queued', 'delivered', 'delivery_uncertain', 'answered', 'failed')),
  progress_json TEXT NOT NULL DEFAULT '{}',
  message_id INTEGER,
  chat_id INTEGER,
  thread_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  answered_at TEXT,
  UNIQUE(namespace_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed', 'uncertain')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(interaction_id, attempt_number)
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  acked_at TEXT
);
CREATE TABLE IF NOT EXISTS health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS callback_bindings (
  token TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  value_json TEXT,
  revision INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS interactions_state_idx ON interactions(state, updated_at);
CREATE INDEX IF NOT EXISTS results_ack_idx ON results(acked_at, recorded_at);
CREATE INDEX IF NOT EXISTS callback_interaction_idx ON callback_bindings(interaction_id, active);
`;

const interactionSelect =
  'SELECT i.*, n.namespace, n.workflow FROM interactions i JOIN namespaces n ON n.id = i.namespace_id';

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function decodeObject(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

export class InteractionStore {
  private readonly database: Database.Database;
  private readonly clock: () => Date;
  private closed = false;

  constructor(path: string, options: { clock?: () => Date } = {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path);
    this.clock = options.clock ?? (() => new Date());
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 10000');
    this.database.pragma('journal_mode = WAL');
    this.database.exec(SCHEMA);
    this.migrateNoticeKind();
    chmodSync(path, 0o600);
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  health(): { integrity: string; tables: string[] } {
    const integrity = (this.database.pragma('integrity_check', { simple: true }) as string | undefined) ?? 'missing-result';
    const rows = this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return { integrity, tables: rows.map((row) => row.name) };
  }

  private migrateNoticeKind(): void {
    const row = this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'interactions'").get() as { sql?: string } | undefined;
    if (row?.sql?.includes("'choice_with_optional_reply'")) return;
    this.database.exec(`
      PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;
      CREATE TABLE interactions_v2 (
        id TEXT PRIMARY KEY, namespace_id INTEGER NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('notice', 'notification', 'single_enum', 'multi_enum_object', 'reply_text', 'choice_with_optional_reply')),
        schema_json TEXT NOT NULL, destination_json TEXT NOT NULL, allowed_user_id INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0), token TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('queued', 'delivered', 'delivery_uncertain', 'answered', 'failed')),
        progress_json TEXT NOT NULL DEFAULT '{}', message_id INTEGER, chat_id INTEGER, thread_id INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, answered_at TEXT,
        UNIQUE(namespace_id, idempotency_key)
      );
      INSERT INTO interactions_v2 SELECT * FROM interactions;
      DROP TABLE interactions; ALTER TABLE interactions_v2 RENAME TO interactions;
      CREATE INDEX interactions_state_idx ON interactions(state, updated_at);
      COMMIT; PRAGMA foreign_keys = ON;
    `);
  }

  submit(namespace: string, workflow: string, request: SubmissionRequest): InteractionRecord {
    const requestHash = createHash('sha256').update(canonicalJson(request)).digest('hex');
    const now = this.now();
    const execute = this.database.transaction(() => {
      this.database
        .prepare(
          'INSERT INTO namespaces(namespace, workflow, created_at) VALUES (?, ?, ?) ON CONFLICT(namespace, workflow) DO NOTHING',
        )
        .run(namespace, workflow, now);
      const namespaceRow = this.database
        .prepare('SELECT id FROM namespaces WHERE namespace = ? AND workflow = ?')
        .get(namespace, workflow) as { id: number } | undefined;
      if (namespaceRow === undefined) throw new StoreError('failed to create namespace');

      const existing = this.database
        .prepare(`${interactionSelect} WHERE i.namespace_id = ? AND i.idempotency_key = ?`)
        .get(namespaceRow.id, request.idempotencyKey) as InteractionRow | undefined;
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) {
          throw new IdempotencyConflict('idempotency key already exists with different content');
        }
        return this.mapInteraction(existing);
      }

      const interactionId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO interactions(
             id, namespace_id, idempotency_key, request_hash, kind, schema_json,
             destination_json, allowed_user_id, revision, token, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          interactionId,
          namespaceRow.id,
          request.idempotencyKey,
          requestHash,
          request.type,
          canonicalJson(request.schema),
          canonicalJson(request.destination),
          request.allowedUserId,
          request.schema.revision,
          randomBytes(24).toString('base64url'),
          now,
          now,
        );
      return this.requireInteraction(interactionId);
    });
    return execute.immediate();
  }

  getInteraction(interactionId: string): InteractionRecord {
    return this.requireInteraction(interactionId);
  }

  findByIdempotency(namespace: string, workflow: string, idempotencyKey: string): InteractionRecord | null {
    const row = this.database
      .prepare(`${interactionSelect} WHERE n.namespace = ? AND n.workflow = ? AND i.idempotency_key = ?`)
      .get(namespace, workflow, idempotencyKey) as InteractionRow | undefined;
    return row === undefined ? null : this.mapInteraction(row);
  }

  listInteractions(
    namespace: string,
    workflow: string,
    options: { states?: InteractionState[] } = {},
  ): InteractionRecord[] {
    const states = options.states ?? [];
    const placeholders = states.map(() => '?').join(',');
    const stateClause = states.length > 0 ? ` AND i.state IN (${placeholders})` : '';
    const rows = this.database
      .prepare(
        `${interactionSelect} WHERE n.namespace = ? AND n.workflow = ?${stateClause} ORDER BY i.created_at, i.id`,
      )
      .all(namespace, workflow, ...states) as InteractionRow[];
    return rows.map((row) => this.mapInteraction(row));
  }

  listPendingDelivery(): InteractionRecord[] {
    const rows = this.database
      .prepare(`${interactionSelect}
        WHERE i.state IN ('queued', 'delivery_uncertain')
          AND (i.kind <> 'notice' OR NOT EXISTS (
            SELECT 1 FROM delivery_attempts AS attempt WHERE attempt.interaction_id = i.id
          ))
        ORDER BY i.updated_at, i.id`)
      .all() as InteractionRow[];
    return rows.map((row) => this.mapInteraction(row));
  }

  requeueUnansweredForContext(chatId: number, threadId: number | null, userId: number): InteractionRecord[] {
    const rows = this.database
      .prepare(`${interactionSelect} WHERE i.state <> 'answered' ORDER BY i.updated_at, i.id`)
      .all() as InteractionRow[];
    const interactions = rows.map((row) => this.mapInteraction(row)).filter(
      (interaction) =>
        interaction.allowedUserId === userId &&
        interaction.destination.chatId === chatId &&
        (interaction.destination.threadId ?? null) === threadId,
    );
    if (interactions.length === 0) return [];
    const now = this.now();
    const execute = this.database.transaction(() => {
      for (const interaction of interactions) {
        this.deactivateBindings(interaction.interactionId, now);
        this.database
          .prepare("UPDATE interactions SET state = 'queued', message_id = NULL, chat_id = NULL, thread_id = NULL, updated_at = ? WHERE id = ? AND state <> 'answered'")
          .run(now, interaction.interactionId);
      }
    });
    execute.immediate();
    return this.listPendingDelivery().filter((interaction) => interactions.some((candidate) => candidate.interactionId === interaction.interactionId));
  }

  recordDeliveryAttempt(
    interactionId: string,
    status: 'failed' | 'uncertain',
    errorCode: string | null,
  ): number {
    const execute = this.database.transaction(() => {
      const row = this.database.prepare('SELECT state FROM interactions WHERE id = ?').get(interactionId) as
        | { state: InteractionState }
        | undefined;
      if (row === undefined) throw new InteractionNotFound(`interaction not found: ${interactionId}`);
      if (row.state !== 'queued' && row.state !== 'delivery_uncertain') {
        throw new InvalidTransition(`cannot record delivery attempt in state ${row.state}`);
      }
      const attempt = this.nextAttempt(interactionId);
      const now = this.now();
      this.database
        .prepare(
          'INSERT INTO delivery_attempts(interaction_id, attempt_number, status, error_code, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(interactionId, attempt, status, errorCode, now);
      if (status === 'uncertain') {
        this.database
          .prepare("UPDATE interactions SET state = 'delivery_uncertain', updated_at = ? WHERE id = ?")
          .run(now, interactionId);
      }
      return attempt;
    });
    return execute.immediate();
  }

  recordDeliverySuccess(
    interactionId: string,
    delivery: { messageId: number; chatId: number; threadId: number | null; bindings: Record<string, ActionBinding> },
  ): number {
    const execute = this.database.transaction(() => {
      const row = this.database.prepare('SELECT state, revision FROM interactions WHERE id = ?').get(interactionId) as
        | { state: InteractionState; revision: number }
        | undefined;
      if (row === undefined) throw new InteractionNotFound(`interaction not found: ${interactionId}`);
      if (row.state !== 'queued' && row.state !== 'delivery_uncertain') {
        throw new InvalidTransition(`cannot deliver interaction in state ${row.state}`);
      }
      const now = this.now();
      const attempt = this.nextAttempt(interactionId);
      this.database
        .prepare(
          "INSERT INTO delivery_attempts(interaction_id, attempt_number, status, error_code, created_at) VALUES (?, ?, 'succeeded', NULL, ?)",
        )
        .run(interactionId, attempt, now);
      this.deactivateBindings(interactionId, now);
      this.insertBindings(interactionId, row.revision, delivery.bindings, now);
      this.database
        .prepare(
          "UPDATE interactions SET state = 'delivered', message_id = ?, chat_id = ?, thread_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(delivery.messageId, delivery.chatId, delivery.threadId, now, interactionId);
      return attempt;
    });
    return execute.immediate();
  }

  activeCallbackBindings(interactionId: string): CallbackBinding[] {
    const rows = this.database
      .prepare('SELECT * FROM callback_bindings WHERE interaction_id = ? AND active = 1 ORDER BY created_at, token')
      .all(interactionId) as CallbackRow[];
    return rows.map((row) => this.mapBinding(row));
  }

  callbackContext(token: string): CallbackContext {
    const bindingRow = this.database.prepare('SELECT * FROM callback_bindings WHERE token = ?').get(token) as
      | CallbackRow
      | undefined;
    if (bindingRow === undefined) throw new StaleCallback('callback is stale or unknown');
    return {
      binding: this.mapBinding(bindingRow),
      interaction: this.requireInteraction(bindingRow.interaction_id),
    };
  }

  applyCallback(
    token: string,
    context: InboundContext,
    update:
      | { result: Record<string, unknown> }
      | { progress: Record<string, unknown>; bindings: Record<string, ActionBinding> },
  ): { interaction: InteractionRecord; result: ResultRecord | null } {
    const execute = this.database.transaction(() => {
      const binding = this.database.prepare('SELECT * FROM callback_bindings WHERE token = ?').get(token) as
        | CallbackRow
        | undefined;
      if (binding === undefined || binding.active !== 1) throw new StaleCallback('callback is stale or unknown');
      const interaction = this.requireInteraction(binding.interaction_id);
      if (interaction.state !== 'delivered') throw new StaleCallback('callback is stale for the current interaction state');
      if (binding.revision !== interaction.revision) {
        throw new StaleCallback('callback is stale for the current interaction revision');
      }
      this.validateInboundContext(interaction, context);
      const now = this.now();
      this.deactivateBindings(interaction.interactionId, now);

      let result: ResultRecord | null = null;
      if ('result' in update) {
        result = this.insertResult(interaction, update.result, now);
        this.database
          .prepare("UPDATE interactions SET state = 'answered', answered_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, interaction.interactionId);
      } else {
        this.database
          .prepare('UPDATE interactions SET progress_json = ?, updated_at = ? WHERE id = ?')
          .run(canonicalJson(update.progress), now, interaction.interactionId);
        this.insertBindings(interaction.interactionId, interaction.revision, update.bindings, now);
      }
      return { interaction: this.requireInteraction(interaction.interactionId), result };
    });
    return execute.immediate();
  }

  findReplyInteraction(chatId: number, threadId: number | null, messageId: number): InteractionRecord | null {
    const row = this.database
      .prepare(
        `${interactionSelect} WHERE i.state = 'delivered' AND (i.kind = 'reply_text' OR (i.kind = 'choice_with_optional_reply' AND json_extract(i.progress_json, '$.phase') = 'awaiting_reply')) AND i.chat_id = ? AND i.thread_id IS ? AND i.message_id = ?`,
      )
      .get(chatId, threadId, messageId) as InteractionRow | undefined;
    return row === undefined ? null : this.mapInteraction(row);
  }

  recordReplyResult(
    interactionId: string,
    context: InboundContext & { replyToMessageId: number },
    result: Record<string, unknown>,
  ): ResultRecord {
    const execute = this.database.transaction(() => {
      const interaction = this.requireInteraction(interactionId);
      if (
        !['reply_text', 'choice_with_optional_reply'].includes(interaction.kind) ||
        interaction.state !== 'delivered' ||
        interaction.messageId !== context.replyToMessageId
      ) {
        throw new StaleCallback('reply binding is stale');
      }
      if (interaction.kind === 'choice_with_optional_reply' && interaction.progress.phase !== 'awaiting_reply') {
        throw new StaleCallback('reply binding is stale');
      }
      this.validateInboundContext(interaction, context);
      const now = this.now();
      const record = this.insertResult(interaction, result, now);
      this.deactivateBindings(interactionId, now);
      this.database
        .prepare("UPDATE interactions SET state = 'answered', answered_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, interactionId);
      return record;
    });
    return execute.immediate();
  }

  recordResult(interactionId: string, result: Record<string, unknown>, revision: number): ResultRecord {
    const execute = this.database.transaction(() => {
      const interaction = this.requireInteraction(interactionId);
      if (interaction.revision !== revision) throw new StaleRevision('interaction revision is stale');
      const existing = this.database.prepare('SELECT * FROM results WHERE interaction_id = ?').get(interactionId) as
        | ResultRow
        | undefined;
      if (existing !== undefined) {
        if (existing.revision !== revision || existing.result_json !== canonicalJson(result)) {
          throw new InvalidTransition('interaction already has a different result');
        }
        return this.mapResult(existing, interaction.namespace, interaction.workflow);
      }
      if (!['queued', 'delivered', 'delivery_uncertain'].includes(interaction.state)) {
        throw new InvalidTransition(`cannot answer interaction in state ${interaction.state}`);
      }
      const now = this.now();
      const record = this.insertResult(interaction, result, now);
      this.database
        .prepare("UPDATE interactions SET state = 'answered', answered_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, interactionId);
      return record;
    });
    return execute.immediate();
  }

  ackResult(namespace: string, workflow: string, interactionId: string, revision: number): ResultRecord {
    const execute = this.database.transaction(() => {
      let row = this.database
        .prepare(
          `SELECT r.*, n.namespace, n.workflow FROM results r
           JOIN interactions i ON i.id = r.interaction_id
           JOIN namespaces n ON n.id = i.namespace_id
           WHERE r.interaction_id = ? AND n.namespace = ? AND n.workflow = ?`,
        )
        .get(interactionId, namespace, workflow) as ResultRow | undefined;
      if (row === undefined) throw new InteractionNotFound('result not found in namespace/workflow');
      if (row.revision !== revision) throw new StaleRevision('result revision is stale');
      if (row.acked_at === null) {
        this.database.prepare('UPDATE results SET acked_at = ? WHERE id = ?').run(this.now(), row.id);
        row = this.database
          .prepare(
            `SELECT r.*, n.namespace, n.workflow FROM results r
             JOIN interactions i ON i.id = r.interaction_id
             JOIN namespaces n ON n.id = i.namespace_id WHERE r.id = ?`,
          )
          .get(row.id) as ResultRow;
      }
      return this.mapResult(row, namespace, workflow);
    });
    return execute.immediate();
  }

  pollResults(namespace: string, workflow: string, limit = 100): ResultRecord[] {
    const rows = this.database
      .prepare(
        `SELECT r.*, n.namespace, n.workflow FROM results r
         JOIN interactions i ON i.id = r.interaction_id
         JOIN namespaces n ON n.id = i.namespace_id
         WHERE n.namespace = ? AND n.workflow = ? AND r.acked_at IS NULL
         ORDER BY r.recorded_at, r.id LIMIT ?`,
      )
      .all(namespace, workflow, limit) as ResultRow[];
    return rows.map((row) => this.mapResult(row, namespace, workflow));
  }

  cleanupEligible(namespace: string, workflow: string, retentionMs: number): InteractionRecord[] {
    const cutoff = this.timestamp(new Date(this.clock().getTime() - retentionMs));
    const rows = this.database
      .prepare(
        `${interactionSelect} JOIN results r ON r.interaction_id = i.id
         WHERE n.namespace = ? AND n.workflow = ? AND i.state = 'answered'
         AND r.acked_at IS NOT NULL AND i.answered_at <= ? ORDER BY i.answered_at, i.id`,
      )
      .all(namespace, workflow, cutoff) as InteractionRow[];
    return rows.map((row) => this.mapInteraction(row));
  }

  deleteCleanupEligible(retentionMs: number): string[] {
    const cutoff = this.timestamp(new Date(this.clock().getTime() - retentionMs));
    const execute = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT i.id FROM interactions i JOIN results r ON r.interaction_id = i.id
           WHERE i.state = 'answered' AND r.acked_at IS NOT NULL AND i.answered_at <= ?
           ORDER BY i.answered_at, i.id`,
        )
        .all(cutoff) as Array<{ id: string }>;
      const ids = rows.map((row) => row.id);
      if (ids.length > 0) {
        this.database.prepare(`DELETE FROM interactions WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      }
      return ids;
    });
    return execute.immediate();
  }

  recordHealthEvent(kind: string, detail: Record<string, unknown>): HealthEvent {
    if (kind.length < 1 || kind.length > 64) throw new RangeError('health event kind must contain 1 to 64 characters');
    const encoded = canonicalJson(detail);
    if (Buffer.byteLength(encoded) > 4_096) throw new RangeError('health event detail exceeds 4096 bytes');
    const createdAt = this.now();
    const result = this.database
      .prepare('INSERT INTO health_events(kind, detail_json, created_at) VALUES (?, ?, ?)')
      .run(kind, encoded, createdAt);
    return { eventId: Number(result.lastInsertRowid), kind, detail: JSON.parse(encoded) as Record<string, unknown>, createdAt };
  }

  healthEvents(kind?: string): HealthEvent[] {
    const rows = (kind === undefined
      ? this.database.prepare('SELECT * FROM health_events ORDER BY id').all()
      : this.database.prepare('SELECT * FROM health_events WHERE kind = ? ORDER BY id').all(kind)) as HealthRow[];
    return rows.map((row) => ({
      eventId: row.id,
      kind: row.kind,
      detail: decodeObject(row.detail_json),
      createdAt: row.created_at,
    }));
  }

  hasOpenOutage(): boolean {
    return this.latestHealthId('telegram_disconnected') > this.latestHealthId('telegram_recovery_notice');
  }

  restartAttemptPending(): boolean {
    const disconnected = this.latestHealthId('telegram_disconnected');
    return disconnected > this.latestHealthId('telegram_recovery_notice') && disconnected > this.latestHealthId('service_restart_attempt');
  }

  private requireInteraction(interactionId: string): InteractionRecord {
    const row = this.database.prepare(`${interactionSelect} WHERE i.id = ?`).get(interactionId) as
      | InteractionRow
      | undefined;
    if (row === undefined) throw new InteractionNotFound(`interaction not found: ${interactionId}`);
    return this.mapInteraction(row);
  }

  private mapInteraction(row: InteractionRow): InteractionRecord {
    return {
      interactionId: row.id,
      namespace: row.namespace,
      workflow: row.workflow,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      schema: JSON.parse(row.schema_json) as InteractionSchema,
      destination: JSON.parse(row.destination_json) as Destination,
      allowedUserId: row.allowed_user_id,
      revision: row.revision,
      token: row.token,
      state: row.state,
      progress: decodeObject(row.progress_json),
      messageId: row.message_id,
      chatId: row.chat_id,
      threadId: row.thread_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      answeredAt: row.answered_at,
    };
  }

  private mapResult(row: ResultRow, namespace: string, workflow: string): ResultRecord {
    return {
      interactionId: row.interaction_id,
      namespace,
      workflow,
      revision: row.revision,
      result: decodeObject(row.result_json),
      recordedAt: row.recorded_at,
      acknowledgedAt: row.acked_at,
    };
  }

  private mapBinding(row: CallbackRow): CallbackBinding {
    return {
      token: row.token,
      interactionId: row.interaction_id,
      action: row.action,
      value: row.value_json === null ? null : (JSON.parse(row.value_json) as unknown),
      revision: row.revision,
      active: row.active === 1,
      createdAt: row.created_at,
      consumedAt: row.consumed_at,
    };
  }

  private insertResult(interaction: InteractionRecord, result: Record<string, unknown>, now: string): ResultRecord {
    const id = randomUUID();
    this.database
      .prepare('INSERT INTO results(id, interaction_id, revision, result_json, recorded_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, interaction.interactionId, interaction.revision, canonicalJson(result), now);
    const row = this.database.prepare('SELECT * FROM results WHERE id = ?').get(id) as ResultRow;
    return this.mapResult(row, interaction.namespace, interaction.workflow);
  }

  private insertBindings(
    interactionId: string,
    revision: number,
    bindings: Record<string, ActionBinding>,
    now: string,
  ): void {
    const statement = this.database.prepare(
      'INSERT INTO callback_bindings(token, interaction_id, action, value_json, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [token, binding] of Object.entries(bindings)) {
      statement.run(token, interactionId, binding.action, canonicalJson(binding.value), revision, now);
    }
  }

  private deactivateBindings(interactionId: string, now: string): void {
    this.database
      .prepare('UPDATE callback_bindings SET active = 0, consumed_at = ? WHERE interaction_id = ? AND active = 1')
      .run(now, interactionId);
  }

  private validateInboundContext(interaction: InteractionRecord, context: InboundContext): void {
    if (
      interaction.allowedUserId !== context.userId ||
      interaction.destination.chatId !== context.chatId ||
      (interaction.destination.threadId ?? null) !== context.threadId ||
      interaction.chatId !== context.chatId ||
      interaction.threadId !== context.threadId
    ) {
      throw new UnauthorizedContext('source does not match interaction binding');
    }
  }

  private nextAttempt(interactionId: string): number {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt FROM delivery_attempts WHERE interaction_id = ?')
      .get(interactionId) as { attempt: number };
    return row.attempt;
  }

  private latestHealthId(kind: string): number {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM health_events WHERE kind = ?')
      .get(kind) as { id: number };
    return row.id;
  }

  private now(): string {
    return this.timestamp(this.clock());
  }

  private timestamp(value: Date): string {
    if (Number.isNaN(value.getTime())) throw new RangeError('clock must return a valid Date');
    return value.toISOString();
  }
}
