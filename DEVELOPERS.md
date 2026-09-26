# Developing Signal K Alert Center

This guide covers local development, architecture, tests, and releases. The
[README](./README.md) is intentionally written for operators and App Store users.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` is used directly)
- npm
- Docker with Compose for Signal K integration and browser tests

Install dependencies and run the complete local release check:

```sh
npm ci
npm run release:check
```

The release check formats, type-checks, runs unit tests, builds the plugin and
configuration panel, verifies package contents, and smoke-tests a clean package
installation.

## Architecture

Alert Center is an occurrence-based, durable delivery engine:

1. Signal K `notifications.*` deltas enter a bounded ingestion queue.
2. Normalized state is persisted in SQLite before external work begins.
3. Each eligible notification service gets an independent delivery row.
4. The delivery scheduler claims rows transactionally and records every attempt.
5. Retry and per-service repeat deadlines are persisted and recovered on restart.
6. Server-sent events notify the webapp to refresh after material changes.

The main boundaries are:

- `src/signalk/` — subscription and ingestion mechanics;
- `src/alerts/` — normalization, lifecycle, zones, and effective policy;
- `src/storage/` — schema, migrations, occurrences, events, and deliveries;
- `src/delivery/` — retry and scheduling;
- `src/transports/` — independent notification-service adapters;
- `src/connectivity/` — optional internet switch ownership and probing;
- `src/api/` — authenticated plugin routes and OpenAPI document;
- `public/` — Alert Center webapp;
- `src/configpanel/` — React-based Signal K configuration panel.

See [IMPLEMENTATION_BRIEF.md](./IMPLEMENTATION_BRIEF.md) for the historical gap
analysis, design decisions, and detailed acceptance scenarios.

## Local Docker environments

Start a live Signal K server with the plugin installed:

```sh
docker compose -f docker-compose.live.yml up --build
```

Add deterministic alerts and zones:

```sh
docker compose -f docker-compose.live.yml -f docker-compose.demo.yml up --build
```

Then open:

- Signal K administration: <http://localhost:3000/admin/>
- Alert Center: <http://localhost:3000/signalk-alert-center/>

The acceptance environment is isolated, disables authentication, and uses only
the included mock notifier:

```sh
npm run test:acceptance
docker compose -f docker-compose.acceptance.yml down -v --remove-orphans
```

Never point automated tests at real notification services or vessel hardware.

## Tests

```sh
npm test                 # unit and storage tests
npm run typecheck        # strict TypeScript
npm run test:acceptance  # real Signal K server and mock notifier
npm run test:browser     # desktop/tablet UI plus restart coverage
npm run package:check    # package metadata and required files
npm run package:smoke    # clean packaged-plugin installation
```

Browser and acceptance fixtures live under `test/integration/`. They publish
deterministic Signal K zones and notification deltas and must remain test-only.

## Store screenshots

The Store assets in `docs/screenshots/` are generated from the isolated Compose
demo. Docker and Google Chrome or Playwright Chromium are required:

```sh
npm run screenshots:store
```

The script starts a clean acceptance stack, configures only synthetic services,
seeds representative data, captures desktop and tablet views, verifies that no
image exceeds the Store size budget, and removes the temporary Docker volume.
Regenerate the images after a material UI change.

## Schema changes

The current schema remains version one. A change that would otherwise require a
database reset must include a focused, transactional, restart-safe migration for
the immediately preceding supported schema. Tests must create the old shape on
disk, reopen it through `AlertDatabase`, verify preserved records, and verify that
the migration is idempotent.

## Adding a notification service

A transport must:

- implement `NotificationTransport`;
- keep requests bounded by timeout and response-size limits;
- classify failures as retryable or terminal;
- never delete or mutate another transport's delivery state;
- expose safe manual-test behavior;
- add global configuration and clear field descriptions;
- add unit, API, package, and acceptance coverage where applicable;
- document exactly which alert data leaves Signal K.

## Wyoming delivery lifecycle

Alert Center uses the in-process `signalk-wyoming.announcements.api` version 1
interface. It does not invoke Piper directly, run shell commands, or use browser
speech. A Wyoming delivery first records whether the announcement request was
accepted, then follows and persists its aggregate and per-satellite lifecycle
through queued, playing, and terminal states.

Playback outcomes survive Alert Center restarts. If Wyoming restarts before an
in-flight announcement can be reconciled, the outcome is recorded as unknown
rather than silently treated as played. A `played` state confirms completion
reported by the satellite process, not audible output from the physical speaker.
Stable request IDs make retries idempotent, including the sound-then-speech
sequence. Wyoming-only services do not request managed internet connectivity.

## Releases

Release automation and tag requirements are documented in
[docs/RELEASING.md](./docs/RELEASING.md). User-visible changes belong in
[CHANGELOG.md](./CHANGELOG.md). Before preparing a release, run:

```sh
npm run release:check
```

The npm package must contain built runtime files, the webapp, icon, screenshots,
README, developer guide, changelog, and license. It must not depend on install-time
scripts because the Signal K App Store installs plugins with scripts disabled.
