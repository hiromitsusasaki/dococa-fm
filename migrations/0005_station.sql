-- Google identity, the public station, the display language and the import rank.
ALTER TABLE listeners ADD COLUMN google_sub TEXT;
ALTER TABLE listeners ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE listeners ADD COLUMN station_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listeners ADD COLUMN station_slug TEXT;
ALTER TABLE history ADD COLUMN rank INTEGER;
ALTER TABLE letters ADD COLUMN body_en TEXT;
CREATE UNIQUE INDEX idx_listeners_google_sub ON listeners(google_sub);
CREATE UNIQUE INDEX idx_listeners_station_slug ON listeners(station_slug);
