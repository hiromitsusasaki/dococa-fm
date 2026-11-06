-- Every clip so far was made before the guard against Gemini-TTS reading the style prompt aloud, so the
-- audio key moves to tts/v3/ and the units are voiced again. The old rows go (the day's count restarts);
-- the v2 objects in R2 are orphaned and may be deleted by hand.
DELETE FROM tts_audio;
UPDATE units SET audio_ready = 0;
