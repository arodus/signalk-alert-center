/** Clean occurrence-based schema. The repository is pre-release, so there is no
 * compatibility layer for the discarded prototype schema. */
export const currentSchemaVersion = 1;

export const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_definitions (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  path_pattern TEXT NOT NULL,
  name TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_policies (
  definition_id TEXT PRIMARY KEY REFERENCES alert_definitions(id) ON DELETE CASCADE,
  enabled INTEGER,
  minimum_severity TEXT,
  connectivity_json TEXT,
  one_time INTEGER,
  activation_delay_seconds INTEGER,
  rearm_after_seconds INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_policy_notifiers (
  definition_id TEXT NOT NULL REFERENCES alert_definitions(id) ON DELETE CASCADE,
  transport_instance_id TEXT NOT NULL,
  PRIMARY KEY (definition_id, transport_instance_id)
);

CREATE TABLE IF NOT EXISTS alert_occurrences (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES alert_definitions(id),
  occurrence_number INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  source_timestamp TEXT,
  received_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  cleared_at TEXT,
  current_state TEXT NOT NULL,
  current_severity TEXT NOT NULL,
  max_severity TEXT NOT NULL,
  message TEXT,
  source_payload_json TEXT,
  notification_id TEXT,
  acknowledged_at TEXT,
  silenced_at TEXT,
  dismissed_at TEXT,
  activation_due_at TEXT,
  activation_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_key, occurrence_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS occurrence_active_source_idx
  ON alert_occurrences(source_key) WHERE current_state = 'active';
CREATE INDEX IF NOT EXISTS occurrence_history_idx
  ON alert_occurrences(started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS occurrence_activation_idx
  ON alert_occurrences(activation_state, activation_due_at);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id TEXT NOT NULL REFERENCES alert_occurrences(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS alert_events_history_idx
  ON alert_events(alert_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS occurrence_notifiers (
  alert_id TEXT NOT NULL REFERENCES alert_occurrences(id) ON DELETE CASCADE,
  transport_instance_id TEXT NOT NULL,
  PRIMARY KEY (alert_id, transport_instance_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alert_occurrences(id),
  transport_instance_id TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  delivered_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  remote_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(alert_id, transport_instance_id)
);

CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  remote_id TEXT,
  UNIQUE(delivery_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS wake_requests (
  alert_id TEXT PRIMARY KEY REFERENCES alert_occurrences(id) ON DELETE CASCADE,
  wake_due_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connectivity_sessions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT,
  started_by_plugin INTEGER,
  state TEXT NOT NULL,
  observed_switch_on INTEGER,
  wake_due_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
`;
