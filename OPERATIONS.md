# Operations and service contract

This is the operational contract for the tested service core. It is **not** permission to start a
bot, inspect production databases, change gateways, or install systemd units.

## Ownership and trust

- One process owns the writable `InteractionStore`; clients never open its SQLite file.
- The database path is read from `TELEGRAM_INTERACTIONS_DATABASE_PATH` and the Unix socket path from
  `TELEGRAM_INTERACTIONS_SOCKET_PATH`; the socket is mode `0600`, and its parent is created mode
  `0700` when absent.
- Reconciliation and delivery intervals are read from the environment, with bounded defaults.
- Namespace/workflow values are trusted-local routing claims, but every query and acknowledgement
  remains scoped to both values.
- Telegram authorization is separate: inbound actions must match the active opaque token,
  revision, allowed user, destination chat/topic, and persisted delivery binding.
- No component parses free-form Telegram text except the bounded `reply_text` validator.

## NDJSON Unix socket API

One JSON object is read and one JSON object is written per line. The default maximum request is
64 KiB. Invalid JSON, oversized frames, unsupported operations, malformed schemas, stale
revisions, and illegal transitions return deterministic error objects.

### Submit

```json
{"op":"submit","namespace":"jobsearch","workflow":"job-search","request":{"idempotencyKey":"packet-17-r1","type":"notification","schema":{"schemaVersion":1,"revision":1,"title":"Review","body":"Review the bounded request.","effect":"Acknowledges the request.","acknowledgeLabel":"Acknowledge"}}}
```

```json
{"ok":true,"interactionId":"<uuid>","state":"queued","revision":1}
```

### Poll unacknowledged results

```json
{"op":"poll-results","namespace":"jobsearch","workflow":"job-search","limit":100}
```

```json
{"ok":true,"results":[{"interactionId":"<uuid>","revision":1,"result":{"acknowledged":true},"recordedAt":"<ISO-8601>"}]}
```

### Acknowledge after the workflow commits

```json
{"op":"ack-result","namespace":"jobsearch","workflow":"job-search","interactionId":"<uuid>","revision":1}
```

Acknowledgement is idempotent. A client must commit its workflow ledger and wake marker before
acknowledging; otherwise it can lose its own retry signal.

`destination` and `allowedUserId` are optional submit request fields. When omitted, the service uses
`TELEGRAM_INTERACTIONS_DEFAULT_CHAT_ID`, optional `TELEGRAM_INTERACTIONS_DEFAULT_THREAD_ID`, and
`TELEGRAM_INTERACTIONS_DEFAULT_OPERATOR_USER_ID`. Explicit values override those defaults.

### Heartbeat

```json
{"op":"heartbeat"}
```

This writes a bounded health event. It never contacts Telegram or restarts a gateway.

## Four schema primitives

All primitives require `schemaVersion: 1`, positive `revision`, title, body, and human-readable
effect. Objects are strict: unknown fields (including private evidence blobs) are rejected.

- `notification`: one acknowledgement button.
- `single_enum`: 1–10 labelled symbolic choices.
- `multi_enum_object`: 1–8 enum fields, rendered one at a time, then review/confirm or restart.
- `reply_text`: length-bounded text with an optional bounded regex; only a direct reply to the persisted card message is accepted. Lookarounds, backreferences, inline modifiers, and nested quantifiers are rejected.
- `choice_with_optional_reply`: bounded enum choices with one declared option that transitions the same interaction into a direct-reply phase. The final result is `{value}` for ordinary options or `{value, text}` for the reply branch.

Telegram cards are plain text. Semantic values are persisted server-side and mapped to random
`cb_...` tokens; packet payloads and private evidence never appear in callback data.

## SQLite model and exactly-once results

The central store enables foreign keys, WAL, and a 10-second busy timeout. Tables are:

- `namespaces`: unique namespace/workflow scopes;
- `interactions`: immutable request hash, schema, destination, user, revision, progress, delivery
  binding, and state;
- `delivery_attempts`: ordered `succeeded`, `failed`, or `uncertain` attempts;
- `callback_bindings`: opaque revision-bound actions, active until consumed/superseded;
- `results`: a unique row per interaction plus workflow acknowledgement time;
- `health_events`: bounded heartbeat, outage, retry, restart-attempt, and recovery records.

Result creation, interaction transition to `answered`, and callback invalidation happen in one
immediate transaction. The unique result constraint is the final exactly-once guard. Polling is
at-least-once until the workflow acknowledges.

## Delivery, reconciliation, health, and recovery

`TelegramDelivery` renders once, attempts at most three sends with bounded exponential backoff,
and persists the Telegram binding only after a confirmed send. Confirmed failures remain queued;
ambiguous transport failures mark `delivery_uncertain` for explicit reconciliation.

Each `Reconciler.runOnce`:

1. records a heartbeat;
2. opens one outage record when Telegram is unavailable;
3. optionally invokes an injected **service-only** restart callback once per outage;
4. retries queued/uncertain deliveries when connected;
5. records bounded retry failures; and
6. emits one delayed recovery notice after reconnect.

There is deliberately no gateway-restart method. The restart callback is an abstraction for a
future reviewed supervisor integration, not a shell command in this codebase.

## Seven-day cleanup

`Reconciler.cleanup()` defaults to seven days. It deletes only interactions that are:

- in `answered` state;
- at least seven days past `answered_at`; and
- acknowledged by the owning workflow.

Foreign-key cascades then remove that interaction's attempts, bindings, and result. Unresolved,
uncertain, failed, recent, or unacknowledged records remain.

## Inventory scaffolding

`createSnapshotInventory` has no implicit production paths. The caller must supply every source,
selector, destination root, session ID, and timestamp. It:

- refuses to overwrite a manifest or timestamp directory;
- uses SQLite's backup API for consistent copies;
- makes snapshots and manifests read-only;
- records SHA-256 hashes, table counts, reviewed attribution counts, and session IDs—not row bodies;
- runs `PRAGMA integrity_check` on the snapshot and a temporary restored copy; and
- supports explicitly supplied file/directory snapshots.

The checked-in `migration/pre-cutover-inventory.json` is only a pending placeholder. No capture has
run.

## Current no-live boundary

Not present and not performed:

- live token loading or credential storage;
- Telegram long polling/webhooks in this environment;
- systemd units/timers or service control;
- production database reads/writes or record migration;
- Hermes source, gateway, profile, cron, or plugin changes;
- live Telegram sends; or
- LLM calls.

A standalone composition root now exists in `src/application.ts` and `src/main.ts`. `createInteractionApplication(...)` accepts injected bot and transport dependencies for fixture tests; direct process execution is the only path that loads configuration and constructs the real grammY bot. Tests never load live credentials or start Telegram polling.

A static, unenabled unit and deployment contract are present under `deploy/`. They define private runtime permissions, bounded restart/shutdown behavior, explicit config selection, and sole-poller ownership. Installing, enabling, or starting the unit remains a separate cutover action.

## Safe developer checks

```bash
cd /path/to/telegram-interactions
npm install
npm run typecheck
npm run lint
npm test
```

All tests use temporary paths and fake Telegram transports.
