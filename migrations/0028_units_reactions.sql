-- How many 私も a unit had been written with. A 私も remakes the unit only when it is the first one, or when the senders
-- reach 3 places for the first time; this count tells which of the two a unit has already had.
ALTER TABLE units ADD COLUMN reactions_seen INTEGER NOT NULL DEFAULT 0;
