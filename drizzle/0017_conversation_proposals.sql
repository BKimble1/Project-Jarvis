CREATE TABLE "conversation_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"idea" text NOT NULL,
	"summary" text NOT NULL,
	"evaluation" jsonb,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_v1" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"project_id" uuid,
	"mission_id" uuid,
	"repository_full_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "conversation_proposals_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
ALTER TABLE "conversation_proposals" ADD CONSTRAINT "conversation_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_proposals" ADD CONSTRAINT "conversation_proposals_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_proposals_state_idx" ON "conversation_proposals" USING btree ("state","updated_at");
