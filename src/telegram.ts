import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { InlineKeyboard } from 'grammy';
import type { Api } from 'grammy';

import { validateSchema } from './schemas.js';
import type {
  InteractionKind,
  InteractionSchema,
  MultiEnumSchema,
  NotificationSchema,
  SingleEnumSchema,
  ChoiceWithOptionalReplySchema,
  ReplyTextSchema,
} from './schemas.js';
import type { ActionBinding, InteractionStore } from './store.js';

export interface InlineButton {
  label: string;
  callbackData: string;
}

export interface RenderedMessage {
  text: string;
  buttons: InlineButton[][];
}

export interface SentMessage {
  messageId: number;
  chatId: number;
  threadId: number | null;
}

export interface TelegramTransport {
  sendMessage(input: {
    chatId: number;
    threadId: number | null;
    text: string;
    buttons: InlineButton[][];
  }): Promise<SentMessage>;
}

export interface ActionSpec {
  action: string;
  value: unknown;
}

export class TelegramDeliveryError extends Error {
  readonly code: string;
  readonly uncertain: boolean;

  constructor(code: string, options: { uncertain?: boolean; cause?: unknown } = {}) {
    super(code, { cause: options.cause });
    this.name = 'TelegramDeliveryError';
    this.code = code;
    this.uncertain = options.uncertain ?? false;
  }
}

export class DeliveryFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryFailed';
  }
}

export function interactionActions(
  kind: InteractionKind,
  schema: unknown,
  progress: Record<string, unknown>,
): Record<string, ActionSpec> {
  const validated = validateSchema(kind, schema);
  switch (kind) {
    case 'notice':
      return {};
    case 'notification':
      return { ack: { action: 'acknowledge', value: true } };
    case 'single_enum':
      return Object.fromEntries(
        (validated as SingleEnumSchema).options.map((option) => [
          `choose:${option.value}`,
          { action: 'choose', value: option.value },
        ]),
      );
    case 'multi_enum_object': {
      const multi = validated as MultiEnumSchema;
      const nextField = multi.fields.find((field) => !(field.name in progress));
      if (nextField !== undefined) {
        return Object.fromEntries(
          nextField.options.map((option) => [
            `select:${nextField.name}:${option.value}`,
            { action: 'wizard_select', value: { field: nextField.name, value: option.value } },
          ]),
        );
      }
      return {
        confirm: { action: 'wizard_confirm', value: structuredClone(progress) },
        restart: { action: 'wizard_restart', value: null },
      };
    }
    case 'reply_text':
      return {};
    case 'choice_with_optional_reply': {
      const mixed = validated as ChoiceWithOptionalReplySchema;
      if (progress.phase === 'awaiting_reply') return {};
      return Object.fromEntries(mixed.options.map((option) => [`choose:${option.value}`, { action: 'choose', value: option.value }]));
    }
  }
}

export class TelegramRenderer {
  render(
    kind: InteractionKind,
    schema: unknown,
    progress: Record<string, unknown>,
    callbackTokens: Record<string, string>,
  ): RenderedMessage {
    const validated = validateSchema(kind, schema);
    const actions = interactionActions(kind, validated, progress);
    const expected = Object.keys(actions).sort();
    const actual = Object.keys(callbackTokens).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error('callback token keys must exactly match the rendered actions');
    }
    for (const token of Object.values(callbackTokens)) {
      if (!/^cb_[A-Za-z0-9_-]{16,60}$/.test(token) || Buffer.byteLength(token) > 64) {
        throw new Error('callback data must be an opaque token of at most 64 bytes');
      }
    }

