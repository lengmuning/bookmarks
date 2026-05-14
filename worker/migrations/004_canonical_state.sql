-- Canonical bookmark state.
-- Primary key is (pair_id, url): tenant isolation + URL identity.
-- A URL is unique only within a single sync group (pair); different pairs
-- with the same URL are independent rows.

CREATE TABLE IF NOT EXISTS bookmark_state (
  pair_id     TEXT NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT,
  folder_path TEXT NOT NULL DEFAULT '[]',
  idx         INTEGER,
  removed     INTEGER NOT NULL DEFAULT 0,
  last_actor  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (pair_id, url)
);

CREATE INDEX IF NOT EXISTS idx_state_pair_updated ON bookmark_state(pair_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_state_pair_active  ON bookmark_state(pair_id, removed);
