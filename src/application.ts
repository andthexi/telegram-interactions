import type { RuntimeConfig } from './config.js';
import { ResultLifecycle } from './lifecycle.js';
import { InteractionService } from './service.js';
import { InteractionStore } from './store.js';
import { InteractionRuntime } from './runtime.js';
import type { RuntimeBot } from './runtime.js';
import type { TelegramTransport } from './telegram.js';
import { TelegramDelivery } from './telegram.js';

export interface ApplicationDependencies {
  bot: RuntimeBot;
  transport: TelegramTransport;
  store?: InteractionStore;
}

export interface InteractionApplication {
  readonly store: InteractionStore;
  readonly runtime: InteractionRuntime;
  shutdown(): Promise<void>;
}

/** Compose the standalone service without reading credentials or starting any external poller. */
export function createInteractionApplication(
  config: RuntimeConfig,
  dependencies: ApplicationDependencies,
): InteractionApplication {
  const store = dependencies.store ?? new InteractionStore(config.databasePath);
  const runtime = new InteractionRuntime({
    bot: dependencies.bot,
    store,
    service: new InteractionService(store),
    lifecycle: new ResultLifecycle(store),
    delivery: new TelegramDelivery(store, dependencies.transport),
    socketPath: config.socketPath,
    deliveryIntervalMs: config.deliveryIntervalMs,
  });
  return { store, runtime, shutdown: async () => { await runtime.stop(); store.close(); } };
}
