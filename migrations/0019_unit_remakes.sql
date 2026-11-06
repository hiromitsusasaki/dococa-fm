-- One row per unit made today and then removed by the owner's remake, so the replacement still counts toward UNIT_DAILY_LIMIT.
CREATE TABLE unit_remakes (
  letter_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX unit_remakes_created_at ON unit_remakes (created_at);
