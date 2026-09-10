/** Clean occurrence-based schema. The repository is pre-release, so there is no
 * compatibility layer for the discarded prototype schema. */
export const currentSchemaVersion = 4;

export const migrations: Array<{ version: number; sql: string }> = [
  {
    version: 2,
    sql: `
ALTER TABLE alert_occurrences ADD COLUMN source TEXT;
UPDATE alert_occurrences
SET source = CASE
  WHEN source_key LIKE path || '@%' THEN substr(source_key, length(path) + 2)
  ELSE NULL
END;
CREATE INDEX occurrence_path_history_idx
  ON alert_occurrences(path, started_at DESC, id DESC);
CREATE INDEX occurrence_source_history_idx
  ON alert_occurrences(source, started_at DESC, id DESC);
`,
  },
  {
    version: 3,
    sql: `
CREATE INDEX deliveries_service_state_idx
  ON deliveries(transport_instance_id, state, next_attempt_at);
CREATE INDEX deliveries_service_success_idx
  ON deliveries(transport_instance_id, delivered_at DESC);
CREATE INDEX delivery_attempts_finished_idx
  ON delivery_attempts(finished_at DESC, id DESC);
`,
  },
  {
    version: 4,
    sql: `
ALTER TABLE alert_policies ADD COLUMN audio_policy_json TEXT;
CREATE TABLE audio_playbacks (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL UNIQUE REFERENCES alert_occurrences(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  sound TEXT NOT NULL,
  minimum_severity TEXT NOT NULL,
  mode TEXT NOT NULL,
  repeat_interval_seconds INTEGER NOT NULL,
  stop_on_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  next_play_at TEXT,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX audio_playbacks_due_idx
  ON audio_playbacks(state, next_play_at, created_at);
CREATE TABLE audio_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playback_id TEXT NOT NULL REFERENCES audio_playbacks(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(playback_id, attempt_number)
);
`,
  },
];

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
  one_time INTEGER NOT NULL DEFAULT 0,
  minimum_severity TEXT NOT NULL DEFAULT 'normal',
  activation_delay_seconds INTEGER NOT NULL DEFAULT 0,
  rearm_after_seconds INTEGER,
  connectivity_json TEXT NOT NULL DEFAULT '{"mode":"queue"}',
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
CREATE INDEX IF NOT EXISTS occurrence_definition_history_idx
  ON alert_occurrences(definition_id, started_at DESC, updated_at DESC);
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

CREATE TABLE IF NOT EXISTS occurrence_notifier_thresholds (
  alert_id TEXT NOT NULL REFERENCES alert_occurrences(id) ON DELETE CASCADE,
  transport_instance_id TEXT NOT NULL,
  minimum_severity TEXT NOT NULL DEFAULT 'normal',
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
