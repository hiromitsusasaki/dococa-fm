-- An episode is made in the listener's language: the DJ's lines, the letters' renderings and the voice follow it.
ALTER TABLE episodes ADD COLUMN lang TEXT NOT NULL DEFAULT 'ja';
