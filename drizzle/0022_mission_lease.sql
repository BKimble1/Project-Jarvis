ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "missions_lease_idx" ON "missions" USING btree ("lease_expires_at");
