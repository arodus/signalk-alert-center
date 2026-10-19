# Changelog

All notable user-visible changes are recorded here. The project follows Semantic
Versioning while it remains pre-1.0.

## [Unreleased]

### Fixes

- Send PagerDuty acknowledge and resolve events without trigger-only payload
  fields, and translate every Signal K severity to a value accepted by
  PagerDuty. Existing failed deliveries can be retried after upgrading.

## [0.4.2] - 2026-10-18

### Release automation

- Retry post-publish npm metadata verification for up to five minutes while a
  newly published package is still being processed by the registry.
- Keep the publication-verifier regression test isolated from npm-provided
  environment variables on Windows so the official Signal K Plugin CI passes
  on Windows with Node.js 22 and 24.

### Upgrading

- This release changes only release automation. It has no plugin runtime,
  database, configuration, or dependency changes.

## [0.4.1] - 2026-10-16

### Fixes

- Prevent in-progress first delivery attempts from briefly publishing a false
  notification-service failure followed by an immediate recovery. Service
  health now changes to failed only after an attempt records a real failure.

### Release automation

- Include and verify npm `gitHead` metadata in future releases so the Signal K
  Plugin Registry can associate each package with its canonical CI run instead
  of applying the `no-plugin-ci` score penalty.

### Upgrading

- No database migration, configuration change, or dependency change is
  required. Existing alert and delivery history is preserved.

## [0.4.0] - 2026-10-15

### Alert overview

- Restore the **Last triggered** column so each alert definition shows when its
  most recent occurrence started, or **Never** when it has not fired.
- Add clear spacing between **Last triggered** and the coloured **State** column
  on desktop and tablet layouts.

### Quiet hours

- Add the persistent Signal K PUT control
  `digital.alertCenter.quietHours.enabled`. Set it to `false` to bypass every
  saved per-service quiet-hours schedule and to `true` to restore them without
  changing their configuration.
- Clearly mark a disabled quiet-hours override in the dashboard banner,
  diagnostics, and affected notification-service cards.

### Snooze safety

- Add an opt-in setting that honors global snooze only while the standard
  `navigation.state` value is `anchored` or `moored`. Underway, missing, and
  invalid states bypass snooze without changing its saved deadline.
- Clearly mark an active but bypassed snooze in the dashboard and diagnostics,
  and recommend Signal K Auto State as an optional state provider.

### Upgrading

- No database migration or new dependency is required. Existing installations
  keep their current behavior because the navigation-state snooze guard is
  opt-in and quiet hours remain enabled by default.
- Signal K Auto State is recommended only when the navigation-state guard is
  enabled and no other source publishes `navigation.state`.
- Version 0.3.0 can read the same database if a rollback is necessary, but it
  does not understand the quiet-hours override or navigation-state snooze guard.

## [0.3.0] - 2026-10-12

### Alert overview

- Show every alert definition without a history-based **Load more** button.
  Active alerts are loaded independently of paginated history.
- Sort active alerts by severity first, then configured zones without an active
  alert, then inactive discovered alerts.
- Show configured zones without an active alert as **Normal**, including zones
  that have never fired. This means no active alert has been reported; it is not
  a guarantee that the sensor is available or its reading is fresh.
- Add a **Zones and active alerts** filter to hide inactive discovered alerts.
- Keep source and history filters complete across multiple result pages and
  include normal zones when filtering the overview by normal severity.

### Fixes and maintenance

- Render original notification-service icons correctly in the Signal K Store
  README instead of displaying raw HTML image tags.
- Respect `SIGNALK_NODE_CONFIG_DIR` in the Docker startup script and derive
  default data and server paths from the container user's home directory.
  Existing saved configuration and the default database location are preserved.
- Add official Signal K plugin CI checks on Node 22 and 24 across Linux x64,
  Linux ARM64, macOS, and Windows. Keep checkout line endings consistent and
  require both compatibility and project-specific checks before publishing.
- Require changelog entries for future user-visible changes in contributor
  instructions.

### Upgrading

- No database schema, API, notification-delivery, or saved-settings changes from
  0.2.0. Existing alerts, history, policies, and queued deliveries are preserved;
  no reset or migration is required.
- Node.js 22.5 or newer remains required. Optional notification-service
  requirements are unchanged.
- Rollback to 0.2.0 does not require restoring an older database schema. If you
  use a custom Docker data directory, keep mounting the same data volume and
  account for 0.2.0's hardcoded Docker paths before rolling back.

## [0.2.0] - 2026-10-11

### Pushover notifications

- Add Pushover notification services with user/group delivery, optional devices
  and sounds, manual tests, and durable retry support.
- Configure Pushover in the existing notification-service settings using an
  application API token and user or group key. Select it globally or per alert.
- Reuse Alert Center's per-service repeats, quiet hours, global snooze, and
  delivery-failure notifications. Alarm and emergency alerts use Pushover high
  priority; other levels and recovery messages use normal priority. Pushover's
  independent emergency-repeat and acknowledgement loop is not enabled.
- Update setup documentation, privacy information, and Signal K Store metadata.

### Upgrading

- No database schema or existing configuration changes from 0.1.1. Existing
  alerts, policies, history, and pending deliveries are preserved.
