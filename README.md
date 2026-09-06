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
