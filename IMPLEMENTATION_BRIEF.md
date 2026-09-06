# Implementation Brief: Offline-First Signal K Alert Delivery Plugin

## Product goal and gap assessment (2026-09-06)

Build a persistent onboard notification center, comparable in purpose to
[Signal K Notification Player](https://github.com/davidsanner/signalk-notification-player),
with a usable notification list, retained one-time notifications, and full history,
alongside the existing offline remote-delivery and connectivity features.
The reference provides configurable sound/speech, playback controls, a notification
viewer, and persistent zone-change logging. It is a product reference, not an
instruction to copy its implementation or every integration.

This section takes precedence over older suggestions below that make event storage
or the core web UI optional. The phases below are design guidance, not evidence
that the corresponding behavior has been implemented.

### Required behavior

- Keep configured rules/zones (including never-fired definitions), current
  notifications, and historical occurrences distinguishable. Grouping must still
  allow every matching path and source to be inspected individually.
- Capture notifications even with no matching delivery rule, no notifier enabled,
  no sound method, or no Internet connection. Do not depend on a browser being open.
- A one-time notification means a discrete occurrence that may arrive once and
  never receive a clear update. Keep it in the list across refreshes and restarts
  until explicitly dismissed. One-time presentation, play-once audio, acknowledgement,
  upstream resolution, and delivery success are separate concepts.
- Dismissal hides an occurrence from the main list only. It must remain searchable
  in history, and pending deliveries must survive. A later distinct occurrence
  must appear again; a dismissed source must not become permanently invisible.
- Full history means a durable chronological record of every distinct occurrence
  and meaningful lifecycle change, including message/severity changes, clear,
  acknowledgement, silence, dismissal, and delivery attempts/outcomes. It does not
  require recording every identical sensor delta. Preserve source identity,
  occurrence identity, source timestamp when available, receipt time, message,
  severity, and per-occurrence start/clear times and duration.
- A new occurrence on the same path must not overwrite earlier occurrences or
  their delivery results. Duplicate updates within one occurrence should coalesce.
  Do not invent separate one-shot occurrences from identical repeats without a
  documented identity/rearm policy.
- Provide global and per-notification history in the UI and API, including dismissed
  entries, with pagination and filters for time, path/source, state and severity.
  History must work locally and remain available after restart and successful delivery.
- Retain history by default. Any future bounded retention or purge must be explicit,
  documented, and separate from delivery-queue cleanup; protect pending work.
- Keep local controls and upstream controls distinct. Show upstream failure or
  unsupported operations honestly; do not report a local timestamp as confirmed
  Signal K acknowledgement or silence.

### Verified working-copy gaps

Assessment is based on source inspection of the working copy at base commit
`bef795c`, including pre-existing uncommitted implementation changes. These are
static findings, not a live Signal K compatibility or runtime certification.

| Area | Current evidence | Missing behavior |
| --- | --- | --- |
| Notification list | `src/alerts/catalog.ts` includes rules and recognized alerts, but selects only the latest matching alert for each rule/zone. | Drill-down or individual rows so wildcard rules and multiple sources cannot hide occurrences. |
| One-time retention | `oneTime` is a rule flag; remove writes `removed_at`. Catalog filtering hides removed rows, and ingestion does not reset that flag. | Dismissed history access, reappearance of later occurrences, and defined handling for unconfigured one-shot events. |
| Full history | `public/app.js` History filters current catalog rows to `cleared`; `src/api/routes.ts` has no event-history endpoint. | A real timeline including active, cleared and dismissed occurrences, with query/filter/pagination support. |
| Event completeness | `src/storage/db.ts` records initial/state/severity events; same-state message changes and acknowledge/silence/remove actions are not event records. | Complete meaningful lifecycle audit, with immutable occurrence snapshots. |
| Recurrence and delivery audit | `src/storage/schema.ts` has one alert per source key and one delivery per alert/transport. Ingestion uses `INSERT OR IGNORE`; first seen/max severity span recurrences. | Separate occurrences and delivery generations/attempt history, so later triggers and clears can be delivered without overwriting earlier results. |
| Input semantics | Normalization defaults unknown states (including `notice`) to `alert`; null becomes an active alert. Delta source timestamps are not passed into ingestion. | Verify supported Signal K clear/null and severity semantics, retain original state/time, and test compatible normalization. |
| Zones and startup | `src/alerts/zones.ts` exists, but `src/plugin.ts` does not call it or pass zones to the catalog. Startup subscribes without reading existing notifications. | Wire zone discovery/current values and startup reconciliation without generating duplicate historical occurrences. |
| Controls | Acknowledge/silence persist local timestamps before optional upstream calls; no confirmed asynchronous result is required. | Verified supported server API behavior, truthful control results, and action history. |
| Player similarity | No local sound/TTS engine, playback queue, repeat/play-once policy, or timed playback-disable controls are present. | Decide whether to implement playback here or integrate with a separate player; document the chosen ownership and prevent duplicate audio. |

### Scope decisions still open

The notification list, one-time retention, and full history are required. Local
sound/TTS parity is a candidate requirement inferred from “similar”; whether this
plugin owns playback or complements the reference player remains open. Slack,
arbitrary pre/post shell commands, exact visual copying, and the reference's URL
compatibility are not implied requirements. Confirm playback architecture before
implementing it, without delaying the required persistence and history work.

### Acceptance scenarios for future implementation

1. Receive one notice once with no route, no WAN and no browser open. Restart the
   plugin: it remains visible with its original content and occurrence time.
2. Dismiss that occurrence: it disappears from the main list, stays in history,
   and any pending remote delivery remains queued. A distinct later occurrence
   on the same source appears as a new item.
3. Raise, update message/severity, clear, then raise the same path again. History
   shows both occurrences with independent durations and events; identical repeats
   do not create duplicate occurrences or deliveries.
4. Raise and clear while offline, then reconnect. The occurrence remains readable
   locally and remotely after successful delivery; each transport has its own
   durable outcomes, including later trigger/resolve work.
5. Match two paths and two sources with one wildcard rule. All are inspectable;
   the rule summary cannot replace the individual notification/history records.
6. Acknowledge or silence while the upstream API fails or is unavailable. Display
   the failure/local-only result accurately and preserve the action audit.
7. Browse more than one history page, filter a single source, include dismissed
   entries, and restart: ordering and records remain stable.

Documentation-only review: no runtime fixes or new acceptance tests are implemented
by this update. Prioritize occurrence/event storage and one-time lifecycle, then
history API/UI, then verified zone/control integration and the playback decision.

## Objective

Build a production-quality Signal K plugin that reliably delivers boat alerts across intermittent connectivity.

The plugin must provide:

1. durable/persistent alert capture;
2. lifecycle-aware deduplication;
3. multiple notifier transports running in parallel;
4. independent delivery state/retry per notifier;
5. Starlink/connectivity switch control using Signal K PUT;
6. configurable wake policies;
7. offline queueing and delayed delivery;
8. safe automatic Starlink shutdown;
9. operational status and test/retry APIs.

Initial transports:

- ntfy
- PagerDuty
- Discord webhook

Design the transport layer so additional transports can be added without modifying the queue engine.

## Product behavior

### Example 1: ordinary offline warning

```text
Starlink OFF
Fridge temperature warning occurs
        |
        v
persist alert
create ntfy delivery
connectivity policy = queue
        |
        v
do not wake Starlink
```

Later an emergency wakes Starlink:

```text
Internet becomes available
        |
        +--> deliver fridge warning
        +--> deliver any other eligible backlog
```

### Example 2: critical emergency

```text
High-water emergency
        |
        v
persist alert transactionally
        |
        +--> delivery: ntfy
        +--> delivery: PagerDuty
        +--> delivery: Discord
        |
        v
wake Starlink via Signal K PUT
        |
        v
confirm switch ON
        |
        v
wait for Internet
        |
        v
run all three notifier jobs independently
```

Possible result:

```text
ntfy       delivered
PagerDuty  failed_retryable
Discord    delivered
```

Only PagerDuty remains pending.

### Example 3: condition clears while offline

```text
19:04 bilge high-water emergency
19:17 condition clears
19:30 Internet becomes available
```

Remote delivery must not disappear simply because the current state is normal.

A useful rendered message is:

```text
High-water alarm occurred at 19:04.
Cleared at 19:17 after 13 minutes.
Maximum severity: emergency.
```

## Phase 0: repository bootstrap

Create a standard Signal K TypeScript plugin.

Minimum repository shape:

```text
package.json
tsconfig.json
README.md
AGENTS.md

src/
  plugin.ts
  config.ts

  alerts/
    types.ts
    normalize.ts
    rules.ts
    lifecycle.ts

  storage/
    db.ts
    schema.ts
    migrations/

  delivery/
    scheduler.ts
    retry.ts
    types.ts

  transports/
    transport.ts
    ntfy.ts
    pagerduty.ts
    discord.ts

  connectivity/
    manager.ts
    state-machine.ts
    internet.ts
    signalk-switch.ts

  api/
    routes.ts
    status.ts

test/
  ...
```

Use strict TypeScript.

## Phase 1: internal model

Create transport-agnostic internal types.

### Alert

Suggested fields:

```ts
interface AlertRecord {
  id: string;
  sourceKey: string;
  path: string;

  firstSeenAt: Date;
  lastSeenAt: Date;
  clearedAt?: Date;

  currentState: "active" | "cleared";
  currentSeverity: Severity;
  maxSeverity: Severity;

  message?: string;
  sourcePayload?: unknown;
}
```

### Delivery

```ts
interface DeliveryRecord {
  id: string;
  alertId: string;
  transportInstanceId: string;

  state:
    | "pending"
    | "waiting_connectivity"
    | "sending"
    | "delivered"
    | "failed_retryable"
    | "failed_terminal";

  attemptCount: number;
  nextAttemptAt?: Date;
  lastAttemptAt?: Date;
  deliveredAt?: Date;

  lastErrorCode?: string;
  lastErrorMessage?: string;
  remoteId?: string;
}
```

### Connectivity requirement

```ts
type ConnectivityMode =
  | { mode: "queue" }
  | { mode: "wake" }
  | { mode: "wake_after"; delaySeconds: number };
```

## Phase 2: durable storage

Prefer SQLite unless there is a compelling reason not to.

Create tables approximately equivalent to:

```text
alerts
alert_events
deliveries
connectivity_sessions
metadata/migrations
```

### `alerts`

Store one current logical alert per stable source identity.

Suggested keys:

```text
id
source_key UNIQUE
path
first_seen_at
last_seen_at
cleared_at
current_state
current_severity
max_severity
message
source_payload_json
created_at
updated_at
```

### `alert_events`

Required for full notification history.

Track meaningful lifecycle transitions, not every raw delta:

```text
raised
severity_changed
message_changed
cleared
```

This provides a local audit trail.

### `deliveries`

Unique logical constraint:

```text
(alert_id, transport_instance_id, delivery_generation)
```

The exact generation model depends on how you choose to represent open/clear updates.

The schema must support delivery of:

- alert occurrence;
- later update/clear;
- PagerDuty resolve.

Do not model this so narrowly that a delivered trigger prevents a later remote resolution.

## Phase 3: ingest Signal K notifications

Subscribe to Signal K notification paths.

Normalize incoming records into the internal alert model.

Requirements:

- stable identity primarily by path/notification ID;
- repeated equivalent active updates coalesce;
- update `lastSeenAt`;
- maintain `maxSeverity`;
- recognize normal/clear transitions;
- do not create infinite delivery records for sensor-frequency updates.

Persist lifecycle change before scheduling delivery.

## Phase 4: rule engine

Rules should be ordered and deterministic.

Example:

```yaml
rules:
  - id: bilge-emergency
    match: notifications.bilge.highWater
    minSeverity: emergency
    connectivity:
      mode: wake
    notifiers:
      - ntfy-main
      - pagerduty-critical
      - discord-boat

  - id: shore-power
    match: notifications.electrical.shorePower.*
    minSeverity: alarm
    connectivity:
      mode: wake_after
      delaySeconds: 600
    notifiers:
      - ntfy-main
      - discord-boat

  - id: default-warning
    match: notifications.*
    minSeverity: warn
    connectivity:
      mode: queue
    notifiers:
      - ntfy-main
```

Decide and document whether first-match or merge semantics are used.

Recommendation: allow merge/fan-out but prevent duplicate notifier instance IDs.

## Phase 5: transport registry

Configuration:

```yaml
notifiers:
  ntfy-main:
    type: ntfy
    enabled: true
    server: https://ntfy.sh
    topic: ...
    token: ...

  pagerduty-critical:
    type: pagerduty
    enabled: true
    routingKey: ...

  discord-boat:
    type: discord
    enabled: true
    webhookUrl: ...
```

Instantiate each notifier independently.

The scheduler addresses notifier **instance IDs**, not only notifier type.

This permits multiple ntfy topics, multiple Discord channels, etc.

## Phase 6: ntfy transport

Implement HTTP publishing.

Map severity to priority with configurable defaults.

Suggested default mapping:

```text
normal      2
warn        3
alert       3
alarm       4
emergency   5
```

Support:

- title;
- message;
- priority;
- tags;
- click URL;
- bearer token/auth.

Return categorized errors:

- 2xx -> success;
- 408/429/5xx/network -> retryable;
- most 4xx auth/config failures -> terminal until configuration changes.

Do not implement global retry logic in the transport.

## Phase 7: PagerDuty transport

Use Events API.

Generate a stable dedup key such as:

```text
signalk:<boat/plugin namespace>:<sourceKey>
```

Behavior:

- active alarm -> `trigger`;
- subsequent active update -> trigger/update same dedup key;
- clear -> `resolve` if a remote incident was previously triggered.

Map severity carefully.

Persist PagerDuty's relevant remote identity/dedup context.

PagerDuty failure must never block ntfy or Discord.

## Phase 8: Discord transport

Send Discord webhook messages.

Use embeds where helpful.

Include:

- boat/system name;
- severity;
- alert title/path;
- human-readable message;
- first seen;
- current/cleared state;
- duration if cleared;
- optional dashboard URL.

Discord webhook failures are independently retryable according to HTTP status.

## Phase 9: delivery scheduler

The scheduler:

- reads eligible persisted deliveries;
- respects `nextAttemptAt`;
- limits concurrency;
- marks `sending` transactionally;
- calls the selected transport;
- records the outcome;
- schedules retry with jitter.

Do not hold DB transactions open across HTTP requests.

Suggested algorithm:

```text
claim job
commit
send outside transaction
write result transactionally
```

If multiple workers are ever possible, introduce a durable claim lease.

For the initial plugin, one scheduler process is acceptable, but do not make the schema impossible to evolve.

## Phase 10: connectivity manager

Create one manager for all external transports.

It receives demand:

```text
delivery X requires WAN
alert Y requires wake policy
```

It owns the Starlink state machine.

### State machine

```text
OFF
  |
  v
REQUESTING_ON
  |
  v
POWERED
  |
  v
WAITING_FOR_INTERNET
  |
  v
ONLINE
  |
  v
IDLE_COOLDOWN
  |
  v
REQUESTING_OFF
  |
  v
OFF
```

Fault transitions are possible from power request, state confirmation, and Internet boot.

### Wake procedure

1. Check observed switch state.
2. If already ON:
   - set `startedByPlugin = false`;
   - do not send redundant OFF later.
3. If OFF:
   - persist session intent/ownership;
   - Signal K PUT ON;
   - confirm observed ON;
   - `startedByPlugin = true`.
4. Begin Internet readiness checks.
5. Transition ONLINE after successful probe.

Persist enough information to behave conservatively after restart.

## Phase 11: Internet readiness

Do not assume switch ON means Internet ready.

Use one or more configurable readiness probes.

Possible options:

- HTTPS request to configured URL;
- DNS + HTTPS;
- ntfy/PagerDuty endpoint reachability is not sufficient by itself if only one service happens to be down.

Keep probes low-frequency.

Do not probe aggressively while Starlink is OFF.

## Phase 12: safe shutdown

When work is complete, transition into cooldown.

Only turn Starlink OFF if:

```text
startedByPlugin == true
AND no active wake-required alert
AND no eligible pending delivery requiring WAN
AND no send in flight
AND idle cooldown elapsed
```

If another alert/delivery appears during cooldown:

```text
IDLE_COOLDOWN -> ONLINE
```

If Starlink was already ON before plugin use:

```text
never request OFF
```

If ownership is uncertain after restart:

```text
leave it ON
```

## Phase 13: wake-after behavior

For rules such as shore-power failure:

```yaml
connectivity:
  mode: wake_after
  delaySeconds: 600
```

Implementation:

- persist alert immediately;
- compute durable `wakeDueAt`;
- if alert clears before due time:
  - cancel wake requirement;
  - retain alert history;
  - it may still be queued for later notification depending on rule;
- after restart, reconstruct delayed wake timers from persisted timestamps.

Never rely on an in-memory timer as the sole source of truth.

## Phase 14: batching

When connectivity becomes ONLINE:

- release all eligible queued deliveries, not just the one that caused the wake;
- respect notifier/rule policies;
- prioritize emergency deliveries first;
- continue lower-priority backlog while connectivity is available.

Recommended ordering:

```text
emergency
alarm
alert
warn
normal/history
```

Do not starve old alerts forever.

## Phase 15: configuration schema

Support approximately:

```yaml
storage:
  path: /path/to/plugin.sqlite
  # History retention defaults to unlimited; any purge policy must be explicit.

retry:
  initialSeconds: 10
  maxSeconds: 1800
  multiplier: 2
  jitter: 0.2

connectivity:
  enabled: true

  switch:
    path: electrical.switches.starlink.state
    onValue: 1
    offValue: 0

  switchConfirmTimeoutSeconds: 15
  bootTimeoutSeconds: 240
  internetCheckIntervalSeconds: 5
  idleCooldownSeconds: 300

  probe:
    type: https
    url: https://example.com/generate_204

notifiers:
  ntfy-main:
    type: ntfy
    server: https://ntfy.sh
    topic: ...
    token: ...

  pagerduty-critical:
    type: pagerduty
    routingKey: ...

  discord-boat:
    type: discord
    webhookUrl: ...

rules:
  ...
```

Adapt final schema to Signal K plugin configuration conventions.

Secrets must never appear in logs/status API.

## Phase 16: status/API

Expose a concise operational API.

### `GET /status`

Example:

```json
{
  "connectivity": {
    "state": "OFF",
    "switchOn": false,
    "ownedByPlugin": false
  },
  "alerts": {
    "active": 2,
    "pendingDelivery": 3
  },
  "transports": {
    "ntfy-main": { "pending": 1, "lastSuccess": "..." },
    "pagerduty-critical": { "pending": 1, "lastError": "..." },
    "discord-boat": { "pending": 1, "lastSuccess": "..." }
  }
}
```

Also expose:

- `GET /alerts`
- `GET /deliveries`
- `POST /retry`
- `POST /test/:transport`

Required: notification list, acknowledgement/silence result handling, and full
history UI/API as specified above.

Optional later: connectivity wake/release actions.

## Phase 17: test strategy

Use unit tests around state machines and integration tests around persistence.

Use:

- fake clock;
- fake Signal K app/PUT handler;
- fake Internet probe;
- mocked ntfy server;
- mocked PagerDuty API;
- mocked Discord webhook;
- temporary SQLite database.

### Critical acceptance tests

#### Persistence before network

Simulate process termination immediately after ingest.

After restart:

```text
alert exists
deliveries exist
no alert lost
```

#### Partial notifier failure

```text
ntfy       success
PagerDuty  network failure
Discord    success
```

Expected:

```text
ntfy       delivered
PagerDuty  retryable
Discord    delivered
```

Retry only PagerDuty.

#### Offline wake

```text
switch OFF
emergency arrives
```

Expected:

```text
alert persisted
PUT ON
wait observed ON
wait Internet
send deliveries
```

#### Manual Starlink state

```text
switch already ON
alert arrives
deliveries complete
cooldown expires
```

Expected:

```text
no OFF command
```

#### Plugin-owned Starlink

```text
switch initially OFF
plugin turns ON
deliveries complete
cooldown expires
```

Expected:

```text
OFF requested
```

#### New alert during cooldown

Expected:

```text
shutdown cancelled
delivery performed
cooldown restarts
```

#### Clear while offline

Expected:

- alert occurrence retained;
- clear timestamp retained;
- later rendered delivery represents lifecycle accurately.

#### Restart during wake

After restart, the plugin must reconcile actual switch state and persistent ownership conservatively.

#### Boot timeout

Alert remains queued. Connectivity enters fault/retry policy. No alert is deleted.

#### Switch failure

Alert remains queued. Failure is surfaced through status/logs.

#### Batch delivery

Queued warnings are sent once emergency wakes Internet.

## Phase 18: rendering

Separate event state from message rendering.

Transport-specific renderers may format differently but must use the same AlertRecord.

Example common summary builder:

```ts
interface RenderedAlert {
  title: string;
  body: string;
  severity: Severity;
  occurredAt: Date;
  clearedAt?: Date;
  durationMs?: number;
  dashboardUrl?: string;
}
```

Avoid each transport independently interpreting Signal K payload semantics.

## Phase 19: observability

Log state transitions such as:

```text
alert.upserted
delivery.created
delivery.attempt
delivery.delivered
delivery.retry_scheduled
connectivity.wake_requested
connectivity.switch_confirmed
connectivity.online
connectivity.cooldown_started
connectivity.release_requested
```

Include IDs but redact secrets.

Add metrics/status counters where practical.

## Phase 20: graceful shutdown

On plugin/server stop:

- stop scheduling new HTTP sends;
- finish/persist DB operations;
- mark interrupted send jobs retryable if needed;
- do not automatically power Starlink down as a shutdown side effect;
- close DB cleanly.

## Non-goals for v1

Do not overextend the first release.

Not required initially:

- generic arbitrary command execution from ntfy/Discord;
- SMS modem implementation;
- Telegram;
- email;
- sophisticated web UI;
- distributed multi-node scheduler;
- cloud sync of the queue;
- full incident-management UI.

The architecture must allow new transports later.

## Security constraints

- never log credentials;
- webhook URLs are secrets;
- ntfy public topics are not secure command channels;
- Discord is not a control channel;
- Signal K PUT access must stay scoped to the configured connectivity switch;
- do not allow alert payloads to choose arbitrary PUT paths;
- sanitize/limit rendered payload sizes.

## Safety behavior

When a conflict exists between power savings and reliability:

- keep the alert;
- keep retrying;
- leave Starlink ON if ownership is uncertain;
- do not suppress critical alerts because another notifier succeeded;
- do not let informational notifier failures block critical notifier delivery.

## Suggested implementation order

Implement in this order:

1. TypeScript Signal K plugin skeleton.
2. Internal alert/delivery types.
3. SQLite schema + migrations.
4. Notification ingest and lifecycle deduplication.
5. Rule engine.
6. Transport interface.
7. ntfy transport.
8. Scheduler/retry engine.
9. Parallel transport delivery model.
10. Discord transport.
11. PagerDuty transport with dedup/resolve.
12. Connectivity switch adapter.
13. Connectivity state machine.
14. Internet readiness.
15. wake/wake_after/queue policies.
16. batching.
17. safe ownership-based shutdown.
18. REST/status API.
19. failure/restart integration tests.
20. README and example config.

This order deliberately establishes durability before adding Starlink power control.

## Minimum v1 acceptance criteria

The first usable release is complete when all of these are true:

- Signal K notification is written to durable storage before delivery.
- Queue survives Signal K restart.
- Same alert path does not create unbounded duplicates.
- Alert clear while offline is not lost.
- ntfy, PagerDuty, and Discord can be configured simultaneously.
- Each notifier has independent success/failure state.
- Failed notifier retries do not repeat successful notifier sends.
- Starlink switch can be configured through a Signal K PUT path.
- `wake`, `wake_after`, and `queue` policies work.
- Starlink boot waits for observed power state and Internet readiness.
- Backlogged alerts batch when WAN is available.
- Plugin never shuts down a Starlink connection that was already manually ON.
- Plugin-owned Starlink shuts down only after queue drain and cooldown.
- Restart during offline/wake/retry paths does not lose alerts.
- Status endpoint shows queue, notifier, and connectivity health.
- Automated tests cover all critical failure paths.

## Deliverables expected from the coding agent

Produce:

1. working plugin source;
2. automated test suite;
3. package metadata suitable for Signal K installation;
4. configuration schema;
5. example configuration;
6. README with architecture and setup;
7. migration-safe durable storage;
8. ntfy transport;
9. PagerDuty transport;
10. Discord transport;
11. Starlink/connectivity switch manager;
12. REST/status endpoints;
13. documented limitations and recovery behavior.

When implementation choices differ from this brief, document the reason and preserve the reliability invariants in `AGENTS.md`.
