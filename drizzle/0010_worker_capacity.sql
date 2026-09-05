ALTER TABLE "workers" ADD COLUMN "capacity_auth_mode" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_subscription_type" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_rate_limits_applicable" boolean;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_five_hour_percent" double precision;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_five_hour_resets_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_seven_day_percent" double precision;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_seven_day_resets_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_seven_day_opus_percent" double precision;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_seven_day_opus_resets_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_context_used_tokens" integer;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_context_max_tokens" integer;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_context_percent" double precision;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_context_over_limit" boolean;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_using_overage" boolean;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_source" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capacity_observed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workers_capacity_observed_idx" ON "workers" USING btree ("capacity_observed_at");