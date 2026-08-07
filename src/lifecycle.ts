import { randomBytes } from 'node:crypto';

import { validateReplyText } from './schemas.js';
import type { ReplyTextSchema } from './schemas.js';
import { StaleCallback } from './store.js';
import type { ActionBinding, InboundContext, InteractionRecord, InteractionStore } from './store.js';
import { TelegramRenderer, interactionActions } from './telegram.js';
import type { ActionSpec, RenderedMessage } from './telegram.js';

export interface LifecycleOutcome {
  interactionId: string;
  resolved: boolean;
  result: Record<string, unknown> | null;
  card: RenderedMessage | null;
}

export class ResultLifecycle {
  private readonly renderer = new TelegramRenderer();

  constructor(
    private readonly store: InteractionStore,
    private readonly tokenFactory: () => string = () => `cb_${randomBytes(24).toString('base64url')}`,
  ) {}

  handleCallback(input: InboundContext & { token: string }): LifecycleOutcome {
    const context = this.store.callbackContext(input.token);
    const { binding, interaction } = context;
    if (!binding.active || interaction.state !== 'delivered') throw new StaleCallback('callback is stale');
    if (binding.revision !== interaction.revision) {
      throw new StaleCallback('callback is stale for the current interaction revision');
    }
    this.requireCurrentAction(interaction, binding.action, binding.value);
    const inbound = { userId: input.userId, chatId: input.chatId, threadId: input.threadId };

    switch (binding.action) {
      case 'acknowledge':
        return this.resolve(input.token, interaction, { acknowledged: true }, inbound);
      case 'choose':
        return this.resolve(input.token, interaction, { value: binding.value }, inbound);
      case 'wizard_confirm':
        return this.resolve(input.token, interaction, { values: binding.value }, inbound);
      case 'wizard_select': {
        if (!isRecord(binding.value) || typeof binding.value.field !== 'string') {
          throw new StaleCallback('callback value is stale');
        }
        const progress = { ...interaction.progress, [binding.value.field]: binding.value.value };
        return this.advance(input.token, interaction, progress, inbound);
      }
      case 'wizard_restart':
        return this.advance(input.token, interaction, {}, inbound);
      default:
        throw new StaleCallback('callback action is stale or unsupported');
    }
  }

  handleReply(input: InboundContext & { replyToMessageId: number; text: unknown }): LifecycleOutcome | null {
    const interaction = this.store.findReplyInteraction(input.chatId, input.threadId, input.replyToMessageId);
    if (interaction === null) return null;
    const text = validateReplyText(interaction.schema as ReplyTextSchema, input.text);
    const result = this.store.recordReplyResult(
      interaction.interactionId,
      {
        userId: input.userId,
        chatId: input.chatId,
        threadId: input.threadId,
        replyToMessageId: input.replyToMessageId,
      },
      { text },
    );
    return {
      interactionId: interaction.interactionId,
      resolved: true,
      result: result.result,
      card: null,
    };
  }

  private resolve(
    token: string,
    interaction: InteractionRecord,
    result: Record<string, unknown>,
    inbound: InboundContext,
  ): LifecycleOutcome {
    const outcome = this.store.applyCallback(token, inbound, { result });
    if (outcome.result === null) throw new Error('resolved callback did not create a result');
    return {
      interactionId: interaction.interactionId,
      resolved: true,
      result: outcome.result.result,
      card: null,
    };
  }

  private advance(
    token: string,
    interaction: InteractionRecord,
    progress: Record<string, unknown>,
    inbound: InboundContext,
  ): LifecycleOutcome {
    const actions = interactionActions(interaction.kind, interaction.schema, progress);
    const tokens = Object.fromEntries(Object.keys(actions).map((key) => [key, this.tokenFactory()]));
    const card = this.renderer.render(interaction.kind, interaction.schema, progress, tokens);
    const bindings = Object.fromEntries(
      Object.entries(actions).map(([key, action]) => [tokens[key] as string, action satisfies ActionBinding]),
    );
    const outcome = this.store.applyCallback(token, inbound, { progress, bindings });
    return {
      interactionId: outcome.interaction.interactionId,
      resolved: false,
      result: null,
      card,
    };
  }

  private requireCurrentAction(interaction: InteractionRecord, action: string, value: unknown): void {
    const actions = Object.values(interactionActions(interaction.kind, interaction.schema, interaction.progress));
    if (!actions.some((candidate) => sameAction(candidate, { action, value }))) {
      throw new StaleCallback('callback is stale for the current wizard step');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameAction(left: ActionSpec, right: ActionSpec): boolean {
  return left.action === right.action && JSON.stringify(left.value) === JSON.stringify(right.value);
}
