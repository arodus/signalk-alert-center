# AGENTS.md

## Branches, commits, and pull requests

Apply these rules whether you use local Git, `gh`, or the GitHub API.

- Before editing, check the repository root, current branch, working-tree changes,
  and any existing branch or PR for the task. Continue existing work on its branch.
  For new work, create a focused branch from the intended base before editing.
  If the checkout contains unrelated work, use a separate worktree.
- Name new branches `<purpose>/<short-kebab-case-description>`. An issue number
  is optional, for example `fix/69-tablet-badge-width`. Use an exact branch name
  supplied by the user as given. Assistant-branded prefixes such as `codex/`
  and `agent/` require an explicit request.
- Choose the branch prefix by purpose:
  - `feature/` for new functionality and `fix/` for bug fixes.
  - `refactor/`, `docs/`, `test/`, or `perf/` for changes of that kind.
  - `ci/` for workflows, `build/` for packaging, and `chore/` for maintenance.
  - `release/` for release preparation and `hotfix/` for explicitly urgent
    production fixes.
- Use Conventional Commit titles: `type: summary` or `type(scope): summary`.
  Use `feat:` for a `feature/` branch. For example, a fix on
  `fix/appdock-stored-alert-removal` could use the commit title
  `fix: confirm stored alert removal in AppDock`.
- Give issues and PRs Conventional Commit titles with a nonempty summary.
  GitHub applies the Signal K type label from the title (for example,
  `feat:` → `feature`, `fix:` → `fix`, and `docs:` → `doc`).
- Before committing or pushing, verify the target branch and review the diff
  against the intended base. Include only changes that belong to the task.
- Open ready-for-review PRs by default. Use a draft only when requested.
  Describe what changed, why, which checks passed, and which could not run.
  Merging, rewriting published history, deleting branches, releasing, and
  deploying each require authorization.

## Project scope

Signal K Alert Center provides persistent onboard alert history and offline-first
remote delivery on Raspberry Pi-class systems. The lifecycle engine records
alerts in durable storage. A scheduler delivers them through independent
notifier instances. A separate connectivity manager can wake and release a WAN
connection through a Signal K switch.

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

- Show every discovered notification path and every Signal K path with `meta.zones`,
  including definitions that have never fired. Use one Alerts table that combines
  definition identity, current status, history access, and policy access without
  confusing definition provenance with occurrence state.
- Preserve each current occurrence independently in storage and history. A summary
  row must not hide its source identity in the detail view.
- Keep one-time occurrences visible until an operator dismisses them. Label this
  action "Dismiss" and retain the occurrence, events, and delivery work in history.
- Clicking a definition or occurrence must open its recent chronological history,
  including raise, meaningful updates, clear, acknowledge, silence, dismissal,
  activation-delay decisions, and notifier attempts/outcomes.
- Allow an operator to configure each alert definition from the UI. At minimum,
  policy includes enabled state, selected notifier instances, minimum severity,
  connectivity behavior, one-time semantics, per-notifier repeat delivery, and activation delay. Store
  dynamic per-definition overrides separately from immutable Signal K zone
  metadata and separately from occurrence state.
- Resolve policy predictably: an explicit per-definition override wins over plugin
  defaults. Plugin configuration is global only; do not add per-alert rules there.
  Expose the effective policy and where each value came from.
- Only inactive definitions learned from notification deltas may be forgotten.
  Forgetting is an explicit destructive operation that removes their history and
  policy; zone-derived definitions and active alerts must reject it.
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

Do not add compatibility code for the discarded prototype SQLite layout. Preserve
the immediately preceding Alert Center schema with focused, shape-detected,
transactional migrations when an upgrade would otherwise require users to reset
stored data. Any schema change after the first release must use a versioned,
restart-safe migration.

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

## Persistence and delivery

- Normalize Signal K input independently of the wire schema. Keep the stable source
  key, path, original value and metadata, first/last seen and clear times, current
  state and severity, and peak severity. When an alert rises and clears offline,
  deliver its lifecycle with timestamps or duration.
- In one transaction, persist the occurrence, lifecycle changes, and required
  per-notifier work before any send or wake request. Record delivery transitions
  and outcomes atomically. Prefer SQLite or another lightweight transactional
  store; document the rationale for an alternative.
- Schedule each configured notifier instance independently and in parallel.
  Persist its delivery ID, state (pending, waiting for connectivity, sending,
  delivered, retryable or terminal failure), attempts, next and last attempt times,
  delivery time, last error and remote ID. Retry only outstanding targets.
  Repeat a successful delivery only under explicit repeat or escalation policy.
- The scheduler owns batching, concurrency and retries. Interpret HTTP outcomes,
  distinguish configuration failures from transient errors, and persist
  exponential backoff with jitter and a configurable cap. Emergency and critical
  work must survive indefinitely when retry age is the only reason to expire it.
  At-least-once sending is acceptable; use remote deduplication where available.
