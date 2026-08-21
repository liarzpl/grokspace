-- Allow/Deny need the options the agent listed: Allow is only `allow_once`, and
-- `allow_always` is a separate named chip rather than a silent fallback.
ALTER TABLE session_permissions ADD COLUMN options TEXT NOT NULL DEFAULT '[]';
