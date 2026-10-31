-- D-162: рядок перевірки вставляється й видаляється в одному batch.
-- Невиконана умова має дати 0; відсутні дані не можуть прибрати INSERT.
CREATE TABLE transaction_assertions (
  assertion_id TEXT PRIMARY KEY NOT NULL,
  revision_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_revision CHECK (revision_ok = 1),
  access_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_access CHECK (access_ok = 1),
  reference_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_reference CHECK (reference_ok = 1),
  capacity_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_capacity CHECK (capacity_ok = 1),
  effects_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT guard_effects CHECK (effects_ok = 1)
);
