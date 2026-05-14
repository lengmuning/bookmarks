CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY,
  code_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  browser TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pair_id) REFERENCES pairs(id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  bookmark_id TEXT NOT NULL,
  title TEXT,
  url TEXT,
  parent_id TEXT,
  folder_path TEXT,
  idx INTEGER,
  action TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (pair_id) REFERENCES pairs(id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_pair ON bookmarks(pair_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_devices_pair ON devices(pair_id);
