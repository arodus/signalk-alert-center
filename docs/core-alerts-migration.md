# Core alerts migration

Alert Center consumes both legacy `notifications.*` and the proposed Signal K
core `alerts.*` API when the server exposes `app.alerts`. Detection and the core
lifecycle stay with the server and alert producers such as `signalk-alert-rules`.
Alert Center owns durable delivery, notifier retries, connectivity and Wyoming
audio. Existing notification producers, policies and pending deliveries remain
supported.

The integration targets SignalK/signalk-server PRs
[3009](https://github.com/SignalK/signalk-server/pull/3009),
[3010](https://github.com/SignalK/signalk-server/pull/3010),
[3011](https://github.com/SignalK/signalk-server/pull/3011) and
[3012](https://github.com/SignalK/signalk-server/pull/3012), at cumulative commit
`33f487c7135db583a26b394ce04509b7b6c512ac` in
`hatlabs/signalk-server`, branch `feat/alerts-plugin-surface`. This remains a
development API; it is not a promise of compatibility with an eventual release.
The narrow compatibility types in `src/signalk/core-alerts.ts` follow that
commit because the supported published `@signalk/server-api` lacks these exports.
Replace them with upstream types when published.

## Identity and state

| Core fact                                  | Alert Center behavior                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core alert ID                              | Stored separately from the local occurrence/delivery IDs; one local occurrence per core ID                                                         |
| Condition path                             | Alert Rules policies belong to the producer and rule slug; other native policies belong to `alerts.<path>`. Both are separate from legacy policies |
| Producer `$source`                         | Preserved from the alert itself; the outer `alertsApi` publisher is not treated as the producer                                                    |
| `caution`, `warning`, `alarm`, `emergency` | Mapped to existing `alert`, `warn`, `alarm`, `emergency` delivery severities                                                                       |
| `rtn-unacknowledged`                       | Remains visible/actionable; condition return cancels activation and wake requests, stops repeats, and records confirmed recovery                   |
| Latching/momentary alert                   | Retained despite `condition:false`; repeated raises under one core ID remain grouped, with fresh delivery cycles                                   |
| Stale/offline producer                     | Shown as stale, never interpreted as condition recovery                                                                                            |
| Acknowledge/silence                        | Calls core by ID, awaits confirmation, and records failures without a false local success                                                          |
| Core silence                               | Pauses/cancels Wyoming audio; remote notifier delivery remains independent; core unsilence resumes audio                                           |

The API keeps its existing `state: active|cleared` field for local membership and
adds `coreAlert` with the core lifecycle, condition, references and source status.
Consumers must use `coreAlert.state` for core attention state and
`coreResolutionConfirmed` for recovery. In particular, local `cleared` does not
prove that a removed core alert recovered. The UI displays that distinction.
Actions through the plugin are attributed to the plugin by core; they do not
impersonate the signed-in user in the core audit trail.

Heartbeats refresh the stored snapshot without adding duplicate deliveries or
history events. Material state, priority, message, acknowledgment, silence and
source-status changes are recorded. The original alert payload is retained.
Related data paths are references, not identity; receipt-time message samples
use the first reference when applicable.

Activation deadlines persist. A reactivated condition must satisfy its activation
delay again. Delivery cycles are ordered within each core ID/notifier so an older
send cannot overtake a newer lifecycle action; independent notifiers can proceed
in parallel. Unsent recovery/acknowledgment actions superseded by renewed attention
are marked suppressed and recorded in history.

## Restart and upgrade

Schema version 4 adds core identity, confirmed-resolution and deferred
reannouncement fields transactionally. It preserves legacy rows, policies,
delivery attempts and pending work. Back up the database before testing an
unreleased build; older plugin builds cannot open schema version 4.

Subscribe first, capture the current core `list()` immediately, then reconcile
before processing queued deltas, overdue activation or wake work. `list()` is the
active-set authority: the Signal K model can retain old terminal snapshots.
Previously stored core IDs absent from that list are closed locally with a
`core_missing_on_startup` event and an unclassified terminal projection. Their
queued remote deliveries and prior event payloads remain stored.

This version does not replay core history to reconstruct alerts that both began
and ended while Alert Center was stopped. History remains Alert Center's durable
record of what it observed. Native alerts from other producers are discovered on
first observation. Legacy policy paths are not automatically mapped to native
alerts. Core latching semantics take precedence over the
legacy one-time policy for native alerts. Keep equivalent legacy producers and
new rules from both raising the same physical condition during a test cutover.

## Per-rule delivery settings

The dashboard reads `GET /plugins/signalk-alert-rules/rules` with the existing
Signal K session cookie. It displays every listed rule, including never-fired,
disabled and invalid rules. Opening Alert Center, refreshing it or returning to
its browser tab refreshes the catalog; other dashboard reloads reuse it for up
to 15 seconds. No background server polling, additional token or access to the
rules plugin's private files is needed. Read permission is sufficient to view
the catalog; saving delivery settings requires read/write permission.

Rule discovery is a read-only dashboard operation. It does not create database
occurrences, history, delivery work, audio or wake requests. Never-fired rules
without saved settings are assembled into the list from the catalog and global
delivery defaults. A definition becomes durable when its settings are saved or
an alert is observed. The `/definitions` API lists durable definitions; the full
rule catalog remains owned by Alert Rules. `/policy-defaults` supplies effective
global defaults for the dashboard's never-fired entries.

Policies use `rule:signalk-alert-rules:<slug>` as identity. Saving a never-fired
rule's policy includes its validated `rule` descriptor in the existing
`PATCH /definitions/{id}/policy` request. The definition and custom policy are
stored transactionally. A native alert belongs to that rule only when its core
`$source` is `signalk-alert-rules` and its `data.rule` identifies the slug. This
uses the producer's published identity contract rather than guessing from paths.
The adapter is tested with rules commit
`5f6fbb9d32e8e47e614ab11fab81b2bcae90424e`.

Every instance of a wildcard rule shares its delivery settings. Each keeps its
own core ID, local occurrence, history and delivery attempts. Newly discovered
instances receive the saved rule policy even after restart and with the browser
closed. Policy edits apply to future occurrences; pending delivery work retains
its existing policy. Rules without custom settings inherit global defaults.
Native producers without this rule identity continue to use path-based policies.
Legacy notification policies remain separate and are not migrated.

Rule names and paths shown from the catalog follow edits in Alert Rules; delivery
settings follow the stable slug even if its alert path changes. Disabling a rule
is distinct from disabling delivery. Detection, thresholds and rule enablement
stay in Alert Rules, linked from the detail drawer. Invalid rules can have
settings prepared but cannot produce alerts until fixed in Alert Rules.

Unavailable catalogs and permission failures are shown explicitly. Previously
stored definitions, policies and queued work are preserved. A rule removed from
the catalog is labelled as no longer listed when the catalog is available; its
stored data is not automatically deleted. Recreating the same slug reuses its
saved settings. Use Remove stored alert when it is inactive if those settings
and its stored history should be discarded. Definitions already recorded by an
earlier development build under a native path are retained; no historical
reparenting or automatic policy transfer is performed.

## Terminal removal reasons

Terminal deltas now carry `clearReason`: `condition` and `acknowledged` confirm
lifecycle completion and permit recovery delivery. `displaced` means a more
urgent alert took the slot in core's active set; it never confirms recovery,
even though the terminal snapshot has `condition: false` and a `clearedAt`.
Alert Center retains the reason in its source payload and history, labels the
occurrence as displaced, cancels pending acknowledgment/recovery actions and
repeats, and preserves queued initial remote delivery. An initial notification
sent after displacement explains that recovery is unconfirmed. Reasons and
pending work survive restart without another database migration.

Missing or unknown reasons remain unclassified unless an observed condition
return (`rtn-unacknowledged`) or a successful terminal acknowledgment through
Alert Center supplies independent confirmation. This also covers removals
missed while Alert Center was stopped. Core history replay/removal-reason
lookups remain deferred; absence from the active list does not prove recovery.

## Message units

Alert Rules owns the text it generates. Alert Center preserves that text in the
dashboard, history and every delivery service, including Wyoming speech, without
sampling or converting numbers in it again. This prevents a temperature difference
or another intentionally SI value from being interpreted as an absolute reading.
Legacy zone messages and other notification producers retain the existing
metadata-based conversion.

The tested rules commit includes hatlabs/signalk-alert-rules#195. On a compatible
server it formats messages using the admin's unit preset, with documented SI
fallbacks (including object fields and unsupported conversions). That is one
producer-formatted message for all recipients, not recipient-specific conversion.
Changing the preset affects subsequent rule messages; it does not rewrite retained
history or queued delivery snapshots.

## Verification

The ordinary suite and Docker acceptance environment cover the stable legacy
server:

```sh
npm run format:check
npm run lint
npm test
npm run test:acceptance
docker compose -f docker-compose.acceptance.yml down -v
npm run test:browser
```

For core acceptance, build the pinned server and rules plugin checkouts in
separate directories with Node 22 or 24 as described by upstream, then run:

```sh
SIGNALK_CORE_SERVER_DIR=/absolute/path/to/signalk-server \
SIGNALK_ALERT_RULES_DIR=/absolute/path/to/signalk-alert-rules npm run test:core
```

The test verifies the exact upstream commit, creates its own temporary config and
database, starts the real server on a temporary loopback port and sends only to
local mock notifiers. It covers canonical deltas, silence expiry, condition
return, acknowledgment, grouped momentary alerts, independent notifier success
and retries, process restart, terminal removal reasons and displacement at the
real active-set cap. It stops the server and
removes its temporary data on completion. It also creates a real wildcard rule,
saves delivery settings before it fires, feeds isolated sensor values, verifies
first delivery and a new instance after restart, and acknowledges a returned
rule alert. A temperature rule checks upstream display units and preservation
of a literal temperature difference through delivery. It does not change `~/.signalk`.
