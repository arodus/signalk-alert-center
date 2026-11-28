# Changelog

All notable user-visible changes are recorded here. The project follows Semantic
Versioning while it remains pre-1.0.

## [Unreleased]

## [0.11.1] - 2026-11-28

### Upgrade and rollback

Upgrading from 0.11.0 requires no configuration changes, database migration, or special backup. Both versions use schema 6. Existing alert history stays intact. The history fix prevents redundant rows on new updates and does not reclaim space already used.

To roll back, reinstall 0.11.0. Signal K retains the event-driven defaults for quiet-hours and snooze paths after a downgrade. Explicit user metadata takes precedence. A package downgrade was not tested. For upgrades from earlier versions, see the 0.11.0 migration and backup instructions below.

### Fixes

- Repeated notifications refresh the last-seen time and latest reading without adding a history row for each value change. [#147](https://github.com/arodus/signalk-alert-center/pull/147)
- Quiet-hours and snooze controls retain their values when Signal K enforces data timeouts. [#144](https://github.com/arodus/signalk-alert-center/pull/144)
- Zones added or changed after startup appear in the Alerts list within about a second. [#143](https://github.com/arodus/signalk-alert-center/pull/143)

## [0.11.0] - 2026-11-27

### Upgrade and rollback

- **Back up before upgrading:** stop Signal K and take a consistent backup of the configured Alert Center SQLite database and plugin configuration. The automatic, transactional schema-5-to-6 migration preserves alerts, history, policies, and pending deliveries while adding location snapshots. Historical delivery locations that were not captured remain unknown. No database reset is required.
- **Rollback requires the backup:** version 0.10.0 cannot open a schema-6 database. Stop Signal K, reinstall the previous package, and restore the pre-upgrade database and configuration. Restoring the backup discards history and delivery progress recorded after it was taken. The schema-5 upgrade and restart persistence are tested; a complete downgrade-and-restore installation was not tested.
- **Notification permissions:** with Signal K ACLs enabled, users who acknowledge or silence server-managed legacy notifications need `put` permission on both the literal `notifications` collection and the individual notification paths they may control. Core-alert permissions and local-only annotations are unchanged.
- **Ignore defaults:** security access requests are now ignored when no `ignoredPaths` list has been saved. Explicit lists, including an empty list, remain unchanged. Add `security.accessRequest.*` to an existing list if desired. Existing history and queued delivery work are preserved; ignoring a path does not cancel pending work.
- **Server compatibility:** ordinary notifications remain compatible with Signal K Server 2.31.1. Native stale indicators require Signal K Server 2.38.0 or newer with **Enforce Data Timeouts** enabled. Alert Center does not create timeout alerts; configure sensor-loss alerts in a separate rules plugin.

### Features

- Show notification locations in the Alerts table, detail drawer, history, and standard remote messages. Service and Wyoming speech templates support `{location}`. Events and deliveries keep their captured location across restarts and retries; location-only updates do not retrigger delivery. [#136](https://github.com/arodus/signalk-alert-center/pull/136)
- Show timed-out readings as **Stale**, with age measured from the last valid reading rather than the timeout event. Missing readings remain unavailable, and valid selected-source recovery restores the live display. These indicators create no alerts, history events, or deliveries. [#138](https://github.com/arodus/signalk-alert-center/pull/138)

### Fixes

- Confirm stored-alert removal inside Alert Center so it also works in AppDock when browser prompts are blocked. [#133](https://github.com/arodus/signalk-alert-center/pull/133)
- Enforce both notification collection and per-alert path permissions before acknowledging or silencing server-managed legacy notifications. Denied requests leave stored alert state unchanged. [#134](https://github.com/arodus/signalk-alert-center/pull/134)
- Reset local acknowledgement and silence when an active legacy notification changes severity, including decreases, while preserving history. Message and location changes retain those actions, and pending remote acknowledgements of the old state cannot acknowledge the new state. [#135](https://github.com/arodus/signalk-alert-center/pull/135)
- Format Signal K 2.38 zone messages in display units and retain captured readings in history and deliveries after thresholds change. Removed thresholds disappear from the Alerts table while stored history and policy remain. [#137](https://github.com/arodus/signalk-alert-center/pull/137)
- Ignore `notifications.security.accessRequest.*` by default, including nested access-request paths, while continuing to track other security notifications. [#141](https://github.com/arodus/signalk-alert-center/pull/141)

### Maintenance

- Validate issue and PR titles and apply type labels automatically. [#139](https://github.com/arodus/signalk-alert-center/pull/139)
- Prepare release notes from merged PRs and require a reviewed upgrade-and-rollback section before publishing. [#140](https://github.com/arodus/signalk-alert-center/pull/140)

[Full changelog](https://github.com/arodus/signalk-alert-center/compare/v0.10.0...v0.11.0)

## [0.10.0] - 2026-11-23

### Features

- Customize each remote notification service’s message with alert text, name, severity, state, path, and server-local occurrence times. Leave the template blank to keep the standard message.
- Disable or re-enable delivery for future occurrences with a switch under the alert name, even before its first occurrence. History and previously queued deliveries are preserved.

### Fixes

- Start fresh installations automatically with no notification services required
  and Internet connection control disabled. This also makes the webapp appear in
  Signal K 2.37.0's Webapps list. Explicitly disabled
  installations remain disabled across upgrades and restarts.
- Allow saving the initial configuration defaults without changing a setting.

## [0.9.1] - 2026-11-20

### Fixes

- Close stored notifications that are no longer present after a Signal K
  restart. Previously they stayed active indefinitely when their producer only
  publishes on change and the condition ended while the server was down. After
  startup, notifications that no producer republishes within the new **Startup
  grace period** setting (120 seconds by default) are closed without a recovery
  message; any queued initial delivery is kept, and PagerDuty incidents they
  opened are not resolved. Notifications republished within the period continue
  their existing occurrence without notifying again.
- The Alerts table and Normal severity filter now include recognized notifications
  whose source explicitly reports normal, even when the path has never fired.

## [0.9.0] - 2026-11-19

### Features

- Support Signal K core alerts alongside legacy notifications, with durable
  per-service delivery, grouped momentary alerts, and separate condition,
  acknowledgement, silence, and source status. Acknowledge and silence through
  the core API; Wyoming follows core silence and attention state.
- List Alert Rules definitions before they fire, including disabled and invalid
  rules. Configure delivery once per rule; wildcard instances share those
  settings while retaining separate history. Settings survive restart and work
  with the dashboard closed. Alert Rules remains responsible for conditions and
  thresholds and is recommended as an optional companion plugin.
- Use one search and filter toolbar across Alerts, Alert history, and Deliveries.
  Search text, severity, and date bounds carry between tabs; each tab keeps its
  relevant status or update filters. Search includes names, messages, paths, and
  sources, plus service names and errors in Deliveries. Matching retained records
  are found before pagination, and delivery results retain pending-work priority.
  History severity filters match the displayed event severity; delivery filters
  use recorded message and severity snapshots.

### Fixes

- Load rule catalogs and delivery defaults without blocking the alert list.
  History and delivery links within the open dashboard select and load their tab.
- Respect Signal K's disabled notification management when discovering metadata
  zones. Hide stored zones without retained occurrences while preserving their
  settings. Actual legacy alerts, history, queued deliveries, and the Alert Rules
  catalog remain available.
- Use core terminal removal reasons to confirm recovery for completed conditions
  and acknowledgements. Displaced alerts retain history and queued initial
  deliveries without claiming recovery; superseded acknowledgement/recovery
  work and repeats are suppressed. Missing or unknown reasons remain unclassified
  unless recovery was independently confirmed.
- Preserve Alert Rules' formatted messages and units in the dashboard and all
  delivery services, including speech. Legacy notification unit conversion remains
  available.
- Ignore routine waypoint arrival-circle and perpendicular-passed notifications
  by default, alongside per-target collision alarms. Existing explicit
  `ignoredPaths` lists remain unchanged. Remove either exact course path from
  the list to track and deliver it; other course notifications remain tracked.
- Refresh the README to describe the implemented core-alert support, rule
  settings, manual installation, and upgrade requirements.

### Compatibility, upgrade, and rollback

- Core support activates when the server exposes the compatible core alerts API.
  Legacy notification support remains available on Signal K Server 2.31.1.
  See [compatibility notes](docs/core-alerts-migration.md) for the tested core
  server and Alert Rules revisions. Compatibility with other core API revisions
  has not been verified.
- Stop Signal K and back up the Alert Center SQLite database before upgrading.
  Schema 3 and 4 databases migrate transactionally to schema 5, preserving history,
  policies, attempts, pending deliveries, and the delivery-history index.
  Interrupted migrations roll back and retry on startup; no reset is required.
- Version 0.8.0 and older cannot open schema 5. Rollback requires both the older
  package and the pre-upgrade database backup. Restoring that backup discards
  history and delivery progress recorded after it was taken.
- Core `alerts.*` paths use separate delivery policies and permissions from legacy
  `notifications.*` paths. ACL installations must grant `put` on allowed core
  paths separately. Restricted admins are checked too; settings, rule-editor
  links, maintenance, and dashboard snooze controls remain admin-only.
- Legacy policies are not transferred automatically. Core history is not replayed
  for alerts that began and ended while Alert Center was stopped; missing active
  alerts do not prove recovery. Alert Rules messages use the producer's units for
  all recipients, without per-recipient conversion.

## [0.8.0] - 2026-11-12

### Features

- Add a sun/moon appearance menu to Alert Center. Auto (the default) follows
  Signal K's day/night mode, falling back to the device's appearance when
  unavailable. Light and Dark overrides are saved per browser and server,
  without changing the shared mode. Dark styling covers alerts, history,
  delivery details, settings, and status banners.

### Fixes

- Keep automatic appearance in sync when Signal K's day/night mode changes
  rapidly, including falling back to the device after an invalid or cleared mode.
- Show the alert list as soon as its alert data arrives, without waiting for
  units metadata, login status, or diagnostics. Load units in the background
  and fetch history and deliveries only when their tab is selected. The delivery
  badge now counts undelivered items (including failures), while the tab retains
  the full delivery history. Detailed diagnostics load only when expanded.
- Use indexed pending counts and delivery-history pagination. The dashboard skips
  lifetime totals; API clients still receive them unless they set
  `includeTotal=false`. A lightweight `/summary` endpoint avoids historical and
  service aggregates during page loading.
- Automatically upgrade storage to schema version 4 with a delivery-history index.
  The first startup may take longer while the index builds. History, settings, and
  pending work are preserved; no reset or configuration change is needed.

### Upgrade and rollback

- Stop Signal K and back up the Alert Center SQLite database before upgrading.
  Version 0.7.0 rejects the upgraded schema; rolling back requires both the older
  package and the pre-upgrade database backup. Restoring that backup also discards
  history and delivery progress recorded after it was taken.

## [0.7.0] - 2026-11-11

### Features

- Add **Notification paths to leave out** in plugin settings. Per-target
  `navigation.closestApproach.*` collision alarms are ignored by default,
  including after upgrading when no explicit list is saved. Edit the wildcard
  patterns or clear the list to track all paths. Matching live updates, startup
  snapshots, and zone definitions are skipped. Existing history, settings, and
  queued delivery work are preserved; ignored occurrences no longer receive
  updates or clears.

### Fixes

- Use Signal K display names for configured zone alerts, falling back to the
  data path when no display name is set. Schema descriptions such as “Data should
  be of type number.” no longer appear as alert names. Existing names are corrected
  on startup or the next zone refresh without changing history or delivery settings.

### Upgrading and compatibility

- No database migration or dependency upgrade is required. Existing history,
  alert settings, and queued deliveries are preserved.
- Installations without an explicit ignored-path list now leave out per-target
  collision alarms by default. Clear **Notification paths to leave out** in
  plugin settings to keep tracking those paths. Ignoring an already-active
  occurrence leaves it stored but stops subsequent updates and clears.
- Rollback to 0.6.0 does not require restoring the database. That version ignores
  the new path-filter setting, resumes tracking all notification paths, and uses
  the previous zone-name behavior.

### Release automation

- Verify successful CI runs on the exact tagged main commit before publishing,
  reusing those checks instead of repeating the full test matrix for the tag.
  The release still builds, inspects, and smoke-tests the published package.

## [0.6.0] - 2026-11-11

### Alert settings

- Group each alert setting with its own consistently placed Customize / Use global
  default button. Keep connection wake delay inside its connection setting, with a
  responsive layout for narrow screens.

### Fixes

- Enforce Signal K path ACLs before acknowledging or silencing alerts through
  either API route. A restricted readwrite or admin login can no longer bypass
  notification permissions through Alert Center. ACL users must grant `put` on
  the allowed `notifications.*` paths; a literal `notifications` permission does
  not cover child paths.
- Require admin access for alert settings, definition and policy removal,
  delivery deletion/retry, service tests, and global snooze buttons. Read-only
  views and existing ACL-controlled Signal K PUT controls remain available.
- Hide action and settings controls for anonymous and read-only dashboard
  visitors. Readwrite users retain alert actions, while admin controls appear
  only for admins. Snooze status, alert history, and delivery details remain
  visible to readers. Permission errors explain missing access without asking an
  already signed-in user to sign in again.

### Upgrading and compatibility

- Access requirements are stricter in this release. Use an admin login for alert
  settings, delivery maintenance, service tests, and global snooze API requests.
  Update integrations that previously called these routes as readwrite users.
- When Signal K ACLs are configured, grant `put` on each notification path that
  a user may acknowledge or silence, including for admin users. A grant on the
  literal `notifications` path alone is insufficient. Without configured ACLs,
  readwrite users retain acknowledge/silence access.
- Existing Signal K PUT controls for snooze and quiet hours retain their normal
  path permissions. Dashboard controls reflect login roles; individual path ACL
  denials are reported when an action is attempted.
- No database migration, dependency upgrade, or plugin configuration change is
  required. Alert history, policies, and pending deliveries are preserved.
- Rollback to 0.5.0 does not require restoring the database, but restores its
  permissive API behavior and the permission bypass fixed in this release.

## [0.5.0] - 2026-10-20

### Connectivity

- Use the preferred `network.internet.state` value from the recommended optional
  `@meri-imperiumi/signalk-internet` plugin as the single Internet-availability
  source. `online` and `metered` permit remote alert delivery; `offline` and
  `captive` pause it without consuming retry attempts.
- Remove Alert Center's duplicate HTTP probe URL and timeout settings. Configure
  hardware mappings and active probing in `@meri-imperiumi/signalk-internet`.
  Existing saved probe fields are ignored after upgrading.
- Keep normal retry behavior when `network.internet.state` is missing, cleared,
  or invalid so an unavailable optional provider cannot strand durable work.
- Block automatic connection wake commands until a valid shared Internet state
  has been observed. Wake requests remain durable and are reconsidered when the
  provider starts publishing, so a missing optional plugin cannot energize and
  strand the configured connection.

## [0.4.3] - 2026-10-19

### Fixes

- Pause Internet-required notification services when the configured availability
  check confirms the vessel is offline. Waiting deliveries remain durable and do
  not consume retry attempts; they resume automatically when Internet access
  returns. Local Wyoming sound and speech delivery continues while offline.
- Persist plugin-owned connectivity sessions across restart, retain ownership
  after an Internet boot timeout, and release only a still-observed connection
  that the plugin originally turned on.
- Document the legacy alert catalog, acknowledge, and silence routes in OpenAPI,
  and wait for those actions to finish before reporting success.
- Send PagerDuty acknowledge and resolve events without trigger-only payload
  fields, and translate every Signal K severity to a value accepted by
  PagerDuty. Existing failed deliveries can be retried after upgrading.

### Behavior and configuration

- Notification services now report whether they require Internet access. ntfy,
  PagerDuty, Discord, Pushover, and Telegram wait while confirmed offline;
  Wyoming sound and speech remain available locally.
- The existing Internet availability check also controls retry pausing when
  connection-switch control is disabled. No new setting is required. Without a
  configured check, deliveries use the previous normal retry schedule.
- The first remote attempt is still allowed while Internet availability is
  unknown. A network failure starts the check; the configured endpoint defines
  whether Internet access is considered available.

### API and compatibility

- Notifier and status responses expose `requiresInternet` and aggregate Internet
  availability. OpenAPI now includes the legacy alert catalog, acknowledge, and
  silence routes.
- No database migration or dependency change is required. Existing history,
  policies, delivery attempts, and connectivity settings are preserved.
- Rollback to 0.4.2 does not require restoring the database. Deliveries waiting
  for Internet return to 0.4.2's normal retry behavior after rollback.

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
