-- The DJ's line before a far work on the listener's own radio, written once per listener, work and language and
-- reused. Only verified lines are stored; `spoken` is what the Japanese voice says (readings applied), or NULL.
-- created_at also counts the lines made per JST day toward BRIDGE_DAILY_LIMIT.
CREATE TABLE bridges (
  listener_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  spoken TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (listener_id, item_id, lang)
);
CREATE INDEX bridges_created_at ON bridges (created_at);
