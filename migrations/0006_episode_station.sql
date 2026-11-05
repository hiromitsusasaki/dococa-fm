-- Which station an episode was made on: `world`, `mine`, or `public:<ownerId>`. Older rows were made on `mine`.
ALTER TABLE episodes ADD COLUMN station TEXT NOT NULL DEFAULT 'mine';
CREATE INDEX idx_episodes_listener_station ON episodes (listener_id, station, created_at);
