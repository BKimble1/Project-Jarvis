-- Reminders: the one schedule kind whose content is Blake's own, and the only one he can finish.
--
-- Three columns, each answering a question the existing shape could not:
--
--  * `on_date` — which single local day a `once` schedule fires on. Stored as the local date
--    string rather than as an instant, because "the 14th" is a wall-clock fact and comparing
--    instants puts it on the wrong day for anyone far enough from UTC. The time of day still comes
--    from `hour`/`minute`, so a one-time reminder inherits the same DST policy as everything else.
--
--  * `snoozed_until` — held, but coming back. Deliberately not `paused_at`: pausing is a decision
--    to stop, snoozing is a promise to return, and an interface that showed one as the other would
--    be describing a delay as a decision.
--
--  * `completed_at` — dealt with. Only reminders can be completed, and a completed one is kept
--    rather than deleted, because "did I ever get round to that" is a question the record should
--    be able to answer.
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "on_date" text;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
--> statement-breakpoint
-- The tick reads enabled, unfinished schedules on every pass, so it should not read every row.
CREATE INDEX IF NOT EXISTS "schedules_open_idx" ON "schedules" USING btree ("enabled", "completed_at");
