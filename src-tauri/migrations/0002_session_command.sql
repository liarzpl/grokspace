-- Restarting a session has to know what it was running, and a pane whose
-- session has ended should be able to say how it ended.
--
-- SQLite cannot add a CHECK constraint to an existing table, so `kind` is
-- validated in Rust rather than by the schema.

ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'grok';

ALTER TABLE sessions ADD COLUMN exit_code INTEGER;
