-- Різні причини відмови: epoch перевіряється перед місткістю.
ALTER TABLE transaction_assertions ADD COLUMN control_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_control CHECK (control_ok = 1);
ALTER TABLE transaction_assertions ADD COLUMN integrity_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_integrity CHECK (integrity_ok = 1);
ALTER TABLE transaction_assertions ADD COLUMN epoch_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_epoch CHECK (epoch_ok = 1);
ALTER TABLE transaction_assertions ADD COLUMN undelivered_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_capacity_undelivered CHECK (undelivered_ok = 1);
ALTER TABLE transaction_assertions ADD COLUMN events_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_capacity_events CHECK (events_ok = 1);
ALTER TABLE transaction_assertions ADD COLUMN profiles_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_capacity_profiles CHECK (profiles_ok = 1);
ALTER TABLE transaction_assertions ADD COLUMN command_keys_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_capacity_command_keys CHECK (command_keys_ok = 1);
