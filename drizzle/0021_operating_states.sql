CREATE TABLE IF NOT EXISTS "operating_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"state" text DEFAULT 'captured' NOT NULL,
	"project_id" uuid,
	"mission_id" uuid,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operating_states_proposal_id_unique" UNIQUE("proposal_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operating_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operating_state_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"project_id" uuid,
	"mission_id" uuid,
	"kind" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"message" text NOT NULL,
	"spoken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operating_states" ADD CONSTRAINT "operating_states_proposal_id_conversation_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."conversation_proposals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operating_states" ADD CONSTRAINT "operating_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operating_states" ADD CONSTRAINT "operating_states_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operating_events" ADD CONSTRAINT "operating_events_operating_state_id_operating_states_id_fk" FOREIGN KEY ("operating_state_id") REFERENCES "public"."operating_states"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operating_events_proposal_idx" ON "operating_events" USING btree ("proposal_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operating_events_unspoken_idx" ON "operating_events" USING btree ("spoken_at","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operating_states_state_idx" ON "operating_states" USING btree ("state","updated_at");
