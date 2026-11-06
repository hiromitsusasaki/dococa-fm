-- A letter keeps the sender's place codes, so a screen can show the place in the reader's language.
-- `place` stays: it is the Japanese label the DJ reads. Older letters have no codes and show `place`.
ALTER TABLE letters ADD COLUMN place_country TEXT;
ALTER TABLE letters ADD COLUMN place_region TEXT;
