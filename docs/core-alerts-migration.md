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
`ae7f8684514c96cbca9208a3da3c1e8440840021` in
`hatlabs/signalk-server`, branch `feat/alerts-plugin-surface`. This remains a
development API; it is not a promise of compatibility with an eventual release.
The narrow compatibility types in `src/signalk/core-alerts.ts` follow that
commit because the supported published `@signalk/server-api` lacks these exports.
Replace them with upstream types when published.

## Identity and state

| Core fact                                  | Alert Center behavior                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Core alert ID                              | Stored separately from the local occurrence/delivery IDs; one local occurrence per core ID                                       |
| Condition path                             | Delivery policy belongs to `alerts.<path>`, separate from any legacy `notifications.<path>` policy                               |
| Producer `$source`                         | Preserved from the alert itself; the outer `alertsApi` publisher is not treated as the producer                                  |
| `caution`, `warning`, `alarm`, `emergency` | Mapped to existing `alert`, `warn`, `alarm`, `emergency` delivery severities                                                     |
| `rtn-unacknowledged`                       | Remains visible/actionable; condition return cancels activation and wake requests, stops repeats, and records confirmed recovery |
| Latching/momentary alert                   | Retained despite `condition:false`; repeated raises under one core ID remain grouped, with fresh delivery cycles                 |
| Stale/offline producer                     | Shown as stale, never interpreted as condition recovery                                                                          |
| Acknowledge/silence                        | Calls core by ID, awaits confirmation, and records failures without a false local success                                        |
| Core silence                               | Pauses/cancels Wyoming audio; remote notifier delivery remains independent; core unsilence resumes audio                         |

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
record of what it observed. Core alerts are discovered on first observation;
importing never-fired rule definitions and migrating legacy policy paths require
separate explicit mappings. Core latching semantics take precedence over the
legacy one-time policy for native alerts. Keep equivalent legacy producers and
new rules from both raising the same physical condition during a test cutover.

## Deferred removal classification

The pending question for Matti remains outside this migration. A terminal
`normal` snapshot alone does not distinguish normal lifecycle completion from
displacement. Alert Center records an unclassified removal and sends no automatic
recovery for it. This includes genuine caution clears and clear-after-acknowledge
transitions until classification is implemented. An observed condition return
(`rtn-unacknowledged`) or a successful terminal acknowledgment through Alert
Center supplies independent confirmation. Core history replay/removal-reason
lookups are not implemented here.

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

For the core server, build the pinned checkout in a separate directory with Node
22 or 24 as described by upstream, then run:

```sh
SIGNALK_CORE_SERVER_DIR=/absolute/path/to/signalk-server npm run test:core
```

The test verifies the exact upstream commit, creates its own temporary config and
database, starts the real server on a temporary loopback port and sends only to
local mock notifiers. It covers canonical deltas, silence expiry, condition
return, acknowledgment, grouped momentary alerts, independent notifier success
and retries, process restart and unclassified removals. It stops the server and
removes its temporary data on completion. It does not change `~/.signalk`.
