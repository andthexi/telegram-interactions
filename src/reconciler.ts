import { DeliveryFailed } from './telegram.js';
import type { TelegramDelivery } from './telegram.js';
import { StoreError } from './store.js';
import type { InteractionStore } from './store.js';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ReconciliationSummary {
  retried: number;
  delivered: number;
  failed: number;
  recoveryNoticeEmitted: boolean;
  restartAttempted: boolean;
}

export class Reconciler {
  private readonly delivery: TelegramDelivery | undefined;
  private readonly recoveryNotifier: ((message: string) => Promise<unknown>) | undefined;
  private readonly restartService: (() => Promise<boolean>) | undefined;

  constructor(
    private readonly store: InteractionStore,
    options: {
      delivery?: TelegramDelivery;
      recoveryNotifier?: (message: string) => Promise<unknown>;
      restartService?: () => Promise<boolean>;
    } = {},
  ) {
    this.delivery = options.delivery;
    this.recoveryNotifier = options.recoveryNotifier;
    this.restartService = options.restartService;
  }

  async runOnce(options: { telegramConnected?: boolean } = {}): Promise<ReconciliationSummary> {
    const telegramConnected = options.telegramConnected ?? true;
    this.store.recordHealthEvent('heartbeat', { status: 'ok' });

    if (!telegramConnected && !this.store.hasOpenOutage()) {
      this.store.recordHealthEvent('telegram_disconnected', { status: 'offline' });
    }

    let restartAttempted = false;
    if (!telegramConnected && this.restartService !== undefined && this.store.restartAttemptPending()) {
      restartAttempted = true;
      let restarted = false;
      try {
        restarted = await this.restartService();
      } finally {
        this.store.recordHealthEvent('service_restart_attempt', { restarted });
      }
    }

    let retried = 0;
    let delivered = 0;
    let failed = 0;
    if (telegramConnected && this.delivery !== undefined) {
      for (const interaction of this.store.listPendingDelivery()) {
        retried += 1;
        try {
          await this.delivery.deliver(interaction.interactionId);
          delivered += 1;
        } catch (error) {
          if (!(error instanceof DeliveryFailed || error instanceof StoreError)) throw error;
          failed += 1;
          this.store.recordHealthEvent('delivery_retry_failed', {
            interactionId: interaction.interactionId,
            error: error.constructor.name,
          });
        }
      }
    }

    let recoveryNoticeEmitted = false;
    if (telegramConnected && this.recoveryNotifier !== undefined && this.store.hasOpenOutage()) {
      await this.recoveryNotifier('Telegram interaction delivery recovered after an outage.');
      this.store.recordHealthEvent('telegram_recovery_notice', { status: 'sent' });
      recoveryNoticeEmitted = true;
    }

    return { retried, delivered, failed, recoveryNoticeEmitted, restartAttempted };
  }

  cleanup(retentionMs = SEVEN_DAYS_MS): string[] {
    return this.store.deleteCleanupEligible(retentionMs);
  }
}
