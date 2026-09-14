-- Folder trust for setup scripts and project hooks. Keyed by canonical
-- path in this ~/.grokspace database, not the project tree. Forgetting a
-- project does not delete these rows.
CREATE TABLE trusted_folders (
    path TEXT PRIMARY KEY NOT NULL,
    trusted_at INTEGER NOT NULL
);
