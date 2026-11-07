-- v4 audio keys: the prompt-reading guard was re-calibrated and the English prompt changed (2026-11-07).
DELETE FROM tts_audio;
UPDATE units SET audio_ready = 0;
