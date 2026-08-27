import { SchemaValidationError, validateSchema } from './schemas.js';
import type { InteractionKind } from './schemas.js';
import { StoreError } from './store.js';
import type { Destination, InteractionStore, SubmissionRequest } from './store.js';

const scopePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const supportedKinds = new Set<InteractionKind>([
  'notice',
  'notification',
  'single_enum',
  'multi_enum_object',
  'reply_text',
]);

export type ServiceResponse = Record<string, unknown> & { ok: boolean };

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknown.length > 0) throw new RequestError('invalid_request', `unknown ${label} fields: ${unknown.join(', ')}`);
}

export class InteractionService {
  constructor(
    private readonly store: InteractionStore,
    private readonly defaults?: { defaultDestination: Destination; defaultAllowedUserId: number },
  ) {}

  readonly handle = (message: unknown): ServiceResponse => {
    try {
      if (!isRecord(message)) throw new RequestError('invalid_request', 'request must be one JSON object');
      const operation = message.op;
      if (typeof operation !== 'string') throw new RequestError('invalid_request', 'op must be a string');
      switch (operation) {
        case 'submit':
          return this.submit(message);
        case 'poll-results':
          return this.pollResults(message);
        case 'ack-result':
          return this.ackResult(message);
        case 'lookup':
          return this.lookup(message);
        case 'heartbeat': {
          const event = this.store.recordHealthEvent('heartbeat', { status: 'ok' });
          return { ok: true, eventId: event.eventId, status: 'ok' };
        }
        default:
          throw new RequestError('unknown_operation', `unsupported operation: ${operation}`);
      }
    } catch (error) {
      if (error instanceof RequestError || error instanceof SchemaValidationError || error instanceof StoreError) {
        return {
          ok: false,
          error: {
            code: error instanceof RequestError ? error.code : error.code,
            message: error.message,
          },
        };
      }
      throw error;
    }
  };

  private submit(message: Record<string, unknown>): ServiceResponse {
    const namespace = this.scope(message, 'namespace');
    const workflow = this.scope(message, 'workflow');
    if (!isRecord(message.request)) throw new RequestError('invalid_request', 'request must be an object');
    const request = this.submission(message.request);
    const record = this.store.submit(namespace, workflow, request);
    return {
      ok: true,
      interactionId: record.interactionId,
      state: record.state,
      revision: record.revision,
    };
  }

  private pollResults(message: Record<string, unknown>): ServiceResponse {
    const namespace = this.scope(message, 'namespace');
    const workflow = this.scope(message, 'workflow');
    const limit = message.limit ?? 100;
    if (!Number.isInteger(limit) || typeof limit !== 'number' || limit < 1 || limit > 100) {
      throw new RequestError('invalid_request', 'limit must be an integer from 1 to 100');
    }
    return {
      ok: true,
      results: this.store.pollResults(namespace, workflow, limit).map((result) => ({
        interactionId: result.interactionId,
        revision: result.revision,
        result: result.result,
        recordedAt: result.recordedAt,
      })),
    };
  }

  private ackResult(message: Record<string, unknown>): ServiceResponse {
    const namespace = this.scope(message, 'namespace');
    const workflow = this.scope(message, 'workflow');
    const interactionId = message.interactionId;
    const revision = message.revision;
    if (typeof interactionId !== 'string' || interactionId.length < 1 || interactionId.length > 64) {
      throw new RequestError('invalid_request', 'interactionId must be a bounded string');
    }
    if (!Number.isInteger(revision) || typeof revision !== 'number' || revision < 1) {
      throw new RequestError('invalid_request', 'revision must be a positive integer');
    }
    this.store.ackResult(namespace, workflow, interactionId, revision);
    return { ok: true, interactionId, acknowledged: true };
  }

  private lookup(message: Record<string, unknown>): ServiceResponse {
    const namespace = this.scope(message, 'namespace');
    const workflow = this.scope(message, 'workflow');
    rejectUnknown(message, new Set(['op', 'namespace', 'workflow', 'idempotencyKey']), 'lookup');
    const idempotencyKey = message.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      throw new RequestError('invalid_request', 'idempotencyKey must be a string of 1 to 128 characters');
    }
    const record = this.store.findByIdempotency(namespace, workflow, idempotencyKey);
    return {
      ok: true,
      found: record !== null,
      ...(record === null ? {} : { interactionId: record.interactionId, state: record.state, revision: record.revision }),
    };
  }

  private scope(message: Record<string, unknown>, key: 'namespace' | 'workflow'): string {
    const value = message[key];
    if (typeof value !== 'string' || !scopePattern.test(value)) {
      throw new RequestError('invalid_scope', `${key} must be a bounded lowercase namespace`);
    }
    return value;
  }

  private submission(request: Record<string, unknown>): SubmissionRequest {
    rejectUnknown(
      request,
      new Set(['idempotencyKey', 'type', 'schema', 'destination', 'allowedUserId']),
      'request',
    );
    const idempotencyKey = request.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      throw new RequestError('invalid_request', 'idempotencyKey must be a string of 1 to 128 characters');
    }
    const kind = request.type;
    if (typeof kind !== 'string' || !supportedKinds.has(kind as InteractionKind)) {
      throw new RequestError('invalid_request', 'type is not a supported interaction primitive');
    }
    const schema = validateSchema(kind, request.schema);
    const destinationOverride = request.destination;
    if (destinationOverride !== undefined && !isRecord(destinationOverride)) throw new RequestError('invalid_request', 'destination must be an object');
    if (isRecord(destinationOverride)) rejectUnknown(destinationOverride, new Set(['chatId', 'threadId']), 'destination');
    const chatId = destinationOverride && destinationOverride.chatId !== undefined ? destinationOverride.chatId : this.defaults?.defaultDestination.chatId;
    const threadId = destinationOverride && destinationOverride.threadId !== undefined ? destinationOverride.threadId : this.defaults?.defaultDestination.threadId;
    if (chatId === undefined) throw new RequestError('service_config', 'fixed Telegram target is not configured');
    if (!Number.isInteger(chatId) || typeof chatId !== 'number') {
      throw new RequestError('invalid_request', 'destination.chatId must be an integer');
    }
    if (threadId !== undefined && (!Number.isInteger(threadId) || typeof threadId !== 'number' || threadId < 1)) {
      throw new RequestError('invalid_request', 'destination.threadId must be a positive integer when present');
    }
    const allowedUserId = request.allowedUserId === undefined ? this.defaults?.defaultAllowedUserId : request.allowedUserId;
    if (allowedUserId === undefined) throw new RequestError('service_config', 'fixed Telegram operator is not configured');
    if (!Number.isInteger(allowedUserId) || typeof allowedUserId !== 'number' || allowedUserId < 1) {
      throw new RequestError('invalid_request', 'allowedUserId must be a positive integer');
    }
    const destination = threadId === undefined ? { chatId } : { chatId, threadId };
    return {
      idempotencyKey,
      type: kind as InteractionKind,
      schema,
      destination,
      allowedUserId,
    };
  }
}
