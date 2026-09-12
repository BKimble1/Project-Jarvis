CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blockers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"severity" text DEFAULT 'medium' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"resolution_requirement" text,
	"requires_owner_decision" boolean DEFAULT false NOT NULL,
	"provenance" text DEFAULT 'manual' NOT NULL,
	"source_system" text DEFAULT 'manual' NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"decision" text NOT NULL,
	"reasoning" text,
	"decided_on" text,
	"supersedes_decision_id" uuid,
	"provenance" text DEFAULT 'manual' NOT NULL,
	"source_system" text DEFAULT 'manual' NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid,
	"kind" text NOT NULL,
	"source_system" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"url" text,
	"observed_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"success_definition" text,
	"status" text DEFAULT 'open' NOT NULL,
	"target_date" text,
	"provenance" text DEFAULT 'manual' NOT NULL,
	"source_system" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"what_changed" text NOT NULL,
	"current_work" text,
	"problems_or_risks" text,
	"proposed_next_action" text,
	"occurred_on" text,
	"source_system" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'planned' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"target_date" text,
	"completed_at" timestamp with time zone,
	"provenance" text DEFAULT 'manual' NOT NULL,
	"source_system" text DEFAULT 'manual' NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"due_date" text,
	"requires_owner" boolean DEFAULT false NOT NULL,
	"provenance" text DEFAULT 'manual' NOT NULL,
	"source_system" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"redirect_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"label" text,
	"github_repo_id" integer,
	"github_owner" text,
	"github_repo" text,
	"github_url" text,
	"github_visibility" text,
	"github_default_branch" text,
	"github_archived" boolean DEFAULT false NOT NULL,
	"github_primary_language" text,
	"github_last_activity_at" timestamp with time zone,
	"external_url" text,
	"sync_status" text DEFAULT 'never' NOT NULL,
	"last_sync_ok_at" timestamp with time zone,
	"last_sync_failed_at" timestamp with time zone,
	"last_sync_error" text,
	"available_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unavailable_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"description" text,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"phase" text,
	"goal" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"target_date" text,
	"icon" text,
	"color" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_manual_update_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"freshness" text DEFAULT 'never' NOT NULL,
	"needs_attention" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_text" text NOT NULL,
	"intent" text NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"github_login" text,
	"github_user_id" text,
	"display_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent_hash" text
);
--> statement-breakpoint
CREATE TABLE "status_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"phase" text,
	"headline" text NOT NULL,
	"recently_completed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_work" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decisions_needed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attention" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"freshness" jsonb NOT NULL,
	"unknowns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary_method" text NOT NULL,
	"fingerprint" text NOT NULL,
	"narrative" jsonb
);
--> statement-breakpoint
CREATE TABLE "sync_locks" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"holder" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"source_id" uuid,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"evidence_written" integer DEFAULT 0 NOT NULL,
	"category_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"rate_limit_remaining" integer,
	"rate_limit_limit" integer,
	"rate_limit_reset_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_project_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."project_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_updates" ADD CONSTRAINT "manual_updates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_actions" ADD CONSTRAINT "next_actions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_history" ADD CONSTRAINT "query_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_snapshots" ADD CONSTRAINT "status_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_locks" ADD CONSTRAINT "sync_locks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_source_id_project_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."project_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_project_created_idx" ON "activity_log" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_created_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_log_kind_idx" ON "activity_log" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "blockers_project_id_idx" ON "blockers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "blockers_active_idx" ON "blockers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "blockers_requires_decision_idx" ON "blockers" USING btree ("requires_owner_decision");--> statement-breakpoint
CREATE INDEX "decisions_project_id_idx" ON "decisions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_identity_idx" ON "evidence" USING btree ("project_id","source_system","kind","external_id");--> statement-breakpoint
CREATE INDEX "evidence_project_observed_idx" ON "evidence" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "evidence_kind_idx" ON "evidence" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "evidence_source_id_idx" ON "evidence" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "goals_project_id_idx" ON "goals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "manual_updates_project_id_idx" ON "manual_updates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "manual_updates_created_at_idx" ON "manual_updates" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "milestones_project_id_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "milestones_state_idx" ON "milestones" USING btree ("state");--> statement-breakpoint
CREATE INDEX "next_actions_project_id_idx" ON "next_actions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "next_actions_status_idx" ON "next_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "next_actions_due_date_idx" ON "next_actions" USING btree ("due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_hash_idx" ON "oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "project_sources_project_id_idx" ON "project_sources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_sources_kind_idx" ON "project_sources" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "project_sources_github_unique_idx" ON "project_sources" USING btree (lower("github_owner"),lower("github_repo")) WHERE "project_sources"."kind" = 'github_repo';--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_type_idx" ON "projects" USING btree ("type");--> statement-breakpoint
CREATE INDEX "projects_archived_at_idx" ON "projects" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "projects_needs_attention_idx" ON "projects" USING btree ("needs_attention");--> statement-breakpoint
CREATE INDEX "projects_updated_at_idx" ON "projects" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "projects_freshness_idx" ON "projects" USING btree ("freshness");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_unique_idx" ON "projects" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "query_history_created_idx" ON "query_history" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "status_snapshots_project_generated_idx" ON "status_snapshots" USING btree ("project_id","generated_at");--> statement-breakpoint
CREATE INDEX "status_snapshots_fingerprint_idx" ON "status_snapshots" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE INDEX "sync_locks_expires_at_idx" ON "sync_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sync_runs_project_started_idx" ON "sync_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");