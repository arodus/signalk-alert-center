export const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, cleared_at TEXT,
  current_state TEXT NOT NULL, current_severity TEXT NOT NULL, max_severity TEXT NOT NULL,
  message TEXT, source_payload_json TEXT, fire_count INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT, removed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT NOT NULL REFERENCES alerts(id),
  event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES alerts(id),
  transport_instance_id TEXT NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, last_attempt_at TEXT, delivered_at TEXT,
  last_error_code TEXT, last_error_message TEXT, remote_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(alert_id, transport_instance_id)
);
CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS wake_requests (
  alert_id TEXT PRIMARY KEY REFERENCES alerts(id) ON DELETE CASCADE,
  wake_due_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connectivity_sessions (
  id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT, started_by_plugin INTEGER,
  state TEXT NOT NULL, observed_switch_on INTEGER, wake_due_at TEXT, last_error TEXT, updated_at TEXT NOT NULL
);
`;
