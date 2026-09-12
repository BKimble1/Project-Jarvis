CREATE TABLE "authorization_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid,
	"outcome" text NOT NULL,
	"mode" text NOT NULL,
	"qualification_level" text NOT NULL,
	"charter_version_id" uuid,
	"charter_digest" text,
	"verdicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_spend_usd" numeric(12, 4),
	"summary" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operating_charters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"digest" text NOT NULL,
	"authored_by" text NOT NULL,
	"note" text,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"charter_id" uuid,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "authorization_decisions" ADD CONSTRAINT "authorization_decisions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_state" ADD CONSTRAINT "operator_state_charter_id_operating_charters_id_fk" FOREIGN KEY ("charter_id") REFERENCES "public"."operating_charters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authorization_decisions_mission_idx" ON "authorization_decisions" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "authorization_decisions_outcome_idx" ON "authorization_decisions" USING btree ("outcome","decided_at");--> statement-breakpoint
CREATE INDEX "authorization_decisions_charter_idx" ON "authorization_decisions" USING btree ("charter_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_charters_version_idx" ON "operating_charters" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_charters_active_idx" ON "operating_charters" USING btree ("superseded_at") WHERE "operating_charters"."superseded_at" is null and "operating_charters"."activated_at" is not null;--> statement-breakpoint
CREATE INDEX "operating_charters_digest_idx" ON "operating_charters" USING btree ("digest");