    let text = `${validated.title}\n\n${validated.body}\n\nEffect: ${validated.effect}`;
    const buttons: InlineButton[][] = [];
    switch (kind) {
      case 'notice':
        break;
      case 'notification': {
        const notification = validated as NotificationSchema;
        buttons.push([{ label: notification.acknowledgeLabel, callbackData: callbackTokens.ack as string }]);
        break;
      }
      case 'single_enum': {
        const single = validated as SingleEnumSchema;
        for (const option of single.options) {
          buttons.push([
            {
              label: option.label,
              callbackData: callbackTokens[`choose:${option.value}`] as string,
            },
          ]);
        }
        break;
      }
      case 'multi_enum_object': {
        const multi = validated as MultiEnumSchema;
        const nextField = multi.fields.find((field) => !(field.name in progress));
        if (nextField !== undefined) {
          text += `\n\n${nextField.label}`;
          for (const option of nextField.options) {
            buttons.push([
              {
                label: option.label,
                callbackData: callbackTokens[`select:${nextField.name}:${option.value}`] as string,
              },
            ]);
          }
        } else {
          text += `\n\n${multi.reviewLabel}`;
          for (const field of multi.fields) {
            const selected = field.options.find((option) => option.value === progress[field.name]);
            if (selected === undefined) throw new Error(`wizard progress is invalid for ${field.name}`);
            text += `\n${field.label}: ${selected.label}`;
          }
          buttons.push([{ label: multi.confirmLabel, callbackData: callbackTokens.confirm as string }]);
          buttons.push([{ label: 'Start over', callbackData: callbackTokens.restart as string }]);
        }
        break;
      }
      case 'reply_text': {
        const reply = validated as ReplyTextSchema;
        text += `\n\n${reply.submitLabel}: send a direct reply to this message (${reply.minLength}-${reply.maxLength} characters).`;
        break;
      }
      case 'choice_with_optional_reply': {
        const mixed = validated as ChoiceWithOptionalReplySchema;
        if (progress.phase === 'awaiting_reply') {
          text += `\n\n${mixed.reply.submitLabel}: send a direct reply to this message (${mixed.reply.minLength}-${mixed.reply.maxLength} characters).`;
        } else {
          for (const option of mixed.options) {
            buttons.push([{ label: option.label, callbackData: callbackTokens[`choose:${option.value}`] as string }]);
          }
        }
        break;
      }
    }
    return { text, buttons };
  }
}

export class TelegramDelivery {
  private readonly renderer = new TelegramRenderer();
  private readonly sleep: (milliseconds: number) => Promise<unknown>;
  private readonly backoffMilliseconds: number;
  private readonly tokenFactory: () => string;

  constructor(
    private readonly store: InteractionStore,
    private readonly transport: TelegramTransport,
    options: {
      sleep?: (milliseconds: number) => Promise<unknown>;
      backoffMilliseconds?: number;
      tokenFactory?: () => string;
    } = {},
  ) {
    this.sleep = options.sleep ?? delay;
    this.backoffMilliseconds = options.backoffMilliseconds ?? 250;
    this.tokenFactory = options.tokenFactory ?? (() => `cb_${randomBytes(24).toString('base64url')}`);
  }

  async deliver(interactionId: string): Promise<SentMessage> {
    const interaction = this.store.getInteraction(interactionId);
    const actions = interactionActions(interaction.kind, interaction.schema, interaction.progress);
    const tokens = Object.fromEntries(Object.keys(actions).map((key) => [key, this.tokenFactory()]));
    const card = this.renderer.render(interaction.kind, interaction.schema, interaction.progress, tokens);
    const bindings = Object.fromEntries(
      Object.entries(actions).map(([key, action]) => [tokens[key] as string, action satisfies ActionBinding]),
    );

    const maxAttempts = interaction.kind === 'notice' ? 1 : 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const sent = await this.transport.sendMessage({
          chatId: interaction.destination.chatId,
          threadId: interaction.destination.threadId ?? null,
          text: card.text,
          buttons: card.buttons,
        });
        this.store.recordDeliverySuccess(interactionId, { ...sent, bindings });
        return sent;
      } catch (error) {
        if (!(error instanceof TelegramDeliveryError)) throw error;
        this.store.recordDeliveryAttempt(interactionId, error.uncertain ? 'uncertain' : 'failed', error.code);
        if (attempt === maxAttempts) {
          throw new DeliveryFailed(`delivery failed after 3 attempts: ${error.code}`);
        }
        await this.sleep(this.backoffMilliseconds * 2 ** (attempt - 1));
      }
    }
    throw new DeliveryFailed('delivery failed after bounded retry loop');
  }
}

/** A thin grammY adapter. Constructing it has no network side effects. */
export class GrammyTransport implements TelegramTransport {
  constructor(private readonly api: Pick<Api, 'sendMessage'>) {}

  async sendMessage(input: {
    chatId: number;
    threadId: number | null;
    text: string;
    buttons: InlineButton[][];
  }): Promise<SentMessage> {
    const keyboard = new InlineKeyboard();
    for (const row of input.buttons) {
      for (const button of row) keyboard.text(button.label, button.callbackData);
      keyboard.row();
    }
    try {
      const message = await this.api.sendMessage(input.chatId, input.text, {
        ...(input.threadId === null ? {} : { message_thread_id: input.threadId }),
        ...(input.buttons.length === 0 ? {} : { reply_markup: keyboard }),
      });
      return {
        messageId: message.message_id,
        chatId: message.chat.id,
        threadId: 'message_thread_id' in message ? (message.message_thread_id ?? input.threadId) : input.threadId,
      };
    } catch (error) {
      throw new TelegramDeliveryError('telegram_api_error', { uncertain: true, cause: error });
    }
  }
}

export type { InteractionSchema };
