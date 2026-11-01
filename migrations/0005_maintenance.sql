-- Тільки службові підсумки: без payload, адрес або секретів.
CREATE TABLE maintenance_control (
 singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
 cron_token TEXT,
 cron_first_attempt_at INTEGER,
 cron_attempt_at INTEGER,
 cron_success_at INTEGER,
 cron_result TEXT,
 cron_errors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cron_errors_json)),
 cleanup_at INTEGER,
 cleanup_json TEXT,
 last_ack_at INTEGER,
 reconcile_hour INTEGER,
 reconcile_token TEXT,
 reconcile_attempt_at INTEGER,
 reconcile_read_at INTEGER,
 reconcile_status TEXT,
 reconcile_json TEXT
) STRICT;
INSERT INTO maintenance_control (singleton_id) VALUES (1);

-- Stable raw-key windows: the cursor advances before dependency checks/mutations.
CREATE TABLE cleanup_cursors (
 phase TEXT PRIMARY KEY NOT NULL,
 after_key TEXT NOT NULL DEFAULT '',
 after_subkey TEXT NOT NULL DEFAULT ''
) STRICT;
INSERT INTO cleanup_cursors (phase) VALUES ('profiles'), ('email'), ('results'), ('clicks'),
 ('events'), ('partner_keys'), ('mock_keys'), ('command_keys'), ('user_keys');
-- Minute-level error counts must not walk delivered history.
CREATE INDEX delivery_current_errors ON event_delivery(last_error_code)
 WHERE last_error_code IS NOT NULL AND status != 'delivered';
