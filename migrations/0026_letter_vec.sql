-- A letter's own vector (its work's metadata and its text, bge-m3, Int8 like items.vec): public letters and 一言 only.
ALTER TABLE letters ADD COLUMN vec BLOB;
-- A work's vector mixed with the mean of its public letters' vectors; NULL while it has none (readers fall back to vec).
ALTER TABLE items ADD COLUMN vec_mix BLOB;
