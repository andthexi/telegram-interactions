const interval = (name: string, value: string | undefined, defaultValue: number, minimum: number): number => {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`invalid environment variable: ${name}`);
  }
  return parsed;
};

export interface RuntimeConfig {
  databasePath: string;
  socketPath: string;
  reconciliationIntervalMs: number;
  deliveryIntervalMs: number;
  token: string;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const databasePath = env.TELEGRAM_INTERACTIONS_DATABASE_PATH;
  if (databasePath === undefined || databasePath.trim().length === 0) {
    throw new Error('missing environment variable: TELEGRAM_INTERACTIONS_DATABASE_PATH');
  }
  const socketPath = env.TELEGRAM_INTERACTIONS_SOCKET_PATH;
  if (socketPath === undefined || socketPath.trim().length === 0) {
    throw new Error('missing environment variable: TELEGRAM_INTERACTIONS_SOCKET_PATH');
  }
  const token = env.TELEGRAM_INTERACTIONS_BOT_TOKEN;
  if (token === undefined || token.trim().length === 0) {
    throw new Error('missing environment variable: TELEGRAM_INTERACTIONS_BOT_TOKEN');
  }
  return {
    databasePath,
    socketPath,
    reconciliationIntervalMs: interval(
      'TELEGRAM_INTERACTIONS_RECONCILIATION_INTERVAL_MS',
      env.TELEGRAM_INTERACTIONS_RECONCILIATION_INTERVAL_MS,
      300_000,
      1_000,
    ),
    deliveryIntervalMs: interval(
      'TELEGRAM_INTERACTIONS_DELIVERY_INTERVAL_MS',
      env.TELEGRAM_INTERACTIONS_DELIVERY_INTERVAL_MS,
      1_000,
      100,
    ),
    token,
  };
}
