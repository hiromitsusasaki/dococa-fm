-- Readings for the cloud voice (Japanese only): the written title, creator and talk stay on screen, the voice says the reading.
-- items.reading_ja: JSON { "title"?: "...", "creator"?: "..." } in katakana, or NULL.
ALTER TABLE items ADD COLUMN reading_ja TEXT;
-- units.readings: JSON [{ "text": "PSY", "reading": "サイ" }], or NULL.
ALTER TABLE units ADD COLUMN readings TEXT;
