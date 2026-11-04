-- One row while a line is being synthesized, so concurrent requests for the same uncached line make one paid call.
CREATE TABLE tts_claims (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
