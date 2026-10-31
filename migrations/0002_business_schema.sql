-- Час — Unix milliseconds UTC. Каталог оферів лишається конфігом.
-- Фізичні FK не каскадні; історичні знімки можуть пережити джерело.
CREATE TABLE users (
  user_id TEXT PRIMARY KEY NOT NULL,
  preferred_gender TEXT CHECK (preferred_gender IN ('women', 'men')),
  preferred_ethnicity TEXT CHECK (preferred_ethnicity IN ('asia', 'europe', 'latam')),
  email TEXT,
  email_confirmed_at INTEGER,
  created_at INTEGER,
  last_active_at INTEGER,
  selection_revision INTEGER NOT NULL DEFAULT 0 CHECK (selection_revision >= 0),
  access_secret_hash TEXT UNIQUE CHECK (
    access_secret_hash IS NULL OR (length(access_secret_hash) = 64 AND access_secret_hash NOT GLOB '*[^0-9a-f]*')
  ),
  revoked_at INTEGER,
  expired_at INTEGER,
  CHECK ((email IS NULL) = (email_confirmed_at IS NULL)),
  CHECK (email IS NULL OR length(CAST(email AS BLOB)) <= 254),
  CHECK (
    (expired_at IS NULL AND created_at IS NOT NULL AND created_at >= 0
      AND last_active_at IS NOT NULL AND last_active_at >= created_at AND access_secret_hash IS NOT NULL)
    OR (expired_at IS NOT NULL AND expired_at >= 0 AND created_at IS NULL AND last_active_at IS NULL
      AND preferred_gender IS NULL AND preferred_ethnicity IS NULL AND email IS NULL
      AND access_secret_hash IS NULL AND revoked_at IS NULL)
  )
) STRICT;
CREATE INDEX users_activity ON users(last_active_at) WHERE expired_at IS NULL;
CREATE INDEX users_email_retention ON users(email_confirmed_at) WHERE email IS NOT NULL;

CREATE TABLE events (
  event_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('funnel_entered', 'question_viewed', 'answer_confirmed', 'offer_transition', 'Lead', 'Purchase')),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  preland_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  question_id TEXT CHECK (question_id IN ('preferred_gender', 'preferred_ethnicity', 'email')),
  click_id TEXT,
  offer_id TEXT,
  flow_mode TEXT CHECK (flow_mode IN ('quiz', 'bypass')),
  entry_event_id TEXT REFERENCES events(event_id) ON DELETE RESTRICT,
  view_event_id TEXT REFERENCES events(event_id) ON DELETE RESTRICT,
  completion_event_id TEXT REFERENCES events(event_id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 4096),
  CHECK (
    (event_type = 'funnel_entered' AND question_id IS NULL AND entry_event_id IS NULL AND view_event_id IS NULL)
    OR (event_type = 'question_viewed' AND question_id IS NOT NULL AND entry_event_id IS NOT NULL AND view_event_id IS NULL)
    OR (event_type = 'answer_confirmed' AND question_id IS NOT NULL AND entry_event_id IS NULL AND view_event_id IS NOT NULL)
    OR (event_type = 'offer_transition' AND question_id IS NULL AND entry_event_id IS NOT NULL AND view_event_id IS NULL)
    OR (event_type IN ('Lead', 'Purchase') AND question_id IS NULL AND entry_event_id IS NULL AND view_event_id IS NULL)
  ),
  CHECK (
    (event_type IN ('offer_transition', 'Lead', 'Purchase') AND click_id IS NOT NULL AND offer_id IS NOT NULL)
    OR (event_type IN ('funnel_entered', 'question_viewed', 'answer_confirmed') AND click_id IS NULL AND offer_id IS NULL)
  ),
  CHECK (
    (event_type = 'offer_transition' AND flow_mode IS NOT NULL AND
      ((flow_mode = 'quiz' AND completion_event_id IS NOT NULL) OR (flow_mode = 'bypass' AND completion_event_id IS NULL)))
    OR (event_type != 'offer_transition' AND flow_mode IS NULL AND completion_event_id IS NULL)
  )
) STRICT;
CREATE INDEX events_report_entry ON events(event_type, occurred_at, preland_id, user_id);
CREATE INDEX events_user_time ON events(user_id, occurred_at);
CREATE INDEX events_retention ON events(received_at);
CREATE INDEX events_click ON events(click_id);
CREATE INDEX events_entry ON events(entry_event_id);
CREATE INDEX events_view ON events(view_event_id);
CREATE INDEX events_completion ON events(completion_event_id);

