CREATE TABLE "operator_leases" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_leases_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "operator_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"project_id" uuid,
	"source" text NOT NULL,
	"rule" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"severity" text NOT NULL,
	"provenance" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mission_type" text,
	"requires_owner" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"band" text DEFAULT 'watch' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mission_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text
);
--> statement-breakpoint
CREATE TABLE "operator_ticks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"mode" text NOT NULL,
	"outcome" text DEFAULT 'observed' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"projects_observed" integer DEFAULT 0 NOT NULL,
	"opportunities_found" integer DEFAULT 0 NOT NULL,
	"missions_started" integer DEFAULT 0 NOT NULL,
	"coverage" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_opportunities" ADD CONSTRAINT "operator_opportunities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_opportunities" ADD CONSTRAINT "operator_opportunities_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_leases_expires_idx" ON "operator_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_opportunities_key_idx" ON "operator_opportunities" USING btree ("key");--> statement-breakpoint
CREATE INDEX "operator_opportunities_state_idx" ON "operator_opportunities" USING btree ("state","band");--> statement-breakpoint
CREATE INDEX "operator_opportunities_project_idx" ON "operator_opportunities" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "operator_opportunities_seen_idx" ON "operator_opportunities" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "operator_ticks_started_idx" ON "operator_ticks" USING btree ("started_at");