# Signal K Persistent Notifier

An offline-first Signal K plugin for durable alert delivery through ntfy, PagerDuty, and Discord. Alerts and independent per-notifier delivery rows are stored in SQLite before any network or switch operation.

## Product goal and current limitations

The goal is a persistent onboard notification center inspired by
[Signal K Notification Player](https://github.com/davidsanner/signalk-notification-player),
with a notification list, retained one-time events, and full chronological history,
in addition to offline remote delivery. A one-time event must stay visible until
explicit dismissal and remain in history afterward, even if it never receives a
clear update. A later occurrence must be visible again.

**This goal is not fully implemented.** The current History tab only filters the
latest catalog state for cleared alerts. It does not expose the stored event log
or dismissed alerts. Rule summaries can hide individual matching notifications;
one-time dismissal can also hide later occurrences. Event/action and delivery
attempt history are incomplete. Zone discovery is not wired into the plugin, and
there is no local sound/TTS playback engine. Playback ownership remains open.

See the [gap assessment and acceptance scenarios](IMPLEMENTATION_BRIEF.md#product-goal-and-gap-assessment-2026-09-06)
for verified source findings, required behavior, and unresolved scope decisions.

## Signal K and Notification Player review

The target architecture follows Signal K's separation between definitions and
events: `meta.zones` define alarm thresholds on ordinary vessel paths, while the
server raises values below `notifications.*` and clears them with a null delta.
The plugin must subscribe to those notification deltas and also reconcile the
current notification subtree at startup. Delta `$source` and timestamp are part of
occurrence identity and audit data, not optional display details.

The current code has a sound durability foundation—SQLite, transactional alert and
delivery creation, independent per-notifier state, persisted retry deadlines, and
conservative connectivity ownership—but is not yet a complete Signal K notification
center:

| Area               | Current state                                                                                                                                                      | Required direction                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Definitions        | Configured rules are listed; zone walking exists but is not connected to startup or the catalog.                                                                   | List every rule and every `meta.zones` definition, including never-fired definitions, without fabricating occurrences.                       |
| Ingestion          | Subscribes to `notifications.*` and retains `$source`; it does not reconcile existing values or retain source timestamps, and null currently normalizes as active. | Subscribe plus idempotent startup snapshot; treat null as clear and retain raw state, source, and both source/receipt times.                 |
| Identity           | One mutable alert row is keyed by path/source.                                                                                                                     | Separate definitions, sources, occurrences, events, delivery intents, and attempts so recurrence cannot overwrite history.                   |
| One-time alerts    | A rule flag allows soft removal, but the removed row disappears from every view and suppresses later activity on the same row.                                     | Dismiss only the selected occurrence from the main list; retain it in history and allow a later occurrence to appear.                        |
| History            | The History tab filters the latest catalog rows to `cleared`.                                                                                                      | Query a durable event timeline globally and per definition/occurrence, including dismissed items and delivery outcomes.                      |
| Per-alert policy   | Notifier fan-out and timing are only configured in rules.                                                                                                          | Provide a UI/API for per-definition overrides, including notifier selection and durable activation delay.                                    |
| Controls           | Local acknowledge/silence timestamps are written before an optional upstream call.                                                                                 | Check Signal K capability flags, report the actual upstream result, and audit local and upstream outcomes separately.                        |
| API/UI security    | Plugin routes use the default admin-only router and browser requests do not explicitly include session credentials.                                                | Use least-privilege read/write route access, cookie-backed requests, clear login handling, and complete OpenAPI schemas.                     |
| Plugin conventions | The package has discovery keywords and a mounted `public/` app, but the server surface is largely typed as `any`.                                                  | Use `@signalk/server-api` types and verify lifecycle, schema, subscription, and router behavior against a declared supported server version. |

[Signal K Notification Player](https://github.com/davidsanner/signalk-notification-player)
is a useful product reference: it discovers known/configured notifications, opens
per-path recent history, persists zone transitions even when audio is disabled,
and supports per-path playback controls. Its synchronous JSON log, large untyped
single module, mutable GET endpoints, and playback-specific queue should not be
copied. This plugin's SQLite occurrence/event model and authenticated REST
mutations are the better base for durable remote delivery.

## Target dashboard behavior

The main view should contain two related but distinct lists:

1. **Alert definitions**: every configured rule and discovered Signal K zone,
   including disabled and never-fired definitions. A definition shows its path or
   selector, zone thresholds, effective policy, current occurrence count, and last
   fired time.
2. **Occurrences requiring attention**: active occurrences and retained one-time
   occurrences. Multiple paths or sources matched by one rule remain individually
   inspectable.

Clicking either a definition or occurrence opens a detail drawer with recent
history. The timeline includes raised, message/severity changes, activation-delay
expiry or suppression, clear, acknowledge, silence, dismissal, policy actions,
and every notifier attempt/outcome. A separate History view provides cursor-based
pagination and filters for time, definition, path, source, state, severity,
dismissal, and notifier.

For a one-time occurrence the UI may present a **Delete** action, but this is a
soft dismissal: it disappears from the attention list, remains in history, and
does not cancel pending notifier delivery. A later occurrence on the same path and
source is a new row and becomes visible normally.

The definition settings panel controls enabled state, notifier instances, minimum
severity, connectivity mode, one-time/rearm behavior, and
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

## Implementation plan

Implement the missing functionality in the following order. Each phase should
include a schema/API contract, migration coverage, restart tests, and UI acceptance
tests before the next phase starts.

### 1. Characterize and stabilize the Signal K boundary

- Add `@signalk/server-api` types and declare the supported Signal K server range.
- Correct null/normal clear handling, preserve unknown raw values, and capture
  delta timestamp plus `$source`.
- Subscribe before taking a startup snapshot, then reconcile both streams through
  one idempotent ingest path so an event arriving during startup is neither lost
  nor duplicated.
- Wire zone discovery into the catalog and refresh it when metadata changes or on
  an explicit low-frequency rescan. Treat zones as definitions only.

### 2. Introduce an occurrence-based schema

Add versioned, transactional migrations and split the current rows into:

- `alert_definitions`: rule/zone/discovered identity and display metadata;
- `alert_policies` plus a normalized definition-to-notifier mapping;
- `alert_occurrences`: immutable occurrence identity, source/path, lifecycle,
  source/receipt times, current and maximum severity, dismissal, and clear time;
- `alert_events`: immutable snapshots for meaningful lifecycle/operator changes;
- `delivery_intents` and `delivery_attempts`: per-occurrence, per-notifier desired
  work and append-only results;
- persisted activation and connectivity deadlines.

Migrate existing alert, event, and delivery rows without inventing recurrence
boundaries that cannot be proven. Mark migrated records accordingly and keep a
backup/rollback path. Add indexes for current-list lookup and stable, cursor-based
history order (`occurred_at`, unique id).

### 3. Define recurrence, dismissal, and delay state machines

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

### 4. Add policy and history APIs

Provide at least:

```text
GET   /definitions
GET   /definitions/:id
PATCH /definitions/:id/policy
GET   /occurrences
GET   /occurrences/:id
GET   /occurrences/:id/events
POST  /occurrences/:id/dismiss
POST  /occurrences/:id/acknowledge
POST  /occurrences/:id/silence
```

Keep the existing status/delivery/retry endpoints during migration. Use cursors,
bounded limits, filter validation, stable ordering, and structured error bodies.
Expose effective policy and provenance (`override`, `rule`, or `default`). Register
read routes as read-only and mutations as read-write/admin using the supported
Signal K router API, and publish the complete contract through `getOpenApi()`.

### 5. Rebuild the dashboard around definitions and occurrences

- Render all zone/rule definitions and a separate attention list.
- Add an accessible detail drawer opened by click and keyboard, with paginated
  recent history and notifier outcomes.
- Add a policy editor populated from configured notifier instances, with validation
  and an explicit save result.
- Add global history filters, pagination, dismissed-state visibility, empty/loading/
  auth/error states, and responsive layouts suitable for an onboard tablet.
- Use `credentials: "include"`; redirect or link to Signal K login on 401/403.

### 6. Integrate delivery without weakening durability

- Create delivery intents only after activation eligibility and snapshot the
  effective policy onto the occurrence so later edits do not rewrite history.
- Keep every notifier independent, append every attempt, and preserve PagerDuty
  dedup identity per occurrence. Add resolve delivery where the transport supports
  it without overwriting the trigger result.
- Keep connectivity requests downstream of eligible delivery. Re-evaluate
  `wake_after` cancellation and shutdown protection against occurrence-based work.

### 7. Finish compatibility, observability, and retention

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

## Configuration

```json
{
  "storage": { "path": "/var/lib/signalk/persistent-notifier/alerts.sqlite" },
  "notifiers": {
    "ntfy-main": {
      "type": "ntfy",
      "server": "https://ntfy.sh",
      "topic": "boat-alerts",
      "token": "secret"
    },
    "pagerduty-critical": { "type": "pagerduty", "routingKey": "secret" },
    "discord-boat": {
      "type": "discord",
      "webhookUrl": "https://discord.com/api/webhooks/..."
    }
  },
  "rules": [
    {
      "id": "bilge-high-water",
      "name": "Bilge high water",
      "zone": "Bilge",
      "oneTime": false,
      "enabled": true,
      "match": "notifications.bilge.*",
      "minSeverity": "alarm",
      "connectivity": { "mode": "wake" },
      "notifiers": ["ntfy-main", "pagerduty-critical", "discord-boat"]
    }
  ],
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
    "probe": { "url": "https://example.com/generate_204", "timeoutSeconds": 10 }
  }
}
```

Repeated updates coalesce by notification path and available source identifier. Clear events retain the original occurrence and maximum severity. Each notifier retries independently; a successful notifier is never resent because another notifier failed. `wake_after` requests are persisted per alert and restored after restart. Connectivity is only switched off when the plugin observed it off before waking it and owns the session. Unknown ownership leaves it on.

The plugin API is mounted by Signal K under `/plugins/signalk-persistent-notifier`:

- `GET /status`
- `GET /alerts`
- `GET /deliveries`
- `POST /retry`

Signal K protects these routes with its normal plugin authentication. The status response includes queue counts, connectivity state, switch state, ownership, and the last connectivity error.

The included operational dashboard is served by Signal K at `/signalk-persistent-notifier`. It shows active alerts, latest cleared-alert states, per-transport delivery state, connectivity ownership, refresh status, and a manual retry action.

The dashboard alert catalog includes every configured rule, including rules that have never fired, plus recognized notifications that do not match a configured rule. Each entry shows its zone, current state, first seen time, last fired time, fire count, and delivery context. Configured `oneTime` alerts can be soft-removed from the dashboard without deleting stored event or delivery rows. Removed entries are currently
excluded from the catalog, including its History view; this is not yet the required
dismissal-and-history behavior.

When connectivity is enabled, the plugin waits for the configured probe to return a successful HTTP response before entering `ONLINE`. It retries until `bootTimeoutSeconds` and enters `FAULT` without deleting queued alerts if readiness never arrives.

Docker-backed HTTP integration tests are available with `npm run test:integration`. They start a local mock service and exercise ntfy, PagerDuty, and Discord transport requests without sending data to external services. Docker and Docker Compose are required; the normal `npm test` suite remains self-contained.

## Development

`npm test` runs the lifecycle and connectivity tests. `npm run format:check`, `npm run lint`, and `npm run build` are the required quality checks. The plugin entry point wires the Signal K subscription, durable delivery engine, connectivity manager, and authenticated plugin routes.
