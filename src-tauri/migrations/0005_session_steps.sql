-- A session's working list, distinct from the project board. Grok proposes
-- steps before it works; the user edits and approves; afterwards the file may
-- only flip status. CASCADE with the session so a restart starts clean.
ALTER TABLE sessions ADD COLUMN steps_phase TEXT NOT NULL DEFAULT 'none'
    CHECK (steps_phase IN ('none', 'proposed', 'approved'));

CREATE TABLE session_steps (
    id         TEXT    PRIMARY KEY,
    session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    sort_index INTEGER NOT NULL,
    title      TEXT    NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('pending', 'doing', 'done', 'skipped')),
    origin     TEXT    NOT NULL CHECK (origin IN ('agent', 'user')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_session_steps_session ON session_steps (session_id, sort_index);
