-- Preferences that belong to the app rather than to one project.
--
-- The first new table since Phase 0. Every phase until now used something already
-- reserved - `tasks`, `sessions.kind`, `memory_entries`, `sessions.role` - and there
-- was no reserved home for this, because Phase 0 did not anticipate it.
--
-- Key-value rather than a column per setting, which is the lesson of the four phases
-- above read the other way round: a shape decided now is a shape a later phase has to
-- migrate. A new preference is a new key, and the typed surface lives in Rust where
-- changing it costs nothing.
CREATE TABLE app_settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
