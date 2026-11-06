-- Paid syntheses per row: a key synthesized again (its put failed, or its clip was lost) adds one, so the
-- daily cap counts every paid call, not only distinct keys.
ALTER TABLE tts_audio ADD COLUMN synth_count INTEGER NOT NULL DEFAULT 1;
