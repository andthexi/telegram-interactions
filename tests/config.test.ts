import { afterEach, describe, expect, it } from 'vitest';

import { loadRuntimeConfig } from '../src/config.js';

afterEach(() => {
  // Keep the test environment isolated from any developer .env values.
  delete process.env.TELEGRAM_INTERACTIONS_BOT_TOKEN;
  delete process.env.TELEGRAM_INTERACTIONS_DATABASE_PATH;
  delete process.env.TELEGRAM_INTERACTIONS_SOCKET_PATH;
  delete process.env.TELEGRAM_INTERACTIONS_RECONCILIATION_INTERVAL_MS;
  delete process.env.TELEGRAM_INTERACTIONS_DELIVERY_INTERVAL_MS;
});

describe('runtime configuration', () => {
  it('reads all required runtime values from environment variables', () => {
    const config = loadRuntimeConfig({
      TELEGRAM_INTERACTIONS_BOT_TOKEN: 'fixture-token',
      TELEGRAM_INTERACTIONS_DATABASE_PATH: './interactions.db',
      TELEGRAM_INTERACTIONS_SOCKET_PATH: './service.sock',
      TELEGRAM_INTERACTIONS_RECONCILIATION_INTERVAL_MS: '120000',
      TELEGRAM_INTERACTIONS_DELIVERY_INTERVAL_MS: '500',
    });

    expect(config).toEqual({
      token: 'fixture-token',
      databasePath: './interactions.db',
      socketPath: './service.sock',
      reconciliationIntervalMs: 120_000,
      deliveryIntervalMs: 500,
    });
  });

  it('uses defaults for optional reconciliation and delivery intervals', () => {
    const config = loadRuntimeConfig({
      TELEGRAM_INTERACTIONS_BOT_TOKEN: 'fixture-token',
      TELEGRAM_INTERACTIONS_DATABASE_PATH: './interactions.db',
      TELEGRAM_INTERACTIONS_SOCKET_PATH: './service.sock',
    });

    expect(config.reconciliationIntervalMs).toBe(300_000);
    expect(config.deliveryIntervalMs).toBe(1_000);
  });

  it('rejects configuration without a required environment variable', () => {
    expect(() => loadRuntimeConfig({
      TELEGRAM_INTERACTIONS_BOT_TOKEN: 'fixture-token',
      TELEGRAM_INTERACTIONS_SOCKET_PATH: './service.sock',
    })).toThrow('missing environment variable: TELEGRAM_INTERACTIONS_DATABASE_PATH');
  });

  it('rejects invalid optional interval values', () => {
    expect(() => loadRuntimeConfig({
      TELEGRAM_INTERACTIONS_BOT_TOKEN: 'fixture-token',
      TELEGRAM_INTERACTIONS_DATABASE_PATH: './interactions.db',
      TELEGRAM_INTERACTIONS_SOCKET_PATH: './service.sock',
      TELEGRAM_INTERACTIONS_DELIVERY_INTERVAL_MS: 'not-a-number',
    })).toThrow('invalid environment variable: TELEGRAM_INTERACTIONS_DELIVERY_INTERVAL_MS');
  });
});
