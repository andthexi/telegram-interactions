import { InlineKeyboard } from 'grammy';

import type { ResultLifecycle } from './lifecycle.js';
import type { InteractionService } from './service.js';
import type { InteractionStore } from './store.js';
import type { TelegramDelivery } from './telegram.js';
import type { RenderedMessage } from './telegram.js';
import { UnixSocketServer } from './socket-api.js';

type CallbackApi = {
  answerCallbackQuery: (id: string, options?: { text?: string }) => Promise<unknown>;
  editMessageText: (chatId: number, messageId: number, text: string, options?: Record<string, unknown>) => Promise<unknown>;
  editMessageReplyMarkup: (chatId: number, messageId: number, options?: Record<string, unknown>) => Promise<unknown>;
  sendMessage: (chatId: number, text: string, options?: Record<string, unknown>) => Promise<unknown>;
};

export interface RuntimeContext {
  callbackQuery?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: {
      chat: { id: number };
      message_id: number;
      message_thread_id?: number;
    };
  };
  message?: {
    text?: string;
    message_id: number;
    message_thread_id?: number;
    chat: { id: number };
    from?: { id: number };
    reply_to_message?: { message_id: number };
  };
}

export interface RuntimeBot {
  readonly api: CallbackApi;
  on(filter: string, handler: (context: RuntimeContext) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface InteractionRuntimeOptions {
  bot: RuntimeBot;
  store: InteractionStore;
  service: InteractionService;
  lifecycle: ResultLifecycle;
  delivery: TelegramDelivery;
  socketPath: string;
  deliveryIntervalMs: number;
}

export class InteractionRuntime {
  private readonly socket: UnixSocketServer;
  private deliveryTimer: NodeJS.Timeout | undefined;
  private started = false;
  private deliveryInProgress = false;

  constructor(private readonly options: InteractionRuntimeOptions) {
    this.socket = new UnixSocketServer(options.socketPath, options.service.handle);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('runtime is already started');
    this.options.bot.on('callback_query:data', (context) => this.handleCallback(context));
    this.options.bot.on('message:text', (context) => this.handleMessage(context));
    await this.socket.start();
    this.started = true;
    await this.deliverPending();
    this.deliveryTimer = setInterval(() => {
      void this.deliverPending();
    }, this.options.deliveryIntervalMs);
    void this.options.bot.start().catch(() => {
      // The supervisor owns restart policy; runtime shutdown remains explicit.
    });
  }

  async deliverPending(): Promise<void> {
    if (this.deliveryInProgress) return;
    this.deliveryInProgress = true;
    try {
      for (const interaction of this.options.store.listPendingDelivery()) {
        try {
          await this.options.delivery.deliver(interaction.interactionId);
        } catch {
          // TelegramDelivery records bounded delivery attempts; reconciliation retries later.
        }
      }
    } finally {
      this.deliveryInProgress = false;
    }
  }

  async stop(): Promise<void> {
    if (this.deliveryTimer !== undefined) {
      clearInterval(this.deliveryTimer);
      this.deliveryTimer = undefined;
    }
    if (!this.started) return;
    await this.options.bot.stop();
    await this.socket.stop();
    this.started = false;
  }

  private async handleCallback(context: RuntimeContext): Promise<void> {
    const callback = context.callbackQuery;
    if (callback === undefined) return;
    try {
      const message = callback.message;
      const userId = callback.from?.id;
      if (callback.data === undefined || message === undefined || userId === undefined) {
        throw new Error('callback context is incomplete');
      }
      const outcome = this.options.lifecycle.handleCallback({
        token: callback.data,
        userId,
        chatId: message.chat.id,
        threadId: message.message_thread_id ?? null,
      });
      if (outcome.card !== null) {
        await this.editCard(message.chat.id, message.message_id, outcome.card);
      } else {
        await this.options.bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
          reply_markup: { inline_keyboard: [] },
        });
      }
      try {
        await contextAnswer(this.options.bot.api, callback.id);
      } catch {
        // Telegram callback acknowledgements can expire after the decision is committed.
        // The durable result and keyboard update remain authoritative.
      }
    } catch {
      await contextAnswer(this.options.bot.api, callback.id, 'This interaction is no longer active.');
    }
  }

  private async handleMessage(context: RuntimeContext): Promise<void> {
    const message = context.message;
    if (message?.from === undefined || message.text === undefined) return;
    if (/^\/pending(?:@[^\s]+)?$/u.test(message.text.trim())) {
      const interactions = this.options.store.requeueUnansweredForContext(
        message.chat.id,
        message.message_thread_id ?? null,
        message.from.id,
      );
      for (const interaction of interactions) {
        try {
          await this.options.delivery.deliver(interaction.interactionId);
        } catch {
          // Delivery failure is persisted and retried by the normal reconciliation loop.
        }
      }
      await this.options.bot.api.sendMessage(
        message.chat.id,
        interactions.length === 0 ? 'No unanswered interactions.' : `Resent ${interactions.length} unanswered interaction${interactions.length === 1 ? '' : 's'}.`,
        message.message_thread_id === undefined ? undefined : { message_thread_id: message.message_thread_id },
      );
      return;
    }
    if (message.reply_to_message === undefined) return;
    try {
      this.options.lifecycle.handleReply({
        userId: message.from.id,
        chatId: message.chat.id,
        threadId: message.message_thread_id ?? null,
        replyToMessageId: message.reply_to_message.message_id,
        text: message.text,
      });
    } catch {
      // Invalid or unauthorized replies are ignored; the persisted interaction remains unchanged.
    }
  }

  private async editCard(chatId: number, messageId: number, card: RenderedMessage): Promise<void> {
    const keyboard = new InlineKeyboard();
    for (const row of card.buttons) {
      for (const button of row) keyboard.text(button.label, button.callbackData);
      keyboard.row();
    }
    await this.options.bot.api.editMessageText(chatId, messageId, card.text, {
      reply_markup: card.buttons.length === 0 ? { inline_keyboard: [] } : keyboard,
    });
  }
}

async function contextAnswer(api: CallbackApi, id: string, text?: string): Promise<void> {
  await api.answerCallbackQuery(id, text === undefined ? undefined : { text });
}

export function createRuntime(options: InteractionRuntimeOptions): InteractionRuntime {
  return new InteractionRuntime(options);
}
