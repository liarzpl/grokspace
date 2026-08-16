-- Phase 0 creates every table from the GrokSpace data model, not just `projects`.
-- The later phases only add rows and queries, so reserving the shape now avoids
-- reshaping the schema underneath live databases in Phase 1-3.

CREATE TABLE projects (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    path        TEXT    NOT NULL UNIQUE,
    last_opened INTEGER,
    settings    TEXT    NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_projects_last_opened ON projects (last_opened DESC);

CREATE TABLE tasks (
    id                  TEXT    PRIMARY KEY,
    project_id          TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title               TEXT    NOT NULL,
    description         TEXT,
    status              TEXT    NOT NULL CHECK (status IN ('backlog', 'in_progress', 'review', 'done')),
    assigned_session_id TEXT,
    priority            INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_tasks_project_status ON tasks (project_id, status);

CREATE TABLE sessions (
    id            TEXT    PRIMARY KEY,
    project_id    TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    pane_id       TEXT,
    process_id    INTEGER,
    status        TEXT    NOT NULL CHECK (status IN ('idle', 'running', 'needs_input', 'stopped')),
    title         TEXT,
    role          TEXT,
    worktree_path TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_sessions_project ON sessions (project_id);

CREATE TABLE memory_entries (
    project_id TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    key        TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    type       TEXT    NOT NULL CHECK (type IN ('note', 'decision', 'context', 'artifact')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, key)
);
