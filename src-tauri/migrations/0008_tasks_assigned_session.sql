-- Idle review and the board's assignment join look up tasks by the session
-- that holds them. 0001 only indexed (project_id, status).
CREATE INDEX idx_tasks_assigned_session_id ON tasks (assigned_session_id);
