-- A work's embedding (Workers AI bge-m3, 1024 dims) as an Int8-quantised unit vector, 1024 bytes. Made from the work's
-- public metadata only (title, creator, year, kind); NULL until made. Used to choose, never shown.
ALTER TABLE items ADD COLUMN vec BLOB;