CREATE TABLE clicks (
  click_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  offer_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  preland_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  offer_name_snapshot TEXT NOT NULL CHECK (length(CAST(offer_name_snapshot AS BLOB)) BETWEEN 1 AND 256),
  target_url_snapshot TEXT NOT NULL CHECK (length(CAST(target_url_snapshot AS BLOB)) BETWEEN 1 AND 2048),
  catalog_version TEXT NOT NULL CHECK (length(catalog_version) = 64 AND catalog_version NOT GLOB '*[^0-9a-f]*'),
  flow_mode TEXT NOT NULL CHECK (flow_mode IN ('quiz', 'bypass')),
  entry_event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
  completion_event_id TEXT REFERENCES events(event_id) ON DELETE RESTRICT,
  CHECK ((flow_mode = 'quiz' AND completion_event_id IS NOT NULL) OR (flow_mode = 'bypass' AND completion_event_id IS NULL))
) STRICT;
CREATE INDEX clicks_user ON clicks(user_id, created_at);
CREATE INDEX clicks_retention ON clicks(created_at);
CREATE INDEX clicks_entry ON clicks(entry_event_id);
CREATE INDEX clicks_completion ON clicks(completion_event_id);

-- Ключ і незмінна атрибуція переживають видалені ClickID та events.
CREATE TABLE partner_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  partner_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('Lead', 'Purchase')),
  partner_event_id TEXT NOT NULL CHECK (length(partner_event_id) BETWEEN 1 AND 128),
  click_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  offer_id TEXT NOT NULL,
  preland_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  amount_minor INTEGER,
  currency TEXT,
  UNIQUE (partner_id, event_type, partner_event_id),
  CHECK ((amount_minor IS NULL AND currency IS NULL) OR
    (event_type = 'Purchase' AND amount_minor IS NOT NULL AND currency IS NOT NULL
      AND amount_minor BETWEEN 1 AND 1000000 AND currency = 'USD'))
) STRICT;
CREATE INDEX partner_events_user ON partner_events(user_id);
CREATE INDEX partner_events_click ON partner_events(click_id);
CREATE INDEX partner_events_retention ON partner_events(received_at);

CREATE TABLE user_offer_leads (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  offer_id TEXT NOT NULL,
  latest_lead_at INTEGER NOT NULL CHECK (latest_lead_at >= 0),
  PRIMARY KEY (user_id, offer_id)
) STRICT;

CREATE TABLE request_results (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expired INTEGER NOT NULL DEFAULT 0 CHECK (expired IN (0, 1)),
  operation_type TEXT CHECK (operation_type IN ('entry', 'question_view', 'answer', 'email_confirmation', 'offer_selection')),
  request_fingerprint TEXT,
  fingerprint_key_version TEXT,
  fingerprint_format_version INTEGER,
  result_json TEXT,
  PRIMARY KEY (user_id, operation_id),
  CHECK (
    (expired = 0 AND operation_type IS NOT NULL AND request_fingerprint IS NOT NULL
      AND length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
      AND fingerprint_key_version IS NOT NULL AND length(fingerprint_key_version) > 0
      AND fingerprint_format_version IS NOT NULL AND fingerprint_format_version > 0
      AND result_json IS NOT NULL AND json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 4096)
    OR (expired = 1 AND operation_type IS NULL AND request_fingerprint IS NULL
      AND fingerprint_key_version IS NULL AND fingerprint_format_version IS NULL AND result_json IS NULL)
  )
) STRICT;
CREATE INDEX request_results_expiry ON request_results(created_at) WHERE expired = 0;

CREATE TABLE event_delivery (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_flight', 'delivered')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  delivered_at INTEGER,
  last_error_code TEXT,
  CHECK (
    (status = 'pending' AND next_attempt_at IS NOT NULL AND lease_token IS NULL AND lease_until IS NULL AND delivered_at IS NULL)
    OR (status = 'in_flight' AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND delivered_at IS NULL)
    OR (status = 'delivered' AND next_attempt_at IS NULL AND lease_token IS NULL AND lease_until IS NULL AND delivered_at IS NOT NULL)
  )
) STRICT;
CREATE INDEX delivery_pending ON event_delivery(next_attempt_at, event_id) WHERE status = 'pending';
CREATE INDEX delivery_leases ON event_delivery(lease_until, event_id) WHERE status = 'in_flight';

CREATE TABLE mock_received_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 4096),
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0)
) STRICT;

CREATE TABLE capacity_control (
  budget_key TEXT PRIMARY KEY NOT NULL CHECK (budget_key IN ('undelivered', 'events', 'profiles', 'command_keys')),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  capacity_paused INTEGER NOT NULL DEFAULT 0 CHECK (capacity_paused IN (0, 1)),
  capacity_epoch INTEGER NOT NULL DEFAULT 0 CHECK (capacity_epoch >= 0)
) STRICT;
INSERT INTO capacity_control (budget_key) VALUES ('undelivered'), ('events'), ('profiles'), ('command_keys');

CREATE TABLE system_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  integrity_paused INTEGER NOT NULL DEFAULT 0 CHECK (integrity_paused IN (0, 1)),
  history_unverified INTEGER NOT NULL DEFAULT 0 CHECK (history_unverified IN (0, 1)),
  history_available_from INTEGER
) STRICT;
-- Початок обліку визначить перший бізнес-запис, не дата міграції.
INSERT INTO system_control (singleton_id) VALUES (1);
