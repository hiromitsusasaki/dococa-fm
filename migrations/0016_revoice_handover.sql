-- The hand-over line of every letter changes text (the place is said as "lives in"), so the units are voiced
-- again. Existing clips stay in tts_audio and are cache hits for any line whose text did not change.
UPDATE units SET audio_ready = 0;
