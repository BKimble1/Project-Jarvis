ALTER TABLE "reasoning_requests" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "reasoning_requests" ADD COLUMN "manual_retries" integer DEFAULT 0 NOT NULL;
