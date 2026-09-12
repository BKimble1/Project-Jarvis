CREATE TABLE "reasoning_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"request_key" text NOT NULL,
	"proposal_id" uuid,
	"conversation_id" text,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"result" jsonb,
	"failure" text,
	"failure_detail" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reasoning_requests_request_key_unique" UNIQUE("request_key")
);
--> statement-breakpoint
ALTER TABLE "reasoning_requests" ADD CONSTRAINT "reasoning_requests_proposal_id_conversation_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."conversation_proposals"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "reasoning_requests_claim_idx" ON "reasoning_requests" USING btree ("state","lease_expires_at");
--> statement-breakpoint
CREATE INDEX "reasoning_requests_proposal_idx" ON "reasoning_requests" USING btree ("proposal_id");
