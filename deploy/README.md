# Deployment contract

This directory contains an **unenabled** standalone service unit. It is deployment documentation,
not permission to start the bot, load a token, change the active gateway, or migrate production
state.

## Runtime contract

- One service process is the sole Telegram poller and sole writer to the service SQLite database.
- The Unix control socket path is supplied by `TELEGRAM_INTERACTIONS_SOCKET_PATH`, the result-event
  socket by `TELEGRAM_INTERACTIONS_RESULT_EVENTS_SOCKET`, and the SQLite database
  path by `TELEGRAM_INTERACTIONS_DATABASE_PATH`; the service uses `UMask=0077` and creates the
  socket at mode `0600`.
- The bot token and runtime settings are read only from the environment by direct `src/main.ts`
  execution; secrets are never stored in the repository or unit file.
- `Restart=on-failure` and `RestartSec=5` provide bounded supervisor recovery. The service has no
  command or permission to restart Hermes, a gateway, or another service.
- `TimeoutStopSec=30` and `SIGTERM` allow runtime shutdown to stop polling, remove the socket, and
  close SQLite cleanly.
- `PrivateTmp=true` and `NoNewPrivileges=true` are defense-in-depth; filesystem access remains
  limited by the service account and explicit runtime paths.

## Pre-enable checklist

1. Review the exact bot identity, destination topic, allowlisted operator, secret source, and
   rollback point.
2. Confirm no other process polls the same bot.
3. Validate the config path and runtime directory on the target host without loading the token into
   logs or source control.
4. Run the temporary acceptance suite with fake Telegram transport.
5. Obtain separate cutover approval before installing, enabling, or starting the unit.

No installation or enablement command is included intentionally.