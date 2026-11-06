-- What a listener actually heard: one row per letter, written when the player starts that letter's line.
CREATE TABLE listens (
  listener_id TEXT NOT NULL REFERENCES listeners (id),
  episode_id TEXT NOT NULL REFERENCES episodes (id),
  letter_id TEXT NOT NULL REFERENCES letters (id),
  segment_index INTEGER NOT NULL,
  heard_at TEXT NOT NULL,
  PRIMARY KEY (listener_id, letter_id)
);
CREATE INDEX idx_listens_listener_heard ON listens (listener_id, heard_at);