- Pushover is optional. Existing notification services continue unchanged.

## [0.1.1] - 2026-10-11

Maintenance release to publish through the GitHub Actions trusted-publishing
workflow. No runtime, configuration, or database changes from 0.1.0.

## [0.1.0] - 2026-10-11

First public release of Signal K Alert Center.

### Release highlights

- Persistent alert history and independently tracked offline delivery through
  ntfy, PagerDuty, Discord, Telegram, and optional Signal K Wyoming audio.
- Live sensor readings and reading age alongside configured zones, with
  receipt-time samples retained separately in history and delivery snapshots.
- Durable global snooze and per-service quiet hours with severity thresholds.
  Quiet hours support server-local time or a fixed IANA timezone, including DST;
  existing schedules retain their saved timezone.
- Refreshed Signal K Store listing, README service logos, and current screenshots
  covering the dashboard, history, settings, snooze, and quiet hours.

### Compatibility and upgrades

- Requires Node.js 22.5 or newer. Tested with Signal K 2.31.1 and the current
  server image in CI. Wyoming is optional; audio integration requires
  `signalk-wyoming` 0.3.0 or newer, and speech needs a TTS service such as Piper.
- Supported preceding Alert Center databases are migrated in place to schema 3,
  preserving alert history, policies, and pending deliveries. The discarded
  `signalk-persistent-notifier` prototype database is not imported.
- Before upgrading a pre-release installation, stop Signal K and back up the
  database. Rollback to an older build should restore that build and the matching
  pre-upgrade database backup; do not assume it can read the upgraded schema.
- Reported Wyoming playback completion comes from the satellite process; it
  cannot prove physical audibility. Already-sent remote requests cannot be
  recalled by snooze, and older Wyoming versions may lack audio cancellation.

### Included changes

- Show skipped deliveries with a neutral grey badge and the reason below it,
  keeping delivery status separate from explanatory text in lists and details.
- Align the dashboard and plugin settings with Signal K administration styling:
  blue controls, neutral panels, compact typography, bordered tabs, and consistent
  form buttons. Keep the full available width on desktop and tablet.
- Label Wyoming audio suppressed by Signal K methods as skipped in delivery lists,
  details, and attempt history instead of claiming it was delivered.
- Display zone bounds using Signal K preferred units, with Kelvin-to-Celsius
  fallback when display preferences are unavailable.
  Apply conversions to explicitly unit-labelled values and generated range
  messages sent through all notifiers, including Wyoming speech. Server-global
  unit settings are fetched locally and cached for five minutes.
- Use the Signal K path as the alert name when zone metadata has an empty or
  whitespace-only description. Existing blank names are repaired on zone discovery.
- Follow the Signal K severity order (`normal`, `alert`, `warn`, `alarm`,
  `emergency`) in threshold evaluation, alert sorting, schemas, and every
  severity dropdown. Retryable service failures now use `alert` and terminal
  failures use the higher `warn` state.
- Create a new durable delivery cycle whenever an active Signal K alert changes
  severity state, including while an earlier state is queued or retrying. Each
  cycle retains its own severity and message snapshot. Escalation and
  de-escalation are delivered separately, clear sends one recovery delivery, and
  repeated updates in the same state remain coalesced.
- Publish a Signal K health notification for every enabled notification service:
  normal with no unresolved failures, alert while delivery is retrying, and warn
  after a terminal failure. Each service can send its failure and recovery
  notifications through explicitly selected other services; self-delivery and
  repeat delivery are blocked to prevent recursive notification loops.
- Failed deliveries can now be deleted individually or in bulk from the
  Deliveries tab. Their attempt rows are removed while the associated alert
  occurrence and alert history remain available.
- Persist and display aggregate and per-satellite signalk-wyoming playback
  outcomes separately from notification delivery acceptance, including restart
  reconciliation and explicit unknown results when confirmation is lost.
- Added complete Signal K App Store metadata, reproducible desktop and tablet
  screenshots, privacy and first-run guidance, an operator-focused README, and a
  separate developer guide.
- Added signalk-wyoming notification sounds with a configurable sound for every
  alert severity, per-alert sound overrides, and independent per-alert sound and
  speech switches. When both are enabled, the sound is queued before speech.
- Repeat-while-active delivery is configured per notification service, persisted
  across restarts, and continues while the Signal K alert remains active even if
  its source sends no additional updates.
- Added Telegram Bot API notifications with chat, forum-topic, silent-delivery,
  manual-test, and durable retry support.
- Added signalk-wyoming as an optional notification service for durable spoken
  alerts, including global satellite, voice, severity, and urgency settings;
  per-alert speech templates, severity thresholds, optional clear announcements;
  and manual speech tests. Alert Center does not require Wyoming when this service
  type is not configured.
- Added validated npm package creation, clean-install smoke testing, and protected
  tag-based npm and GitHub release automation.
- Renamed the package, Signal K plugin, dashboard, and API to Signal K Alert
  Center as a clean version-one installation.
- Initialize new installations in `alert-center.sqlite`; upgrade supported
  preceding Alert Center schemas transactionally without requiring a reset.
- Added a modern, sectioned Signal K settings panel with service-type controls,
  a configured-service default picker, unsaved-change handling, and a confirmed
  database-reset action.
