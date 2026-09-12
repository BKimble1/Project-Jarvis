-- When a notification was read out loud, so it is never read out twice.
--
-- The same watermark `operating_events.spoken_at` uses, and for the same reason: the browser claims
-- what it is about to say by writing this column, so a refresh, a second tab, or a phone picked up
-- mid-sentence all find nothing left to claim. Without it the morning briefing is re-read aloud
-- every time the dashboard loads.
--
-- Stamped at creation time for anything produced inside quiet hours. That is the whole quiet-hours
-- rule in one field: the row exists and is on the dashboard, and nothing says it.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "spoken_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_unspoken_idx" ON "notifications" USING btree ("spoken_at", "created_at");
