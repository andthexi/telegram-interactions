const interval = (name: string, value: string | undefined, defaultValue: number, minimum: number): number => {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`invalid environment variable: ${name}`);
  }
  return parsed;
};

const requiredInteger = (name: string, value: string | undefined, minimum?: number): number => {
  if (value === undefined || value.trim().length === 0) throw new Error(`missing environment variable: ${name}`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (minimum !== undefined && parsed < minimum)) {
    throw new Error(`invalid environment variable: ${name}`);
  }
  return parsed;
};

export interface DefaultDestination {
  chatId: number;
  threadId?: number;
}

export interface RuntimeConfig {
  databasePath: string;
  socketPath: string;
  resultEventsSocketPath: string;
  reconciliationIntervalMs: number;
  deliveryIntervalMs: number;
  token: string;
  defaultDestination: DefaultDestination;
  defaultAllowedUserId: number;
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
  const resultEventsSocketPath = env.TELEGRAM_INTERACTIONS_RESULT_EVENTS_SOCKET;
  if (resultEventsSocketPath === undefined || resultEventsSocketPath.trim().length === 0) {
    throw new Error('missing environment variable: TELEGRAM_INTERACTIONS_RESULT_EVENTS_SOCKET');
  }
  const token = env.TELEGRAM_INTERACTIONS_BOT_TOKEN;
  if (token === undefined || token.trim().length === 0) {
    throw new Error('missing environment variable: TELEGRAM_INTERACTIONS_BOT_TOKEN');
  }
  const chatId = requiredInteger('TELEGRAM_INTERACTIONS_DEFAULT_CHAT_ID', env.TELEGRAM_INTERACTIONS_DEFAULT_CHAT_ID);
  const threadId = env.TELEGRAM_INTERACTIONS_DEFAULT_THREAD_ID === undefined || env.TELEGRAM_INTERACTIONS_DEFAULT_THREAD_ID.trim().length === 0
    ? undefined
    : requiredInteger('TELEGRAM_INTERACTIONS_DEFAULT_THREAD_ID', env.TELEGRAM_INTERACTIONS_DEFAULT_THREAD_ID, 1);
  const defaultAllowedUserId = requiredInteger('TELEGRAM_INTERACTIONS_DEFAULT_OPERATOR_USER_ID', env.TELEGRAM_INTERACTIONS_DEFAULT_OPERATOR_USER_ID, 1);
  return {
    databasePath,
    socketPath,
    resultEventsSocketPath,
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
    defaultDestination: threadId === undefined ? { chatId } : { chatId, threadId },
    defaultAllowedUserId,
  };
}
