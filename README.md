# Telegram Interaction Service

A local Node.js 22 / TypeScript service core for bounded Telegram decisions. It owns a central
SQLite database, exposes a newline-delimited JSON API on an owner-only Unix socket, renders four
typed interaction primitives, validates Telegram callback/reply bindings, and delivers typed
results to their owning workflow. It never invokes an LLM or interprets workflow semantics.

> **Safety boundary:** this repository contains a standalone composition root and runtime wiring, but no production bot token, live poller deployment, systemd unit, production path discovery, or automatic migration. `src/application.ts` is the injectable fixture-safe composition seam; `src/main.ts` only loads configuration and constructs the real bot when directly executed. Tests use temporary files and fake transports. `GrammyTransport` is an injected adapter only; constructing it does not contact Telegram.

## Requirements and verification

- Node.js 22 or newer
- npm 10 or newer

```bash
cd /home/hermes/telegram-interactions
npm install
npm run typecheck
npm run lint
npm test
# or all gates after installation
npm run check
```

## Architecture

```text
trusted local workflow
        |
        | NDJSON, mode-0600 Unix socket
        v
UnixSocketServer -> InteractionService -> InteractionStore -> SQLite
                           |                    ^
                           v                    |
                    schema validation     ResultLifecycle
                                                ^
                                                |
Telegram update adapter -> ResultLifecycle <- TelegramDelivery -> TelegramTransport
                                                    |
                                               Reconciler
```

Only the service process receives a writable `InteractionStore`. Local clients submit and consume
results through the socket. A deployment composition root would inject one grammY API instance,
route callbacks/replies into `ResultLifecycle`, and schedule `Reconciler`; that live wiring is
intentionally outside this prototype.

## Modules

| Path | Responsibility |
| --- | --- |
| `src/schemas.ts` | Strict Zod validation for the four versioned primitives and reply text. |
| `src/store.ts` | Single-writer SQLite schema, transactions, idempotency, bindings, exactly-once results, health, retention. |
| `src/service.ts` | Deterministic `submit`, `poll-results`, `ack-result`, and `heartbeat` dispatcher. |
| `src/socket-api.ts` | Bounded NDJSON server with owner-only socket permissions. |
| `src/telegram.ts` | Renderer, opaque actions, three-attempt delivery, fakeable transport, and grammY adapter. |
| `src/lifecycle.ts` | Callback identity/context checks, wizard progression, direct-reply validation, result creation. |
| `src/reconciler.ts` | Pending-delivery retries, heartbeat/outage recovery, one service-restart hook, seven-day cleanup. |
| `src/inventory.ts` | Explicit-path, non-overwriting, content-minimizing snapshot inventory scaffolding. |
| `tests/` | Temporary SQLite/socket fixtures and fake transports; no credentials or network. |

## Core invariants

1. An idempotency key is unique inside one namespace/workflow. Identical content returns the
   original interaction; different content produces `idempotency_conflict`.
2. Callback data contains only random opaque tokens (at most Telegram's 64-byte limit).
3. Successful delivery persists message/chat/topic and callback bindings in one transaction.
4. A callback must match the active token, immutable revision, allowed user, chat, and topic.
5. Reply text must directly reply to the stored card message and satisfy the bounded schema.
6. The `results.interaction_id` uniqueness constraint plus transactional state changes creates at
   most one result. A stale/replayed Telegram action cannot create another.
7. Workflows poll only their namespace/workflow and acknowledge by interaction ID plus revision.
8. Cleanup removes only answered, workflow-acknowledged interactions at least seven days old.

## Multi-field packet bound

`multi_enum_object` packets support at most **8 fields**. This is an application-level safety
bound for keeping Telegram wizards bounded, reviewable, and predictable; it is not a Telegram API
limit. A decision containing more than 8 fields must be split into multiple related immutable
packets, each with its own packet identity, interaction, and result lifecycle.

## Resending unanswered interactions

Send `/pending` (or `/pending@botname`) in the destination chat/topic to resend every unanswered
interaction bound to that chat/topic and the invoking allowed user. The command reuses each
existing interaction ID and idempotency record; it does not create new interactions. Answered
interactions are never resent, and other users' or destinations' interactions are not exposed.
The command always sends an acknowledgement; when the scoped set is empty, the acknowledgement is
`No unanswered interactions.`.

See [OPERATIONS.md](OPERATIONS.md) for the protocol and recovery contract, and
[migration/README.md](migration/README.md) for the inventory safety boundary.
