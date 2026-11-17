-- 1 while published_at is only YouTube's "3 weeks ago" from the channel page; enrichment replaces it with the exact date.
ALTER TABLE videos ADD COLUMN date_approx INTEGER NOT NULL DEFAULT 0;
