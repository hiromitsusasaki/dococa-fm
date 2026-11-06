-- YouTube searches made from the send page's title search, one row per JST day, so one account cannot spend the day's quota.
CREATE TABLE youtube_searches (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
