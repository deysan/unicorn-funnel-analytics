-- Окремо від reference: A може прострочитися без зміни selection_revision.
ALTER TABLE transaction_assertions ADD COLUMN selection_ok INTEGER NOT NULL
  DEFAULT 1 CONSTRAINT guard_selection CHECK (selection_ok = 1);
