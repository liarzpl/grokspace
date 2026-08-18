-- Pending ACP permission prompts must survive a webview reload: the agent is
-- still blocked, and `needs_input` without a request id has nothing to Allow.
CREATE TABLE session_permissions (
    session_id TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    request_id INTEGER NOT NULL,
    summary    TEXT    NOT NULL,
    PRIMARY KEY (session_id, request_id)
);
