-- Works that come from YouTube are videos, not music. Existing rows stored as music move over by their YouTube id or link.
UPDATE items SET kind = 'video'
WHERE kind = 'music' AND (external_ids LIKE '%"youtube"%' OR out_links LIKE '%youtube.com%' OR out_links LIKE '%youtu.be%');
