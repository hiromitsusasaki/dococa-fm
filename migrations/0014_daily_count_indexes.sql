-- The daily caps count today's rows (LETTER_GLOBAL_DAILY_LIMIT on letters, UNIT_DAILY_LIMIT on units) by created_at.
CREATE INDEX IF NOT EXISTS letters_created_at ON letters(created_at);
CREATE INDEX IF NOT EXISTS units_created_at ON units(created_at);
