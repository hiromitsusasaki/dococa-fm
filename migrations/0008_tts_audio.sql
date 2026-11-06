-- One row per clip synthesized, so the daily cap counts paid calls. The clip itself is in R2 under `key`.
CREATE TABLE tts_audio (
  key TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  voice TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tts_audio_created ON tts_audio (created_at);
