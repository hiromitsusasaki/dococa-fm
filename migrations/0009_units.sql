-- The DJ's talk for one letter in one language, made once and reused by every programme that reads the letter.
CREATE TABLE units (
  letter_id TEXT NOT NULL REFERENCES letters (id),
  lang TEXT NOT NULL,
  intro TEXT NOT NULL,
  after TEXT NOT NULL,
  verified INTEGER NOT NULL,
  audio_ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (letter_id, lang)
);
