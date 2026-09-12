ALTER TABLE "usage_records" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "attempt" integer;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "cache_write_tokens" bigint;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "context_used_tokens" integer;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "context_max_tokens" integer;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "capacity_five_hour_percent" double precision;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "capacity_seven_day_percent" double precision;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;