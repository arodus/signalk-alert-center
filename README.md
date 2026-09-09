# Signal K Persistent Notifier

An offline-first Signal K plugin for durable alert delivery through ntfy, PagerDuty, and Discord. Alerts and independent per-notifier delivery rows are stored in SQLite before any network or switch operation.

## Alert center

This project provides a persistent onboard notification center inspired by
[Signal K Notification Player](https://github.com/davidsanner/signalk-notification-player),
with one alert list, retained event history, and offline remote delivery. It discovers
Signal K `meta.zones` and incoming notification paths, including definitions that
have never fired. Every raise/clear cycle
is stored as a distinct occurrence, while duplicate updates within the cycle are
coalesced. Clicking an occurrence opens its durable event and notifier history.

One-time behavior is snapshotted when an occurrence starts. The occurrence remains
visible until **Dismiss** is selected; dismissal is soft, so its history
and pending delivery work remain intact. A later raise creates a visible new
occurrence. Per-definition settings cover enabled state, minimum severity,
notifiers, activation delay, repeat interval, and connectivity mode.

Local sound/TTS playback is intentionally not implemented. The remaining roadmap
is transport resolve semantics, richer global history filters/observability,
retention controls, browser automation, and a decision whether playback belongs
here or in a dedicated player.

See the [gap assessment and acceptance scenarios](IMPLEMENTATION_BRIEF.md#product-goal-and-gap-assessment-2026-09-06)
for verified source findings, required behavior, and unresolved scope decisions.

## Signal K and Notification Player review

The target architecture follows Signal K's separation between definitions and
events: `meta.zones` define alarm thresholds on ordinary vessel paths, while the
server raises values below `notifications.*` and clears them with a null delta.
The plugin must subscribe to those notification deltas and also reconcile the
current notification subtree at startup. Delta `$source` and timestamp are part of
occurrence identity and audit data, not optional display details.

The implementation uses the current typed Signal K plugin surface and keeps the
following boundaries explicit:

| Area            | Implemented behavior                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definitions     | Discovered Signal K zones and notification paths are durable and visible before they fire.                                                                                          |
| Ingestion       | An all-source subscription is established before startup reconciliation; `$source`, source time, receipt time, and raw values are retained. Null/normal values clear an occurrence. |
| Identity        | Definitions, recurring occurrences, immutable events, notifier intents, and delivery attempts use separate tables.                                                                  |
| One-time alerts | Dismissal is occurrence-scoped and does not delete history or suppress the next occurrence.                                                                                         |
| Policy          | Durable per-definition overrides are edited in the dashboard and snapshotted onto new occurrences.                                                                                  |
| Delay and retry | Activation and retry deadlines are persisted, recovered after restart, and driven by timers derived from the database.                                                              |
| API/UI security | Reads use read-only access, mutations use read-write access, browser requests include the Signal K session, and OpenAPI describes the complete surface.                             |

[Signal K Notification Player](https://github.com/davidsanner/signalk-notification-player)
is a useful product reference: it discovers known/configured notifications, opens
per-path recent history, persists zone transitions even when audio is disabled,
and supports per-path playback controls. Its synchronous JSON log, large untyped
single module, mutable GET endpoints, and playback-specific queue should not be
copied. This plugin's SQLite occurrence/event model and authenticated REST
mutations are the better base for durable remote delivery.

## Dashboard behavior

The compact main view puts current alerts first and defaults to active alerts.
It can switch to all known alert definitions. Multiple sources for the same path
remain individually inspectable while active. Clicking a row opens its recent event
and notifier-delivery history.

The same table also contains Signal K thresholds and notification paths learned from
incoming data, including disabled and never-fired definitions when **All known
alerts** is selected. The UI calls these learned entries “Discovered paths”;
“discovered” is definition provenance, not a live alert state. Signal K zone metadata
remains an input to definition discovery, but definitions are not grouped by zone.
Each row opens current information and history and has a direct **Settings** action.

The event timeline includes raised, message/severity changes, activation-delay
expiry or suppression, clear, acknowledge, silence, dismissal, policy actions,
and every notifier attempt/outcome. History uses cursor-based pagination and filters
for state, severity, and dismissal.

For an occurrence the UI presents a **Dismiss** action. It disappears from the
active list, remains in history, and
does not cancel pending notifier delivery. A later occurrence on the same path and
source is a new row and becomes visible normally.

This is distinct from **Forget alert**, which is available only for inactive
discovered definitions and permanently removes their history and settings. Definitions
derived from current Signal K zone metadata cannot be forgotten.

The definition settings panel controls enabled state, notification services, minimum
severity, connectivity mode, repeat interval, and
`activationDelaySeconds`. Overrides are stored by this plugin; Signal K
`meta.zones` remain authoritative input metadata and are not rewritten. Settings
apply to future occurrences by default so changing a policy does not silently
change delivery already in progress.

An activation delay is different from `wake_after`:

- `activationDelaySeconds`: notify only if the same occurrence remains active for
  the configured duration. Persist the deadline; if it clears first, retain the
  occurrence and record `suppressed_before_activation`, but create no remote
  delivery.
- `wake_after`: once a delivery is eligible, wait before requesting managed
  connectivity. It affects power behavior, not whether the alert qualifies.

## Implementation status and roadmap

The initial alert-center implementation followed these phases. This is a new
project: the prototype SQLite schema was not a compatibility contract and was
replaced rather than migrated. Released schema changes must use migrations.

### 1. Signal K boundary — implemented

- Add `@signalk/server-api` types and declare the supported Signal K server range.
- Correct null/normal clear handling, preserve unknown raw values, and capture
  delta timestamp plus `$source`.
- Subscribe before taking a startup snapshot, then reconcile both streams through
  one idempotent ingest path so an event arriving during startup is neither lost
  nor duplicated.
- Wire zone discovery into the catalog and refresh it when metadata changes or on
  an explicit low-frequency rescan. Treat zones as definitions only.

### 2. Occurrence-based schema — implemented

Create a clean schema, recording its version for future migrations, with:

- `alert_definitions`: zone/discovered identity and display metadata;
- `alert_policies` plus a normalized definition-to-notifier mapping;
- `alert_occurrences`: immutable occurrence identity, source/path, lifecycle,
  source/receipt times, current and maximum severity, dismissal, and clear time;
- `alert_events`: immutable snapshots for meaningful lifecycle/operator changes;
- `delivery_intents` and `delivery_attempts`: per-occurrence, per-notifier desired
  work and append-only results;
- persisted activation and connectivity deadlines.

Do not add migration code for the discarded prototype schema. Development databases
created by earlier commits should be deleted and recreated. Add indexes for
current-list lookup and stable, cursor-based history order (`occurred_at`, unique
id); future released schema changes must use transactional migrations.

### 3. Recurrence, dismissal, and delay state machines — implemented

- Start an occurrence on inactive-to-active transition; coalesce identical updates
  while active; close it on null/normal; start a new occurrence on the next raise.
- For sources that never send clear, support explicit producer identity when
  present and a documented configurable rearm policy. Do not guess a new event from
  repeated identical deltas.
- Persist `activation_due_at`. Promote still-active occurrences to notifier intents
  at the deadline; otherwise record suppression. Recover overdue deadlines on
  restart before running the delivery scheduler.
- Make dismissal occurrence-scoped and independent of acknowledge, silence,
  upstream clear, activation, and delivery state.

### 4. Policy and history APIs — implemented

Provide at least:

```text
GET   /definitions
GET   /definitions/:id
PATCH /definitions/:id/policy
DELETE /definitions/:id
GET   /occurrences
GET   /occurrences/:id
GET   /occurrences/:id/events
POST  /occurrences/:id/dismiss
POST  /occurrences/:id/acknowledge
POST  /occurrences/:id/silence
```

Keep the existing status/delivery/retry endpoints during migration. Use cursors,
bounded limits, filter validation, stable ordering, and structured error bodies.
Expose effective policy and provenance (`override` or `default`). Register
read routes as read-only and mutations as read-write/admin using the supported
Signal K router API, and publish the complete contract through `getOpenApi()`.

### 5. Definitions and occurrences dashboard — implemented

- Render active and known definitions in one compact alert table.
- Add an accessible detail drawer opened by click and keyboard, with paginated
  recent history and notifier outcomes.
- Add a policy editor populated from configured notification services, with validation
  and an explicit save result.
- Add global history filters, pagination, dismissed-state visibility, empty/loading/
  auth/error states, and responsive layouts suitable for an onboard tablet.
- Use `credentials: "include"`; redirect or link to Signal K login on 401/403.

### 6. Delivery integration — partially implemented

- Create delivery intents only after activation eligibility and snapshot the
  effective policy onto the occurrence so later edits do not rewrite history.
- Keep every notifier independent, append every attempt, and preserve PagerDuty
  dedup identity per occurrence. Add resolve delivery where the transport supports
  it without overwriting the trigger result.
- Keep connectivity requests downstream of eligible delivery. Re-evaluate
  `wake_after` cancellation and shutdown protection against occurrence-based work.

### 7. Compatibility, observability, and retention — remaining roadmap

- Await and audit Signal K notification API actions after checking `canSilence`,
  `canAcknowledge`, and `canClear`; show unsupported and failed actions honestly.
- Expand status with oldest pending work, last success/error per notifier, overdue
  activation counts, migration version, and database health.
- Default history retention to unlimited. If bounded retention is added, purge in
  small transactions, never remove pending work, and expose policy/status clearly.
- Replace the inline partial OpenAPI object with a validated complete document and
  add CI for formatting, type checking, unit tests, migrations, integration tests,
  and the Docker smoke test.

## Local Docker testing

Use three layers rather than relying on manual clicks alone:

1. Run `npm test`, `npm run typecheck`, and `npm run format:check` on Node 22 for
   fast state-machine, migration, and fake-clock coverage.
2. Run `npm run test:integration` for deterministic transport contract tests
   against the existing local mock HTTP service.
3. Run a real pinned Signal K server with the plugin installed and a persistent
   data volume for API/UI/restart scenarios.

The repository already provides `Dockerfile`, `docker-compose.live.yml`, and
`docker-compose.integration.yml`, but the live setup should be hardened before it
is the acceptance environment:

- pin the Signal K image version for reproducibility and test `latest` separately
  in CI as a compatibility signal;
- add a `.dockerignore` that excludes `data`, `node_modules`, `.git`, coverage, and
  other local output. The current bind-mounted `data` tree can otherwise be copied
  into the plugin image and recursively copied back into its own installation;
- use a named volume or a dedicated ignored directory for `/home/node/.signalk`;
- add container health checks and wait for readiness instead of fixed sleeps;
- install a test-only fixture plugin in the Compose profile. It should publish
  zone metadata and timestamped notification deltas with controlled sources,
  expose a fake Signal K PUT switch, and provide raise/update/clear operations;
- extend the mock notifier to return scripted success, retryable failure, terminal
  failure, timeout, and captured request history;
- run API assertions and Playwright browser tests from separate containers so the
  same suite works on developer machines and CI.

The Docker acceptance suite should raise two sources on one path, exercise a
never-fired zone definition, dismiss and re-raise a one-time occurrence, inspect
per-alert history, edit notifier/delay policy, clear both before and after the
activation deadline, fail one notifier while two succeed, restart Signal K during
pending activation and retry, and verify SQLite state plus connectivity ownership
after recovery. No test should contact real ntfy, PagerDuty, Discord, or boat
hardware.

## Runtime

The plugin uses the built-in `node:sqlite` API and requires Node.js 22.5 or newer. Install with `npm install`, compile with `npm run build`, and install the package through Signal K's normal plugin mechanism.

Startup subscribes to notification deltas before reconciling the existing Signal K
model. The model scan runs after plugin startup returns, processes notifications in
bounded batches, and schedules pending delivery once after reconciliation. Runtime
status, history pages, definition summaries, and the delivery scheduler use bounded
SQL queries so their cost does not grow with unrelated historical records. Unchanged
zone definitions do not rewrite the database during periodic discovery.

## Configuration

```json
{
  "notifiers": [
    {
      "name": "Crew ntfy",
      "type": "ntfy",
      "server": "https://ntfy.sh",
      "topic": "boat-alerts",
      "token": "secret",
      "minSeverity": "warn"
    },
    {
      "name": "Emergency PagerDuty",
      "type": "pagerduty",
      "routingKey": "secret",
      "minSeverity": "alarm"
    },
    {
      "name": "Boat Discord",
      "type": "discord",
      "webhookUrl": "https://discord.com/api/webhooks/...",
      "minSeverity": "alert"
    }
  ],
  "defaults": {
    "enabled": true,
    "minSeverity": "warn",
    "activationDelaySeconds": 0,
    "connectivity": { "mode": "queue" },
    "notifiers": ["Crew ntfy"]
  },
  "connectivity": {
    "enabled": true,
    "switch": {
      "path": "electrical.switches.starlink.state",
      "onValue": 1,
      "offValue": 0
    },
    "idleCooldownSeconds": 300,
    "bootTimeoutSeconds": 240,
    "internetCheckIntervalSeconds": 5,
    "probe": {
      "url": "https://www.gstatic.com/generate_204",
      "timeoutSeconds": 10
    }
  }
}
```

By default, the database is `persistent-notifier.sqlite` inside Signal K's data
directory, so the configuration works across native and container installations.
When `storage.path` is relative, it is resolved from that data directory. An absolute
path remains supported when you intentionally manage the database elsewhere.

The Signal K plugin form contains only global configuration: storage/discovery,
retry behavior, notifier connections and secrets, global defaults, and optional
connectivity management. It also contains a destructive, one-shot database reset
under **Database maintenance**. Enable **Reset database when Save Configuration is
clicked**, then click Signal K's **Save Configuration** button. The plugin deletes
all alert definitions, occurrences, event and delivery history, and per-alert policy;
re-initializes the schema; discovers current Signal K definitions again; and
automatically turns the reset control back off. Global plugin configuration,
including notification service secrets, is retained.

Database maintenance appears last in the plugin settings. Each notification
service has one service-type selector; its stored type field is hidden.

Per-alert notifier selection, minimum severity, activation delay, repeat interval,
and connectivity policy are stored from the Alert center's **Settings** dialog. A
notifier's global `minSeverity` is a hard floor; an alert-level override cannot make
that notifier send at a lower severity.

Each entry under **Notification services** has a unique, human-readable `name`. That
name appears in the per-alert Settings dialog and is used by the default alert policy.
Renaming a service does not rewrite saved alert policies, so reselect the renamed
service on affected alerts. The Signal K form presents separate ntfy, PagerDuty, and
Discord entry types and only asks for credentials relevant to that service.

Repeated updates coalesce by notification path and available source identifier. Clear events retain the original occurrence and maximum severity. Each notifier retries independently; a successful notifier is never resent because another notifier failed. `wake_after` requests are persisted per alert and restored after restart. Connectivity is only switched off when the plugin observed it off before waking it and owns the session. Unknown ownership leaves it on.

The plugin API is mounted by Signal K under `/plugins/signalk-persistent-notifier`:

- `GET /status`
- `GET /alerts`
- `GET /deliveries`
- `POST /retry`
- `GET /definitions` and `GET /definitions/:id`
- `PATCH /definitions/:id/policy`
- `DELETE /definitions/:id` for inactive discovered paths
- `GET /notifiers`
- `GET /occurrences` and `GET /occurrences/:id`
- `GET /occurrences/:id/events`
- `POST /occurrences/:id/dismiss`
- `POST /occurrences/:id/acknowledge`
- `POST /occurrences/:id/silence`

Signal K protects these routes with its normal authentication. Read endpoints use
read-only access and mutations require read-write access. Collection endpoints use
bounded cursor pagination and validated filters. The complete request and response
contract is returned through the plugin's OpenAPI document.

The dashboard is served at `/signalk-persistent-notifier`. One compact table puts
all known definitions together with active alerts first. Select an alert to open
its current information and recent event timeline; alert actions and **Settings** are
available there as well as directly from the row. Acknowledge and silence apply only
to active occurrences. **Include dismissed** updates the table immediately. Inactive
discovered definitions can be permanently forgotten from Settings; active alerts and
Signal K zone definitions cannot be forgotten.

The default **All alerts and zones** view includes inactive alerts and zone
definitions that have never fired. Active alerts appear first, highest severity
first. **Active alerts only** is an optional filter. **No alert recorded** means
there is no recorded notification; it does not claim the sensor is currently normal.
Search matches alert names, paths, sources, and loaded messages.
Source names are shown in alert details, not in the table.
Zone definitions share the Alerts table; their threshold ranges appear in the
detail drawer when you open an alert. Notification services and delivery timing
are shown in plain language beside each alert, with **Settings** for changes.
The dashboard receives lightweight server-sent change events and reloads data only
after alerts, policies, definitions, or deliveries change. Browsers automatically
reconnect the same-origin stream; while it is unavailable, the UI uses a slow
60-second fallback poll.

Policy edits apply to future occurrences. The occurrence snapshots the effective
one-time, severity, activation, rearm, connectivity, and notifier policy so a later
settings edit cannot rewrite history or silently retarget pending work.

When connectivity is enabled, the plugin sends an HTTP `HEAD` request to the
configured probe URL and enters `ONLINE` after any 2xx response. The default is
Google's lightweight public `https://www.gstatic.com/generate_204` endpoint, which
returns HTTP 204 without authentication. The plugin retries until
`bootTimeoutSeconds` and enters `FAULT` without deleting queued alerts if readiness
never arrives.

Docker-backed HTTP integration tests are available with
`npm run test:integration`. They start a local scripted HTTP service and exercise
ntfy, PagerDuty, and Discord without contacting external services.

For a real Signal K acceptance run:

```sh
npm run test:acceptance
docker compose -f docker-compose.acceptance.yml down -v
```

This builds against the pinned Signal K 2.31.1 image, installs a test-only fixture
plugin, publishes zone metadata and timestamped raise/clear deltas, changes a
definition policy, checks recent history, dismisses a one-time occurrence, and
verifies that a later raise creates a new visible occurrence. The separate mock
service also verifies scripted retry responses and captured request bodies.

For interactive UI testing:

```sh
docker compose -f docker-compose.live.yml up --build
```

Open `http://localhost:3000`, complete Signal K setup if prompted, enable/configure
the plugin, then open `http://localhost:3000/signalk-persistent-notifier`. The live
Compose file uses a named volume. Remove it only when you intentionally want a
fresh development database:

```sh
docker compose -f docker-compose.live.yml down -v
```

To start the same local server with a test-only fixture plugin and populate it
with realistic demo alerts, run:

```sh
npm run demo
```

The fixture publishes active refrigerator, bilge, battery, engine, anchor, and
security alerts, plus cleared and recurring occurrences and two independent
sources on the same bilge path. It never contacts external services or vessel
hardware. Open the alert dashboard after a few seconds to browse the generated
definitions and history.

You can add another batch while the demo fixture is installed with:

```sh
curl -X POST http://localhost:3000/plugins/signalk-test-fixture/seed
```

If Signal K security is enabled, invoke that endpoint from an authenticated client
or simply rerun `npm run demo`, which seeds automatically on fixture startup.

## Development

`npm test` runs the lifecycle, persistence, API, policy, runtime, scheduler, and
connectivity tests. `npm run format:check`, `npm run lint`, and `npm run build` are
the required quality checks. Node 22.5 or newer is required; Docker acceptance is
pinned to Signal K server 2.31.1.
