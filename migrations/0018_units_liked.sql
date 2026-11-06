-- The owner's thumbs-up on a unit: liked, verified intros are shown to the DJ as examples of style and length.
ALTER TABLE units ADD COLUMN liked INTEGER NOT NULL DEFAULT 0;
