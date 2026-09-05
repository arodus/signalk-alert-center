# Signal K Persistent Notifier

An offline-first Signal K plugin for durable alert delivery through ntfy, PagerDuty, and Discord. Alerts and independent per-notifier delivery rows are stored in SQLite before any network or switch operation.

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
    "idleCooldownSeconds": 300
  }
}
```

Repeated updates coalesce by notification path. Clear events retain the original occurrence and maximum severity. Each notifier retries independently; a successful notifier is never resent because another notifier failed. `wake_after` requests are persisted per alert and restored after restart. Connectivity is only switched off when the plugin observed it off before waking it and owns the session. Unknown ownership leaves it on.

The plugin API is mounted by Signal K under `/plugins/signalk-persistent-notifier`:

- `GET /status`
- `GET /alerts`
- `GET /deliveries`
- `POST /retry`

Signal K protects these routes with its normal plugin authentication. The status response includes queue counts, connectivity state, switch state, ownership, and the last connectivity error.

The included operational dashboard is served by Signal K at `/signalk-persistent-notifier`. It shows active alerts, cleared-alert history, per-transport delivery state, connectivity ownership, refresh status, and a manual retry action.

## Development

`npm test` runs the lifecycle and connectivity tests. `npm run format:check`, `npm run lint`, and `npm run build` are the required quality checks. The plugin entry point wires the Signal K subscription, durable delivery engine, connectivity manager, and authenticated plugin routes.
