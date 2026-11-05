-- The place is picked from a country list and, for Japan and the US, a prefecture or state list.
-- `place` stays: it holds the label the letters and the DJ use, and the free text of older rows.
ALTER TABLE listeners ADD COLUMN place_country TEXT;
ALTER TABLE listeners ADD COLUMN place_region TEXT;
