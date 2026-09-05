CREATE TABLE "mission_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"opportunity_key" text,
	"observed_problem" text NOT NULL,
	"expected_benefit" text NOT NULL,
	"benefit_kind" text NOT NULL,
	"why_now" text NOT NULL,
	"estimated_effort" text NOT NULL,
	"verification_plan" text NOT NULL,
	"success_signal" text NOT NULL,
	"signal_before" text,
	"observed_at" timestamp with time zone,
	"signal_after" text,
	"verdict" text,
	"verdict_rule" text,
	"verdict_note" text,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_outcomes_mission_id_unique" UNIQUE("mission_id")
);
--> statement-breakpoint
ALTER TABLE "mission_outcomes" ADD CONSTRAINT "mission_outcomes_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_outcomes_verdict_idx" ON "mission_outcomes" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX "mission_outcomes_created_idx" ON "mission_outcomes" USING btree ("created_at");