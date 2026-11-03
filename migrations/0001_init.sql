CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  creator TEXT NOT NULL,
  year INTEGER,
  image_url TEXT,
  preview_url TEXT,
  out_links TEXT NOT NULL DEFAULT '{}',
  external_ids TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE listeners (
  id TEXT PRIMARY KEY,
  radio_name TEXT NOT NULL,
  place TEXT NOT NULL,
  voice TEXT NOT NULL,
  dial REAL NOT NULL DEFAULT 0.3,
  lang TEXT NOT NULL DEFAULT 'ja',
  mcp_token TEXT NOT NULL,
  spotify_refresh_token TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_listeners_mcp_token ON listeners (mcp_token);

CREATE TABLE letters (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items (id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  body_ja TEXT NOT NULL,
  lang TEXT NOT NULL,
  radio_name TEXT NOT NULL,
  place TEXT NOT NULL,
  year INTEGER,
  listener_id TEXT REFERENCES listeners (id),
  parent_letter_id TEXT REFERENCES letters (id),
  source_url TEXT,
  source_author TEXT,
  status TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_letters_item_status_created ON letters (item_id, status, created_at);
CREATE INDEX idx_letters_listener ON letters (listener_id);

CREATE TABLE history (
  listener_id TEXT NOT NULL REFERENCES listeners (id),
  item_id TEXT NOT NULL REFERENCES items (id),
  source TEXT NOT NULL,
  occurred_at TEXT,
  PRIMARY KEY (listener_id, item_id)
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  listener_id TEXT NOT NULL REFERENCES listeners (id),
  segments TEXT NOT NULL,
  verified INTEGER NOT NULL,
  report TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_episodes_listener_created ON episodes (listener_id, created_at);

CREATE TABLE reports (
  letter_id TEXT NOT NULL REFERENCES letters (id),
  listener_id TEXT REFERENCES listeners (id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE takedowns (
  url TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
