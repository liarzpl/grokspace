-- Isolation skip used to live only on the event bus. A reload then lost the
-- reason and the banner fell back to a generic sentence.
ALTER TABLE sessions ADD COLUMN isolation_skip TEXT;
