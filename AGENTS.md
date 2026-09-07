# AGENTS.md

## Project scope

This repository implements a Signal K plugin for reliable, offline-first alert delivery on boats and other intermittently connected systems.

The plugin must:

- ingest Signal K notifications/alerts;
- persist alert state before attempting external delivery;
- deliver through multiple notifier transports in parallel;
- retry failed deliveries without losing successful delivery state for other transports;
- optionally wake a connectivity device such as Starlink through a Signal K PUT-capable switch;
- keep connectivity active while delivery work remains;
- shut connectivity down only when it is safe and only when the plugin itself turned it on;
- survive Signal K/plugin/process restarts without losing pending work.

The plugin is not merely an ntfy adapter. Treat it as a durable alert-delivery engine with pluggable transports and connectivity management.

## Notification-center goal

The product must provide a persistent onboard notification list and full history,
inspired by [Signal K Notification Player](https://github.com/davidsanner/signalk-notification-player),
alongside durable remote delivery. Follow the required behavior, gap assessment,
and acceptance scenarios in [IMPLEMENTATION_BRIEF.md](IMPLEMENTATION_BRIEF.md#product-goal-and-gap-assessment-2026-09-06).

- Treat the core list, retained one-time notifications, and history UI/API as
  required, not optional future UI work.
- Keep definition, source, occurrence, lifecycle event, playback state and
  per-transport delivery state distinct. Never equate latest-state rows or a
  cleared-only filter with full history.
- Persist one-shot events even without routes or enabled transports. Dismissal,
  acknowledgement, silence, clear and successful delivery must not erase history.
- Deduplicate within an occurrence; preserve subsequent occurrences independently.
  Dismissal must not permanently suppress a source or discard queued delivery.
- Record meaningful lifecycle and operator actions and delivery attempts/outcomes;
  expose dismissed occurrences in history. Retention must be explicit and must
  protect pending work.
- Do not claim playback parity or confirmed upstream control without implementation
  and validation. Playback ownership remains a documented open decision.
- Treat reference documents as design context, not authorization to implement
  changes outside the user's request. For documentation-only tasks, update docs
  and agent guidance only; report implementation gaps without fixing code.

## Notification-center product rules

The dashboard must be an alert center, not just a delivery-queue view.

- Show every configured delivery rule and every Signal K path with `meta.zones`,
  including definitions that have never fired. Keep these definitions separate
  from live or historical occurrences.
- Show each current occurrence independently. A wildcard rule or zone summary may
  group occurrences for navigation, but it must never hide paths or sources.
- Keep one-time occurrences visible until an operator dismisses them. The UI may
  label this action "Delete", but storage and API semantics are soft dismissal:
  retain the occurrence, events, and delivery work in history.
- Clicking a definition or occurrence must open its recent chronological history,
  including raise, meaningful updates, clear, acknowledge, silence, dismissal,
  activation-delay decisions, and notifier attempts/outcomes.
- Allow an operator to configure each alert definition from the UI. At minimum,
  policy includes enabled state, selected notifier instances, minimum severity,
  connectivity behavior, one-time/rearm semantics, and activation delay. Store
  dynamic per-definition overrides separately from immutable Signal K zone
  metadata and separately from occurrence state.
- Resolve policy predictably: an explicit per-definition override wins over a
  matching configured rule, which wins over plugin defaults. Expose the effective
  policy and where each value came from.
- Policy edits apply to future occurrences by default. Do not silently add or
  cancel delivery work for an occurrence already in progress; any explicit
  "apply to current occurrence" operation must be auditable and idempotent.

`activationDelaySeconds` means that external delivery is eligible only after the
same occurrence has remained active continuously for that duration. Persist the
deadline. If the condition clears first, record `suppressed_before_activation`
and create no remote delivery, while retaining the occurrence in history. Recheck
the persisted deadline and active state after restart. Do not implement this as an
in-memory timer, and do not confuse it with `wake_after`, which controls when to
power connectivity after delivery has already become eligible.

This repository is pre-release and the occurrence schema is the first supported
schema. Do not add compatibility code for the discarded prototype SQLite layout;
recreate development databases instead. Any schema change after the first release
must use a transactional, restart-safe migration.

For end-to-end changes, run the real-server acceptance environment with
`npm run test:acceptance`, then clean it up with
`docker compose -f docker-compose.acceptance.yml down -v`. Keep fixture plugins
and mock transports test-only; acceptance must never contact real notification
services or vessel hardware.

## Signal K integration rules

- Follow the current legacy alarm contract: subscribe to `notifications.*`, treat
  a null value as a clear/removal, retain the delta timestamp and `$source`, and
  preserve the original notification value. Do not silently reinterpret unknown
  states without recording the original value and a documented mapping.
- Reconcile the current `notifications` subtree at startup as well as subscribing
  to deltas. Make snapshot/subscription processing idempotent so startup neither
  loses an update nor creates a duplicate historical occurrence.
- Discover zone definitions from `meta.zones` throughout the self-vessel model.
  A zone on `environment.depth.belowKeel` corresponds to the generated notification
  path `notifications.environment.depth.belowKeel`; zone discovery itself must not
  fabricate a fired occurrence.
- Use `app.notifications` for supported acknowledge, silence, and clear operations.
  Read capability flags first, await/handle the real result where supported, and
  distinguish confirmed upstream actions from local-only operator annotations.
- Type the plugin with `@signalk/server-api` instead of growing new `any`-shaped
  server interfaces. Verify lifecycle, schema, subscription, and router behavior
  against the supported server version.
- Register read APIs with the least required router access and mutations with
  read-write/admin access. Standalone web requests must include the Signal K
  session cookie and handle authentication failure explicitly.
- Keep a complete OpenAPI definition for all plugin routes, including filters,
  pagination, mutation bodies, success responses, and error responses.
- Signal K Notification Player is a behavior reference for definition discovery,
  history drill-down, and per-path controls. Do not copy its synchronous JSON log,
  GET-based mutations, global mutable state, or legacy untyped architecture.

## Core reliability invariants

These invariants are mandatory and take precedence over convenience:

1. **Persist before send.**
   A notification that requires delivery must be durably recorded before any network request or Starlink wake action is attempted.

2. **Never delete globally because one notifier succeeded.**
   Delivery state is tracked independently per configured notifier.

3. **A notifier failure must not block unrelated notifiers.**
   ntfy can fail while PagerDuty and Discord succeed, and vice versa.

4. **Emergency alerts are durable.**
   Emergency/critical alerts must not expire merely because retries have run for a long time.

5. **Restarts must be safe.**
   On startup, recover pending alerts, delivery attempts, wake ownership, and any incomplete delivery work from persistent storage.

6. **Do not turn off manually enabled connectivity.**
   The plugin may power Starlink off only when it can prove that the current connectivity session was started by the plugin.

7. **Do not send notification spam.**
   Repeated Signal K updates for the same logical alert must update a durable alert record rather than create unbounded duplicate deliveries.

8. **Cleared alerts still matter.**
   If an alert was raised and later cleared while offline, the eventual remote message must preserve the occurrence and lifecycle rather than silently dropping it.

9. **Power control and message delivery are separate concerns.**
   Connectivity management must not be implemented inside individual notifier transports.

10. **Configuration is declarative.**
    Alert routing, wake behavior, notifier selection, severity thresholds, delays, cooldowns, retry limits, and switch paths must be configurable.

## Code quality, formatting, and style

Code quality is part of correctness.

Before considering any implementation task complete:

- format all changed code with the repository-standard formatter;
- lint all changed code with the repository-standard linter;
- fix all formatter and lint errors;
- keep TypeScript in strict mode;
- keep imports ordered and consistent with repository conventions;
- use clear, consistent naming for files, types, functions, classes, states, and configuration keys;
- avoid dead code, unused exports, stale comments, commented-out code, and avoidable `any`;
- keep modules focused and avoid oversized files when responsibilities can be separated cleanly;
- preserve existing style when contributing to an established repository;
- add formatter/linter commands to `package.json` and CI when the repository does not already provide them.

Preferred tooling for a new repository:

- Prettier for formatting;
- ESLint with TypeScript support for linting;
- repository-consistent import ordering;
- automated format/lint/test checks in CI.

Do not hand-format around formatter output. Configure the formatter once and use it consistently.

A change is not done if the code builds but formatting or lint checks fail.

## Architecture research rule

Do not invent Signal K-specific architecture when an established convention likely exists.

When there is uncertainty about any of the following:

- Signal K plugin lifecycle;
- plugin registration and packaging;
- configuration schemas;
- subscriptions;
- notification or alert semantics;
- REST route registration;
- authentication;
- Signal K PUT handling;
- plugin web UI conventions;
- server APIs;
- data paths;
- plugin state publication;
- installation/update behavior;
- TypeScript patterns used by Signal K plugins;

research existing conventions before implementing.

Use this order of preference:

1. current official Signal K documentation;
2. current Signal K server source/types;
3. current first-party Signal K plugins;
4. mature, actively maintained, well-starred Signal K plugin repositories;
5. smaller third-party plugins only when better references do not exist.

When reviewing reference repositories:

- prefer repositories with meaningful adoption/stars and recent maintenance;
- inspect actual source, configuration, packaging, tests, and release structure rather than copying README snippets blindly;
- compare more than one mature plugin when the architectural choice is significant;
- prefer patterns that align with current Signal K releases;
- avoid copying deprecated APIs or legacy JavaScript patterns into a new TypeScript implementation.

If this project intentionally deviates from established Signal K patterns, document:

- the convention that was considered;
- why it was unsuitable here;
- the chosen alternative;
- any compatibility or maintenance implications.

For non-Signal-K-specific concerns such as SQLite schema design, retry scheduling, state machines, or HTTP clients, prefer conventional Node.js/TypeScript engineering practices rather than forcing Signal K-specific patterns where none are needed.

## Preferred technology

- TypeScript
- Node.js version compatible with the supported Signal K server release
- Signal K plugin conventions and APIs
- Strict TypeScript
- ESLint/Prettier or repository-standard equivalents
- A lightweight embedded durable store suitable for Raspberry Pi use

Prefer a real embedded database with transactions, such as SQLite, over ad-hoc JSON files once persistence becomes non-trivial. If another store is chosen, document why it is safer or simpler.

Avoid introducing a large framework unless it clearly reduces complexity.

## Formatting, style, and code quality

Code quality is part of correctness. Do not consider a change complete merely because it compiles or the happy path works.

Before finishing any implementation change:

- run the repository formatter on all changed files;
- run the linter and fix all lint errors;
- run TypeScript type-checking with strict settings;
- run the relevant test suite;
- keep imports ordered and remove unused imports/dead code;
- follow the naming, file layout, error-handling, and logging conventions already established in the repository;
- avoid inconsistent one-off style choices;
- prefer clear types and small explicit interfaces over implicit `any` or loosely shaped objects;
- do not disable lint/type rules merely to make checks pass unless there is a documented technical reason;
- keep generated/config examples formatted as well as source code.

If the repository already defines `format`, `lint`, `typecheck`, `test`, or equivalent scripts, use those exact scripts rather than inventing parallel tooling.

If formatter/linter configuration is missing, establish a minimal conventional setup appropriate for a modern TypeScript Signal K plugin and document the commands in the README.

CI should, where practical, enforce the same formatting, linting, type-checking, and test commands used locally.

A PR/change is not done while changed code would fail the configured formatter, linter, type checker, or relevant tests.

## Architecture research and precedent

Do not guess at Signal K architecture when established patterns can be checked.

When an implementation decision touches any of the following, first inspect current Signal K sources/documentation and mature Signal K plugin implementations:

- plugin lifecycle and `start`/`stop` behavior;
- plugin metadata and packaging;
- configuration schemas;
- subscriptions;
- notifications/alerts;
- Signal K PUT handling;
- REST route registration;
- authentication/authorization;
- plugin data directories and persistent storage;
- web/plugin UI conventions;
- logging;
- server compatibility;
- testing conventions.

Use this research order:

1. **Current official Signal K documentation and server source** for the authoritative API/behavior.
2. **Current Signal K-maintained examples/plugins** where available.
3. **Mature, actively maintained, well-starred Signal K plugin repositories** to understand real-world conventions and edge cases.

When reviewing community plugin repositories:

- prefer repositories with meaningful adoption/stars and recent maintenance;
- prefer plugins targeting current Signal K server versions;
- inspect more than one mature repository when the architectural choice is significant;
- copy conventions, not bugs or obsolete compatibility workarounds;
- confirm that patterns seen in old plugins are still compatible with current Signal K APIs.

Do not invent a custom abstraction for something Signal K already provides unless there is a clear reliability or maintainability reason.

If this plugin intentionally deviates from common Signal K plugin architecture, document the deviation and rationale in code comments or architecture documentation, especially where persistence, notification lifecycle, connectivity control, or REST behavior differs from established patterns.

For architecture questions that remain ambiguous after research, choose the design that best preserves the reliability invariants in this file.

## Suggested architecture

Keep modules small and explicit.

```text
Signal K source adapter
        |
        v
Alert lifecycle engine
        |
        v
Durable store
        |
        +----------------------+
        |                      |
        v                      v
Delivery scheduler      Connectivity manager
        |                      |
        v                      v
Transport registry      Signal K PUT switch
   |    |    |
   |    |    +-- Discord
   |    +------- PagerDuty
   +------------ ntfy
```

Recommended module boundaries:

- `src/plugin.ts`
  - Signal K lifecycle: start/stop
  - configuration loading
  - subscriptions
  - REST/API registration

- `src/alerts/`
  - normalization
  - lifecycle transitions
  - deduplication/coalescing
  - rule matching

- `src/storage/`
  - migrations
  - alert/event persistence
  - per-transport delivery persistence
  - leases/locks if required

- `src/delivery/`
  - scheduler
  - retry/backoff
  - concurrency control
  - batching
  - delivery result handling

- `src/transports/`
  - shared transport interface
  - `ntfy`
  - `pagerduty`
  - `discord`
  - future adapters

- `src/connectivity/`
  - Starlink/switch state machine
  - Signal K PUT
  - switch-state observation
  - Internet reachability
  - ownership/cooldown

- `src/api/`
  - queue/status endpoints
  - manual retry
  - test notification
  - optional UI data

## Internal alert model

Do not couple persistence directly to the exact current Signal K notification schema.

Normalize Signal K input into an internal representation similar to:

```ts
type AlertSeverity =
  | "normal"
  | "warn"
  | "alert"
  | "alarm"
  | "emergency";

interface AlertRecord {
  id: string;                 // stable internal ID
  sourceKey: string;          // usually Signal K path/id
  path: string;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt?: string;
  currentSeverity: AlertSeverity;
  maxSeverity: AlertSeverity;
  currentState: "active" | "cleared";
  message?: string;
  value?: unknown;
  metadata?: Record<string, unknown>;
}
```

Preserve enough source data to support future Signal K alert APIs without rewriting the queue engine.

## Delivery model

Each logical alert can have zero or more delivery targets.

Track them independently:

```ts
type DeliveryState =
  | "pending"
  | "waiting_connectivity"
  | "sending"
  | "delivered"
  | "failed_retryable"
  | "failed_terminal";

interface DeliveryRecord {
  id: string;
  alertId: string;
  transportId: string;        // concrete configured notifier instance
  state: DeliveryState;
  attempts: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
  remoteId?: string;
}
```

Do not represent all notifiers with one boolean.

## Transport interface

All notifier integrations must implement one common interface.

For example:

```ts
interface NotificationTransport {
  readonly type: string;

  validateConfig(config: unknown): void;

  send(
    alert: AlertRecord,
    delivery: DeliveryRecord,
    context: TransportContext
  ): Promise<TransportResult>;

  healthCheck?(): Promise<TransportHealth>;
}
```

Transport results must distinguish:

- success;
- retryable failure;
- permanent/configuration failure.

Transport code must not own retry scheduling or Starlink power.

## Initial transports

Implement these as independent notifier instances that can be enabled simultaneously.

### ntfy

Support at minimum:

- server URL;
- topic;
- token/auth where applicable;
- priority mapping;
- title/message;
- tags;
- click URL;
- optional actions later.

### PagerDuty

Use PagerDuty Events API semantics.

Support at minimum:

- routing/integration key;
- trigger;
- resolve where appropriate;
- dedup key derived from stable alert identity;
- severity mapping;
- links/custom details where useful.

Do not create a new PagerDuty incident for every repeated Signal K delta of the same logical alert.

### Discord

Support Discord webhooks.

Support at minimum:

- webhook URL;
- human-readable title/body;
- severity;
- timestamps;
- optional embeds.

Discord should be considered an informational notifier, not a guaranteed wake-up mechanism.

## Parallel delivery

A rule may target more than one transport:

```yaml
notifiers:
  - ntfy-main
  - pagerduty-critical
  - discord-boat
```

All matching targets are scheduled independently.

Example result:

```text
ntfy       delivered
PagerDuty  retrying
Discord    delivered
```

This alert remains pending only for PagerDuty. Successful ntfy and Discord deliveries must not be repeated unless policy explicitly requests repeat/escalation behavior.

## Alert lifecycle and deduplication

The stable source key should normally be the Signal K notification path or another stable alert ID.

Repeated updates while active must coalesce.

Example:

```text
19:04 notifications.bilge.highWater -> emergency
19:05 notifications.bilge.highWater -> emergency
19:08 notifications.bilge.highWater -> emergency
19:17 notifications.bilge.highWater -> normal/cleared
```

The durable history must preserve:

- first seen;
- last seen;
- maximum severity;
- current state;
- clear time.

When first delivery happens after the alert has already cleared, the rendered notification should be able to say that it occurred and later cleared, including timestamps/duration.

Do not simply drop a cleared alert that was never delivered.

## Connectivity modes

Rules must support at least:

- `queue`
  - persist now;
  - do not wake Starlink;
  - deliver whenever Internet becomes available for another reason.

- `wake`
  - persist;
  - request Starlink immediately;
  - deliver when online.

- `wake_after`
  - persist;
  - wake only if the condition remains active past a configured duration.

Recommended rule example:

```yaml
rules:
  - match: "notifications.environment.inside.fridge.*"
    minSeverity: warn
    connectivity: queue
    notifiers: [ntfy-main]

  - match: "notifications.electrical.shorePower.*"
    minSeverity: alarm
    connectivity:
      mode: wake_after
      delaySeconds: 600
    notifiers: [ntfy-main, discord-boat]

  - match: "notifications.bilge.highWater"
    minSeverity: emergency
    connectivity: wake
    notifiers: [ntfy-main, pagerduty-critical, discord-boat]
```

## Connectivity manager

Implement connectivity as an explicit state machine.

Suggested states:

```text
OFF
REQUESTING_ON
POWERED
WAITING_FOR_INTERNET
ONLINE
IDLE_COOLDOWN
REQUESTING_OFF
FAULT
```

Configuration should support:

- Signal K switch path;
- ON and OFF values;
- optional separate observed-state path;
- switch confirmation timeout;
- Internet readiness checks;
- Starlink boot timeout;
- idle cooldown;
- maximum keepalive if appropriate.

## Signal K switch control

Use Signal K PUT for the configured switch rather than coupling to Shelly/GPIO/Victron/etc.

Example configuration:

```yaml
connectivity:
  enabled: true

  switch:
    path: electrical.switches.starlink.state
    onValue: 1
    offValue: 0

  switchConfirmTimeoutSeconds: 15
  internetTimeoutSeconds: 240
  internetCheckIntervalSeconds: 5
  idleCooldownSeconds: 300
```

The exact path is installation-specific.

## Connectivity ownership

This is mandatory.

Before requesting ON, record whether the switch was already ON.

Cases:

### Initially OFF

```text
plugin sees OFF
plugin requests ON
plugin confirms ON
session.startedByPlugin = true
```

The plugin may later turn it OFF.

### Initially ON

```text
plugin sees ON
plugin uses connectivity
session.startedByPlugin = false
```

The plugin must leave it ON.

If ownership is ambiguous after a crash/restart, prefer leaving Starlink ON rather than risking turning off a manually enabled connection.

## Shutdown conditions

Only request OFF when all are true:

- the plugin owns the connectivity session;
- no pending delivery currently requires connectivity;
- no active alert has a wake-required policy;
- no retry is scheduled within the protected keepalive window;
- no send is in flight;
- the configured idle cooldown has elapsed.

A newly arriving alert during cooldown cancels shutdown.

## Batching

Once Internet becomes available, attempt all eligible queued deliveries, including low-priority notifications that did not themselves justify waking Starlink.

Example:

```text
fridge warning    queued
battery warning   queued
bilge emergency   wakes Starlink
                  |
                  +--> ntfy fridge
                  +--> ntfy battery
                  +--> ntfy/PagerDuty/Discord bilge
```

This minimizes Starlink power cycles.

## Retry policy

Retry scheduling belongs in the delivery scheduler.

Use exponential backoff with jitter and a configurable cap.

Example progression:

```text
10s
30s
1m
2m
5m
10m
30m
...
```

Requirements:

- persist `nextAttemptAt`;
- resume after restart;
- avoid synchronized retry storms;
- parse HTTP status codes appropriately;
- do not hammer services on authentication/configuration errors;
- emergency deliveries must remain durable.

## Storage semantics

Use atomic/transactional updates for:

- ingesting/updating an alert;
- creating required per-transport delivery rows;
- transitioning delivery state;
- recording delivered results.

At-least-once remote sending is acceptable where remote APIs do not allow perfect exactly-once behavior, but use remote deduplication facilities where available.

PagerDuty dedup keys should be stable.

## Plugin status

Expose useful operational state via REST and, where appropriate, Signal K values.

At minimum expose:

- pending logical alerts;
- pending deliveries;
- per-notifier status;
- oldest pending delivery;
- last successful remote delivery;
- connectivity state;
- switch observed state;
- whether the plugin owns the current connectivity session;
- last connectivity error;
- last delivery error.

Potential paths:

```text
notifications.delivery.pendingCount
notifications.delivery.oldestPending
notifications.delivery.lastSuccess
notifications.delivery.connectivity.state
```

Choose final paths according to Signal K conventions; do not invent incompatible standard paths without documenting them as plugin-specific.

## REST/API hooks

Provide APIs for the required notification list and history UI:

- `GET /status`
- `GET /alerts`
- `GET /deliveries`
- `POST /retry`
- `POST /test/:transport`
- optional `POST /connectivity/wake`
- optional `POST /connectivity/release`

Manual actions must be authenticated through Signal K's normal plugin/server mechanisms.

## Configuration

Validate configuration at plugin startup.

Configuration must support:

- multiple configured instances of the same transport;
- per-instance secrets;
- rules matching Signal K paths;
- minimum severity;
- connectivity mode;
- notifier fan-out;
- retry settings;
- persistence settings;
- connectivity switch settings.

Never log secrets.

## Logging

Use structured, actionable logs.

Include:

- alert ID/source key;
- delivery ID;
- transport ID;
- attempt number;
- connectivity state transition;
- switch command/result.

Do not include:

- webhook URLs;
- ntfy bearer tokens;
- PagerDuty keys;
- other credentials.

## Graceful shutdown

On plugin stop:

- stop accepting/scheduling new sends;
- stop timers;
- allow short bounded completion of in-flight database operations;
- persist all states;
- do not turn Starlink off merely because the plugin/server is shutting down;
- leave ambiguous connectivity ownership in the safe state.

## Tests required

Do not consider the implementation complete without automated tests for at least:

1. alert persisted before send;
2. offline alert survives restart;
3. offline -> Starlink wake -> online -> send;
4. ntfy success + PagerDuty failure + Discord success;
5. failed notifier retries without resending successful transports;
6. duplicate Signal K updates coalesce;
7. clear-before-first-delivery preserves historical alert;
8. emergency alert never expires due only to retry age;
9. Starlink already manually ON is never turned OFF by plugin;
10. plugin-owned Starlink is turned OFF after queue drain + cooldown;
11. new alert during cooldown cancels shutdown;
12. switch PUT failure keeps alerts queued;
13. switch reports ON but Internet boot times out;
14. restart during Starlink boot;
15. restart during pending retry;
16. concurrent alerts do not race switch ownership;
17. queued low-severity deliveries are batched when emergency wakes WAN;
18. PagerDuty uses stable dedup identity;
19. configuration secrets are redacted from logs;
20. graceful shutdown preserves queue.

Prefer deterministic fake clocks and mocked transports/network state.

## Failure philosophy

On uncertainty:

- preserve the alert;
- preserve delivery state;
- leave connectivity ON rather than incorrectly switching it OFF;
- avoid duplicate incident creation where the remote service supports deduplication;
- expose the failure clearly.

Never trade alert durability for a cleaner queue.

## Security

- secrets only in Signal K plugin configuration or supported secret mechanisms;
- never expose credentials via status endpoints;
- validate outbound URLs;
- avoid arbitrary command execution;
- interactive notifier actions must not directly execute privileged boat commands without an explicit authorization layer;
- do not treat Discord or public ntfy topics as secure control channels.

## Performance constraints

Target Raspberry Pi-class hardware.

Avoid:

- high-frequency polling when subscriptions/events are available;
- unbounded in-memory queues;
- rewriting large files for every alert;
- aggressive Internet probes while Starlink is OFF.

## Documentation

README must eventually explain:

- architecture;
- supported Signal K versions;
- installation;
- ntfy/PagerDuty/Discord setup;
- Starlink switch setup;
- offline behavior;
- queue semantics;
- safety/ownership behavior;
- example configuration;
- troubleshooting;
- how to send a test alert.

## Coding workflow

Before changing behavior:

1. understand the relevant state transition;
2. identify the durability boundary;
3. identify effects on all transports;
4. identify effects on connectivity ownership;
5. if the change involves Signal K architecture/API behavior, check current official Signal K docs/source and mature well-starred plugin repos before designing a custom pattern;
6. add/update tests;
7. implement the smallest coherent change;
8. run formatter;
9. run linter;
10. run strict TypeScript type-checking;
11. run unit/integration tests;
12. document configuration or architectural changes.

Do not make broad refactors while reliability behavior is still untested.

## Definition of done

A feature is complete only when:

- its state is durable where required;
- restart behavior is defined;
- parallel notifier behavior is defined;
- connectivity ownership implications are defined;
- errors are observable;
- automated tests cover the important failure paths;
- user-facing configuration is documented.