- Recover pending alerts, in-flight work, retry deadlines, attempts and ownership
  after restart. On stop, stop scheduling sends and timers, allow bounded
  completion of database operations, and persist state. Shutdown alone must
  never power off connectivity.

## Notifier transports

Use a shared interface for type, configuration validation, asynchronous send and
optional health check. Return success, retryable failure or permanent failure.
Keep power control and retry scheduling outside the adapters.

- **ntfy** — server, topic, authentication, priority mapping, title, message, tags
  and click URL.
- **PagerDuty** — Events API routing key, trigger and appropriate resolve, stable
  occurrence dedup key, severity mapping, and links or custom details where useful.
- **Discord** — webhook, readable title/body, severity, timestamps and optional
  embeds. Treat Discord as informational.

## Connectivity and power ownership

- For eligible deliveries, `queue` waits for connectivity, `wake` requests it
  immediately, and `wake_after` requests it only if the condition stays active
  through the configured delay. Once online, send all eligible work, including
  queued alerts that did not request the wake.
- Model switch requests and confirmation, powered/booting, Internet readiness,
  online, idle cooldown and faults explicitly. Use Signal K PUT with configurable
  path, ON/OFF values, optional separate observed-state path, confirmation and
  boot timeouts, Internet check interval, idle cooldown and keepalive as applicable.
- Record the observed switch state before requesting ON. Claim ownership only
  after observing OFF, requesting ON and confirming ON. Leave manually powered
  or ambiguously owned connections on, including after a restart.
- Request OFF only for a proven plugin-owned session after cooldown, with no
  pending work requiring connectivity, active wake-required alert, retry within
  the protected keepalive window, or send in flight. A new alert cancels cooldown.
  On switch failure or Internet timeout, retain queued work and expose the error.

## Configuration, operations and security

- Validate global configuration at startup. Support multiple instances per
  transport, per-instance secrets and severity floors, global policy defaults,
  retries, persistence and connectivity settings. Store per-definition policy
  separately as described above.
- Provide the alert list and history APIs, status, deliveries, manual retry and
  transport testing (`GET /status`, `GET /alerts`, `GET /deliveries`,
  `POST /retry`, `POST /test/:transport`). Manual wake/release is optional.
  Authenticate manual actions through Signal K.
- Report pending alert and delivery counts, oldest pending delivery, last
  successful send, per-notifier status, connectivity state, observed switch,
  ownership and last connectivity/delivery errors. Document plugin-specific
  Signal K paths when publishing status.
- Log alert/source, delivery and transport IDs, attempts, connectivity transitions
  and switch command outcomes. Keep secrets in supported configuration or secret
  storage. Redact credentials and webhook URLs from logs and API responses.
  Validate outbound URLs. Interactive notifier actions that control boat equipment
  require explicit authorization. Avoid arbitrary command execution.
- Prefer subscriptions over high-frequency polling. Bound memory queues, avoid
  full-file rewrites per alert and minimize Internet probes while power is off.

## Engineering workflow

- Before changing behavior, identify affected state transitions, transaction
  boundaries, restart recovery, notifier independence and connectivity ownership.
  Add or update failure-path tests and make the smallest coherent change.
- For Signal K lifecycle, packaging, configuration, data paths, subscriptions,
  alerts, PUT, auth, routing, storage directories, UI, logging or testing,
  verify conventions against current official docs and server source/types,
  then first-party plugins and mature maintained plugins. Inspect source and
  tests; compare multiple implementations for significant choices. Document
  deliberate deviations, rationale and compatibility implications.
- Use strict TypeScript and a Node version compatible with the supported server.
  Keep plugin lifecycle, alert normalization/policy, storage/migrations,
  scheduling, transports, connectivity and API responsibilities distinct.
  Follow existing conventions, order imports, remove dead code and avoid loose
  types or large frameworks without a clear benefit.
- Run the repository formatter, linter, strict type-check and relevant unit and
  integration tests. Format changed examples and config too. Fix failures.
  Document any necessary rule exceptions. If tooling is missing, add standard
  scripts (prefer Prettier and TypeScript-aware ESLint), document them, and
  enforce the same checks in CI where practical.

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

## Documentation and releases

- Document architecture, supported Signal K versions, installation, notifier and
  switch setup, offline queue behavior, power ownership, example configuration,
  troubleshooting and sending a test alert in the README.
- Every notable user-visible change needs a concise `CHANGELOG.md` entry under
  `[Unreleased]` in the same PR. Include configuration, compatibility, upgrades
  and any action users must take. Verify the entry before completion or merge.
  Explain strictly internal or documentation-only exceptions in the PR description.
- Bump versions and create dated changelog sections only for requested releases.
  Move the relevant unreleased entries into the release section.
