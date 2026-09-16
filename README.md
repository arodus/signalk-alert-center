# Signal K Alert Center

An offline-first Signal K plugin for durable alert delivery through ntfy,
PagerDuty, and Discord. Alerts and independent per-notifier delivery rows are
stored in SQLite before external work begins.

## Alert center

This project provides a persistent onboard notification center inspired by
[Signal K Notification Player](https://github.com/davidsanner/signalk-notification-player),
with one alert list, retained event history, and offline remote delivery. It discovers
Signal K `meta.zones` and incoming notification paths, including definitions that
have never fired. Every raise/clear cycle
is stored as a distinct occurrence, while duplicate updates within the cycle are
coalesced. Clicking an occurrence opens its durable event and notifier history.
PagerDuty trigger, acknowledge, and resolve operations are stored separately.
A Signal K acknowledgement is forwarded after PagerDuty accepts the matching
trigger. A Signal K `normal`, `nominal`, `cleared`, or null transition queues a resolve only after
PagerDuty has accepted the matching occurrence trigger; all three operations'
retries and attempt histories remain independent.

One-time behavior is snapshotted when an occurrence starts. Every occurrence
remains available in history, and a later raise creates a distinct occurrence.
Per-definition settings cover enabled state, minimum severity, notifiers,
activation delay, repeat intervals, and connectivity mode.

Local playback is intentionally outside this plugin. The former playback
implementation is preserved on the `archive/local-playback` branch.

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

| Area            | Implemented behavior                                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definitions     | Discovered Signal K zones and notification paths are durable and visible before they fire.                                                                                                                                                                        |
| Ingestion       | An all-source subscription feeds one bounded worker. Equivalent pending updates coalesce, transitions stay ordered, and queue pressure is observable. `$source`, source time, receipt time, and raw values are persisted. Null/normal values clear an occurrence. |
| Identity        | Definitions, recurring occurrences, immutable events, notifier intents, and delivery attempts use separate tables.                                                                                                                                                |
| Stored removal  | Removing an inactive stored alert deletes its definition, per-alert settings, occurrences, history, deliveries, and related queued work. Signal K can rediscover it using current defaults.                                                                       |
| Policy          | Durable per-definition overrides are edited in the dashboard and snapshotted onto new occurrences.                                                                                                                                                                |
| Delay and retry | Activation and retry deadlines are persisted, recovered after restart, and driven by timers derived from the database.                                                                                                                                            |
| PagerDuty       | Each occurrence's trigger, acknowledgement, and resolve use the same stable dedup key. Signal K acknowledgements and clear/normal transitions are forwarded as distinct durable operations after PagerDuty accepts the trigger.                                   |
| API/UI security | Reads use read-only access, mutations use read-write access, browser requests include the Signal K session, and OpenAPI describes the complete surface.                                                                                                           |

[Signal K Notification Player](https://github.com/davidsanner/signalk-notification-player)
is a useful product reference: it discovers known/configured notifications, opens
per-path recent history, and persists zone transitions. Its synchronous JSON log,
large untyped single module, and mutable GET endpoints should not be copied. This
plugin's SQLite occurrence/event model and authenticated REST mutations are the
better base for durable remote delivery.

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
expiry or suppression, clear, acknowledge, silence, policy actions,
and every notifier attempt/outcome. History uses cursor-based pagination and filters
for state and severity.

The settings dialog provides **Remove stored alert** for inactive alerts. This is
a destructive definition-level action: it deletes the alert's per-alert settings,
all occurrences and events, delivery attempts, and related queued work.
It never clears the upstream Signal K alert, so active alerts must be cleared at
their source first. A zone or notification path still present in Signal K will be
discovered again and will inherit the current global defaults.

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
  one idempotent ingest path. Keep the live side bounded and ensure its latest
  updates are applied after the older snapshot without retaining one task per delta.
- Wire zone discovery into the catalog and refresh it when metadata changes or on
  an explicit low-frequency rescan. Treat zones as definitions only.

### 2. Occurrence-based schema — implemented

Create a clean schema, recording its version for future migrations, with:

- `alert_definitions`: zone/discovered identity and display metadata;
- `alert_policies` plus a normalized definition-to-notifier mapping;
- `alert_occurrences`: immutable occurrence identity, source/path, lifecycle,
  source/receipt times, current and maximum severity, and clear time;
- `alert_events`: immutable snapshots for meaningful lifecycle/operator changes;
- `delivery_intents` and `delivery_attempts`: per-occurrence, per-notifier desired
  work and append-only results;
- persisted activation and connectivity deadlines.

Do not add migration code for the discarded prototype schema. Development databases
created by earlier commits should be deleted and recreated. Add indexes for
current-list lookup and stable, cursor-based history order (`occurred_at`, unique
id); future released schema changes must use transactional migrations.

### 3. Recurrence and delay state machines — implemented

- Start an occurrence on inactive-to-active transition; coalesce identical updates
  while active; close it on null/normal; start a new occurrence on the next raise.
- For sources that never send clear, support explicit producer identity when
  present and a documented configurable rearm policy. Do not guess a new event from
  repeated identical deltas.
- Persist `activation_due_at`. Promote still-active occurrences to notifier intents
  at the deadline; otherwise record suppression. Recover overdue deadlines on
  restart before running the delivery scheduler.
- Keep local stored-alert deletion distinct from acknowledge, silence, and
  upstream clear, and reject deletion while any occurrence is active.

### 4. Policy and history APIs — implemented

Provide at least:

```text
GET   /definitions
GET   /definitions/:id
PATCH /definitions/:id/policy
DELETE /definitions/:id/policy
DELETE /definitions/:id
GET   /occurrences
GET   /occurrences/:id
GET   /occurrences/:id/events
POST  /occurrences/:id/acknowledge
POST  /occurrences/:id/silence
```

Keep the existing status/delivery/retry endpoints during migration. Use cursors,
bounded limits, filter validation, stable ordering, and structured error bodies.
Expose effective policy, the current global defaults, overridden field names,
and provenance (`default`, `partial`, or `override`). Register
read routes as read-only and mutations as read-write/admin using the supported
Signal K router API, and publish the complete contract through `getOpenApi()`.

### 5. Definitions and occurrences dashboard — implemented

- Render active and known definitions in one compact alert table.
- Add an accessible detail drawer opened by click and keyboard, with paginated
  recent history and notifier outcomes.
- Add a policy editor populated from configured notification services, with validation
  and an explicit save result. Each setting remains linked to its global default
  until the operator marks that field as custom. An explicitly custom empty
  notification-service list means “send to no remote services”; it is different
  from inheriting the global list. **Use global defaults** removes only the alert's
  overrides and retains its definition, occurrences, and history.
- Add global history filters, pagination, empty/loading/
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
never-fired zone definition, re-raise a one-time occurrence, inspect
per-alert history, edit notifier/delay policy, clear both before and after the
activation deadline, fail one notifier while two succeed, restart Signal K during
pending activation and retry, and verify SQLite state plus connectivity ownership
after recovery. No test should contact real ntfy, PagerDuty, Discord, or boat
hardware.

## Runtime

The plugin uses the built-in `node:sqlite` API and requires Node.js 22.5 or newer.
Signal K 2.31.1 is the pinned supported server target; CI also tests the current
Signal K release as an early compatibility signal.

Stable releases are installed through the Signal K App Store from npm. Every
published version has a matching annotated source tag and GitHub Release containing
the exact npm tarball and SHA-256 checksum. A downloaded release tarball can be
installed without resolving the package from npm:

```sh
npm install --prefix ~/.signalk ./signalk-alert-center-X.Y.Z.tgz
```

The first publication will use the `signalk-alert-center` package name. Do not
install directly from a moving Git branch. Maintainer release policy, validation,
rollback, and database-backup requirements are in
[`docs/RELEASING.md`](docs/RELEASING.md).

For development, install dependencies with `npm install` and compile with
`npm run build`.

Startup subscribes to notification deltas before reconciling the existing Signal K
model. Live updates received during that scan enter a fixed-size queue. Equivalent
pending values for the same path and source are combined, while state, severity, and
message transitions keep their order. One worker persists bounded batches and yields
between them, so continuous traffic cannot create one retained promise per delta or
prevent startup reconciliation from completing. Queue depth, its high-water mark,
and received, processed, coalesced, and rejected counts are available from `/status`.
Reaching the hard limit is logged as an error because it can mean alert transitions
were rejected; the plugin never silently grows the queue beyond the configured size.

Runtime status, history pages, definition summaries, recent dashboard deliveries,
and the delivery scheduler use bounded SQL queries so their cost does not grow with
unrelated historical records. Unchanged zone definitions do not rewrite the database
during periodic discovery.

The delivery scheduler loads at most 50 due deliveries per run and sends up to four
at the same time by default. Each service request has a 15-second deadline. These
limits are global settings under **Notification delivery**. Every row is claimed and
committed before its network request starts, and each result is recorded independently,
so a slow or failed service does not hold up successful services. A timeout is recorded
as a retryable `DELIVERY_TIMEOUT`. Plugin shutdown stops claiming work, aborts active
requests, records them as retryable interruptions, and then closes the database.

Operational errors and delivery batches are written to Signal K's server log
without notification bodies, notifier credentials, tokens, or webhook URLs. Enable
the plugin's debug namespace on Signal K's **Server Log** page to see startup,
reconciliation, policy/action, successful-delivery, and shutdown diagnostics.

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
  "delivery": {
    "batchSize": 50,
    "concurrency": 4,
    "requestTimeoutSeconds": 15
  },
  "ingestion": {
    "queueLimit": 2000,
    "batchSize": 100
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
The database filename intentionally keeps its old name so an upgrade retains all
definitions, per-alert settings, occurrences, and delivery history without copying
or rewriting SQLite data.

### Migrating a development installation from the old name

The rename changes the npm package, Signal K plugin id, settings filename,
dashboard URL, and API URL. Stop Signal K before migrating. Install the new package,
move the saved settings with the included guarded command, remove the old package,
and then restart Signal K:

```sh
npm install --prefix ~/.signalk ./signalk-alert-center-X.Y.Z.tgz
~/.signalk/node_modules/.bin/signalk-alert-center-migrate --data-dir ~/.signalk
npm uninstall --prefix ~/.signalk signalk-persistent-notifier
```

The migration command moves
`plugin-config-data/signalk-persistent-notifier.json` to
`plugin-config-data/signalk-alert-center.json` without reading or printing its
notification-service secrets. It refuses to overwrite anything when both files
exist. The configured database path is not changed, so stored alert data and
per-alert policy remain in place. After restart, use `/signalk-alert-center` rather
than the former dashboard URL.

The provided Docker entrypoint performs the same settings-file move automatically
inside an existing named volume before Signal K starts. It retains
`persistent-notifier.sqlite`. Back up the Signal K data directory before any manual
upgrade; if migration must be reversed, stop Signal K and move the configuration
file back to its former name before reinstalling the old development package.

The Signal K plugin form contains only global configuration: storage/discovery,
bounded ingestion and delivery limits, retry behavior, notifier connections and
secrets, and optional connectivity management. Optional **History retention** removes only
cleared occurrences older than the configured age, in bounded batches. It is
disabled by default and always protects active alerts, pending/retryable/in-flight
deliveries, and persisted wake requests. Retention status and the most recent
cleanup counts are available from `/status`.

The form also contains a destructive, one-shot database reset
under **Database maintenance**. Enable **Reset database when Save Configuration is
clicked**, then click Signal K's **Save Configuration** button. The plugin deletes
all alert definitions, occurrences, event and delivery history, and per-alert policy;
re-initializes the schema; discovers current Signal K definitions again; and
automatically turns the reset control back off. Global plugin configuration,
including notification service secrets, is retained.

Database maintenance appears last in the plugin settings. Each notification
service has one **Service type** selector. Changing it immediately replaces the
connection fields with those required by ntfy, PagerDuty, or Discord.

Per-alert notifier selection, minimum severity, activation delay, repeat interval,
and connectivity policy are stored from the Alert center's
**Settings** dialog. A
notifier's global `minSeverity` is a hard floor; an alert-level override cannot make
that notifier send at a lower severity.

Each entry under **Notification services** has a unique, human-readable `name`. That
name appears in the per-alert Settings dialog and is used by the default alert policy.
Renaming a service does not rewrite saved alert policies, so reselect the renamed
service on affected alerts. The Signal K form only asks for credentials relevant to
the selected service type.

Repeated updates coalesce by notification path and available source identifier. Clear events retain the original occurrence and maximum severity. Each notifier retries independently; a successful notifier is never resent because another notifier failed. `wake_after` requests are persisted per alert and restored after restart. Connectivity is only switched off when the plugin observed it off before waking it and owns the session. Unknown ownership leaves it on.

The plugin API is mounted by Signal K under `/plugins/signalk-alert-center`:

- `GET /status`
- `GET /alerts`
- `GET /deliveries`
- `POST /retry`
- `GET /definitions` and `GET /definitions/:id`
- `PATCH /definitions/:id/policy`
- `DELETE /definitions/:id/policy` to remove per-alert overrides
- `DELETE /definitions/:id` to remove an inactive stored alert, its settings, and history
- `GET /notifiers`
- `POST /notifiers/:id/test` to test one saved notification service
- `GET /occurrences` and `GET /occurrences/:id`
- `GET /occurrences/:id/events`
- `GET /alert-history` for the global alert-update feed
- `POST /occurrences/:id/acknowledge`
- `POST /occurrences/:id/silence`

Signal K protects these routes with its normal authentication. Read endpoints use
read-only access and mutations require read-write access. Collection endpoints use
bounded cursor pagination and validated filters. The complete request and response
contract is returned through the plugin's OpenAPI document.

Global defaults are resolved when a new alert occurrence is created. Untouched
and partially customized alerts therefore pick up later global changes for every
field they still inherit. Each occurrence stores the resulting effective policy
as a snapshot, so changing a global default or alert override does not alter
deliveries already in progress.

### Operational diagnostics

`GET /status` returns a bounded operational snapshot without notifier secrets or
notification payloads. It includes runtime generation and listener counts; ingestion
queue depth, limit, high-water mark, and totals; startup reconciliation state and duration;
the last delivery scheduler run; active request count and oldest request; the oldest pending
delivery, overdue activation count, database/schema health, pending connectivity wake work, switch ownership,
the last connectivity transition and probe result, and per-service pending count
plus last success/failure time and failure code. The dashboard exposes the same
information under **System diagnostics** at the bottom of the Alert center. The
section is collapsed by default so current alerts and delivery work remain the
primary workflow, while Signal K's compact plugin status shows the overall health
and active/pending counts.

Health is **healthy** when the schema is current, startup reconciliation has
completed, connectivity is not faulted, activations are not overdue, and no
service's newest outcome is a failure. It is **degraded** while reconciliation is
running, when activations are overdue, after a delivery scheduler error, or when a service's
latest outcome is a failure. It is **fault** when the database/schema check fails,
startup reconciliation fails, or connectivity enters `FAULT`. A later successful
service delivery clears that service's degraded condition.

Diagnostic queries use aggregate/indexed lookups and one latest-failure lookup per
service with recorded deliveries; they do not load or reconstruct complete alert
history.

### Resource-exhaustion troubleshooting

Rapidly increasing Signal K memory, heap-limit restarts, a queue at its configured
limit, or an old active delivery request indicate that input or a notification service
is not keeping up. Disable this plugin on the affected server and restart Signal K to
release retained process memory. Preserve the database and logs; deleting the database
is not required. Before re-enabling it, verify the configured ntfy, PagerDuty, and
Discord endpoints are reachable and review `/status` for ingestion and scheduler
diagnostics. Do not increase the queue or request timeout as a first response because
that permits more work to remain resident.

`GET /occurrences` accepts exact `definitionId`, `path`, and `source` filters,
plus `state`, `severity`, `from`, and `to`. Filters can be combined;
cursor ordering remains stable by occurrence start time and id.

The dashboard is served at `/signalk-alert-center`. The default **Alerts**
tab uses one compact table for all known definitions, with active alerts first. Select an alert to open
its current information, five most recent occurrences, selected occurrence timeline, and **Settings**. Acknowledge and
Silence are available directly in active rows, with completed actions shown disabled.
Inactive rows use a neutral status badge. Acknowledge and silence apply only
to active occurrences. Any inactive stored alert can be permanently removed from
Settings together with its configuration and complete history. Active alerts must
be cleared in Signal K first. Definitions still supplied by Signal K are discovered again.

The default **All alerts and zones** view includes inactive alerts and zone
definitions that have never fired. Active alerts appear first, highest severity
first. **Active alerts only** is an optional filter. **Inactive** means there is
no displayed active notification; it does not claim the sensor is currently normal.
Search matches alert names, paths, sources, and loaded messages.
Source names are shown in alert details, not in the table.
Use **More filters** for an exact Signal K path or source and a started-at time
range. These filters are evaluated by the server and work with **Load more**.
The separate **Alert history** tab is a newest-first feed of alert lifecycle
updates across all occurrences. It can be filtered by alert, update type,
severity, state, source, and time range. It intentionally contains no notifier
delivery attempts or outcomes; those remain in **Deliveries**.
Zone definitions share the Alerts table; their threshold ranges appear in the
detail drawer when you open an alert. Notification services and delivery timing
are shown in plain language beside each alert. Open the alert and select **Settings**
to change them.

Expand **System diagnostics** and use **Test notification services** to verify an
enabled service with its currently saved plugin settings. Tests run immediately
when requested, including during any quiet period, and use the configured delivery
request timeout with a 30-second maximum. A second test for the same service is
rejected while the first is running. Results distinguish credential, configuration,
timeout, network, and remote-service failures without returning or logging tokens,
webhook addresses, routing keys, or remote response bodies.

ntfy and Discord receive an unmistakably marked manual test notification.
PagerDuty's **Test alert** sends a real warning trigger and therefore opens or
updates a clearly marked test incident. **Test resolve** is a separate action that
uses the same stable test deduplication key to resolve that test incident. Service
tests bypass the alert pipeline: they do not create alert occurrences, delivery
rows, retries, connectivity wake requests, acknowledgements, or Alert center
history. The generated Signal K settings form cannot expose actions for unsaved
array entries, so save service changes before testing them from the Alert center.

The separate **Deliveries** tab keeps transport troubleshooting out of the alert
workflow. Unfinished work appears first, followed by recent completed and terminal
results. Each row identifies the alert occurrence and notification service, current
state, attempt count, relevant timestamps, and latest error. Opening a row shows
the remote delivery ID and cursor-paged chronological attempt history. Failed rows
can be retried individually; **Retry all failed deliveries** retries every failed
intent. Delivery pages and attempt pages are bounded to 100 records per request.
The dashboard receives lightweight server-sent change events and reloads data only
after alerts, policies, definitions, or deliveries change. Browsers automatically
reconnect the same-origin stream; while it is unavailable, the UI uses a slow
60-second fallback poll.

Policy edits apply to future occurrences. Each occurrence snapshots its effective
one-time, severity, activation, rearm, connectivity, and notifier policy into
durable delivery work, so a later settings edit cannot rewrite history or silently
retarget pending work.

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
definition policy, checks recent history, removes an inactive stored alert, and
verifies recurrence behavior. The separate mock
service also verifies scripted retry responses and captured request bodies.

Install Chromium once with `npx playwright install chromium`, then run
`npm run test:browser` for desktop and tablet dashboard coverage. The command
starts an isolated Docker project and removes its named test volume afterward.
`npm run test:restart` separately verifies that pending activation, retryable
delivery work, occurrence history, and event history survive Signal K restarts.
Both suites use only the local fixture and mock notifier.

For interactive UI testing:

```sh
docker compose -f docker-compose.live.yml up --build
```

Open `http://localhost:3000`, complete Signal K setup if prompted, enable/configure
the plugin, then open `http://localhost:3000/signalk-alert-center`. The live
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
pinned to Signal K server 2.31.1. GitHub Actions runs those checks on pull requests,
including browser and restart coverage; a non-blocking job also exercises the latest
Signal K image. CI caches only npm downloads. Docker volumes, databases, browser
traces, and test configuration are ephemeral and are not persisted as artifacts.
