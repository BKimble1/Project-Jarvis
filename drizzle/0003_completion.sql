CREATE TABLE IF NOT EXISTS "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"scope" text NOT NULL,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headline" text NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"considered" jsonb NOT NULL,
	"method" text NOT NULL,
	"rejection_rule" text,
	"rejection_reason" text,
	"mission_suggestion" jsonb,
	"saved_view" text,
	"duration_ms" integer,
	"asked_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"subject_kind" text,
	"subject_id" text,
	"project_id" uuid,
	"mission_id" uuid,
	"outcome" text NOT NULL,
	"rule" text,
	"summary" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"previous_hash" text,
	"hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"execution_id" uuid,
	"project_id" uuid,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"content" jsonb NOT NULL,
	"narration" jsonb,
	"narration_rule" text,
	"method" text DEFAULT 'deterministic' NOT NULL,
	"is_quiet" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"previous_limit_usd" double precision,
	"new_limit_usd" double precision,
	"approved_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"target_id" text,
	"target_label" text,
	"limit_usd" double precision,
	"limit_output_tokens" bigint,
	"warn_at_percent" integer DEFAULT 80 NOT NULL,
	"kind" text DEFAULT 'warning' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"reset_period" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" text NOT NULL,
	"state" text DEFAULT 'disabled' NOT NULL,
	"project_id" uuid,
	"credential_configured" boolean DEFAULT false NOT NULL,
	"credential_identity" text,
	"credential_rotated_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_message" text,
	"rate_limited_until" timestamp with time zone,
	"enabled_at" timestamp with time zone,
	"enabled_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deletion_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason" text NOT NULL,
	"item_count" integer DEFAULT 1 NOT NULL,
	"requested_by" text NOT NULL,
	"scrubbed_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"project_id" uuid,
	"ordinal" integer NOT NULL,
	"locator" text NOT NULL,
	"heading" text,
	"text" text NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("heading", '') || ' ' || "text")) STORED
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"left_id" uuid NOT NULL,
	"right_id" uuid,
	"project_id" uuid,
	"summary" text NOT NULL,
	"detected_rule" text NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"category" text NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"status_rule" text,
	"statement" text NOT NULL,
	"detail" text,
	"project_id" uuid,
	"mission_id" uuid,
	"source_id" uuid,
	"source_ref" text,
	"excerpts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"review_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"supersedes_id" uuid,
	"superseded_by_id" uuid,
	"superseded_reason" text,
	"rejected_reason" text,
	"forgotten_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"confidence" text,
	"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "statement" || ' ' || coalesce("detail", ''))) STORED
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"origin" text NOT NULL,
	"project_id" uuid,
	"content_hash" text NOT NULL,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_type" text,
	"unit_count" integer,
	"body_text" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"retain_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_qualification_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"run_id" uuid NOT NULL,
	"mission_id" uuid,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_name" text,
	"model_name" text,
	"repository_full_name" text NOT NULL,
	"commit_sha" text,
	"branch_name" text,
	"pull_request_url" text,
	"pull_request_number" integer,
	"findings_count" integer,
	"output_tokens" bigint,
	"duration_ms" bigint,
	"qualification_version" text NOT NULL,
	"summary" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_name" text NOT NULL,
	"provider_name" text,
	"input_per_million_usd" double precision NOT NULL,
	"output_per_million_usd" double precision NOT NULL,
	"cached_input_per_million_usd" double precision,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"failure_message" text,
	"suppressed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"category" text PRIMARY KEY NOT NULL,
	"channels" jsonb DEFAULT '["in_app"]'::jsonb NOT NULL,
	"min_severity" text DEFAULT 'low' NOT NULL,
	"digest" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"project_id" uuid,
	"mission_id" uuid,
	"href" text,
	"dedupe_key" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_hash" text NOT NULL,
	"endpoint" text NOT NULL,
	"key_p256dh" text NOT NULL,
	"key_auth" text NOT NULL,
	"label" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qualification_check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"waived_reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qualification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" text DEFAULT 'built' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"started_by" text NOT NULL,
	"build_ref" text,
	"assumptions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"superseded_at" timestamp with time zone,
	"qualification_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qualification_suite_results" (
	"kind" text PRIMARY KEY NOT NULL,
	"passed" boolean DEFAULT false NOT NULL,
	"build_ref" text,
	"detail" text NOT NULL,
	"test_count" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedule_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"occurrence_at" timestamp with time zone NOT NULL,
	"occurrence_local" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"evidence_window_from" timestamp with time zone,
	"evidence_window_to" timestamp with time zone,
	"result_id" uuid,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cadence" text NOT NULL,
	"hour" integer NOT NULL,
	"minute" integer DEFAULT 0 NOT NULL,
	"time_zone" text NOT NULL,
	"weekday" integer,
	"day_of_month" integer,
	"project_id" uuid,
	"catch_up" text DEFAULT 'run_latest' NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"instruction" text,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_occurrence_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"provider_name" text,
	"model_name" text,
	"mission_id" uuid,
	"task_id" uuid,
	"run_id" uuid,
	"project_id" uuid,
	"repository_full_name" text,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cached_input_tokens" bigint,
	"reported_cost_usd" double precision,
	"estimated_cost_usd" double precision,
	"cost_basis" text DEFAULT 'unknown' NOT NULL,
	"duration_ms" bigint,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"failure_code" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'recording' NOT NULL,
	"transcript" text,
	"edited_transcript" text,
	"intent" text,
	"project_id" uuid,
	"duration_ms" integer,
	"byte_size" bigint,
	"provider_name" text,
	"confidence" double precision,
	"failure_code" text,
	"failure_message" text,
	"audio_retained" boolean DEFAULT false NOT NULL,
	"audio_delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"result_kind" text,
	"result_id" uuid
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "briefings" ADD CONSTRAINT "briefings_execution_id_schedule_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."schedule_executions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "briefings" ADD CONSTRAINT "briefings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "budget_overrides" ADD CONSTRAINT "budget_overrides_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "connectors" ADD CONSTRAINT "connectors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_conflicts" ADD CONSTRAINT "knowledge_conflicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "live_qualification_evidence" ADD CONSTRAINT "live_qualification_evidence_run_id_qualification_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."qualification_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "live_qualification_evidence" ADD CONSTRAINT "live_qualification_evidence_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notifications" ADD CONSTRAINT "notifications_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "qualification_check_results" ADD CONSTRAINT "qualification_check_results_run_id_qualification_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."qualification_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "schedule_executions" ADD CONSTRAINT "schedule_executions_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_task_id_mission_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."mission_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "voice_captures" ADD CONSTRAINT "voice_captures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answers_generated_idx" ON "answers" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answers_scope_idx" ON "answers" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_events_id_idx" ON "audit_events" USING btree ("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_actor_idx" ON "audit_events" USING btree ("actor");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefings_created_idx" ON "briefings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefings_kind_idx" ON "briefings" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefings_project_idx" ON "briefings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_overrides_budget_idx" ON "budget_overrides" USING btree ("budget_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_overrides_expires_idx" ON "budget_overrides" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budgets_scope_target_idx" ON "budgets" USING btree ("scope","target_id") WHERE target_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budgets_scope_global_idx" ON "budgets" USING btree ("scope") WHERE target_id is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budgets_enabled_idx" ON "budgets" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connectors_scoped_idx" ON "connectors" USING btree ("connector_id","project_id") WHERE project_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connectors_global_idx" ON "connectors" USING btree ("connector_id") WHERE project_id is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connectors_state_idx" ON "connectors" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_receipts_subject_idx" ON "deletion_receipts" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_receipts_created_idx" ON "deletion_receipts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_ordinal_idx" ON "knowledge_chunks" USING btree ("source_id","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_source_idx" ON "knowledge_chunks" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_project_idx" ON "knowledge_chunks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_search_idx" ON "knowledge_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_conflicts_pair_idx" ON "knowledge_conflicts" USING btree ("left_id","right_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_conflicts_state_idx" ON "knowledge_conflicts" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_conflicts_left_idx" ON "knowledge_conflicts" USING btree ("left_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_status_idx" ON "knowledge_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_scope_idx" ON "knowledge_items" USING btree ("scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_category_idx" ON "knowledge_items" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_project_idx" ON "knowledge_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_source_idx" ON "knowledge_items" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_review_idx" ON "knowledge_items" USING btree ("review_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_search_idx" ON "knowledge_items" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_sources_hash_idx" ON "knowledge_sources" USING btree ("content_hash") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_project_idx" ON "knowledge_sources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_state_idx" ON "knowledge_sources" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_kind_idx" ON "knowledge_sources" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_qualification_evidence_run_idx" ON "live_qualification_evidence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_qualification_evidence_kind_idx" ON "live_qualification_evidence" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_prices_model_idx" ON "model_prices" USING btree ("model_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_deliveries_channel_idx" ON "notification_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_deliveries_state_idx" ON "notification_deliveries" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_dedupe_open_idx" ON "notifications" USING btree ("dedupe_key") WHERE acknowledged_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_category_idx" ON "notifications" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_unread_idx" ON "notifications" USING btree ("read_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_revoked_idx" ON "push_subscriptions" USING btree ("revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "qualification_check_results_run_check_idx" ON "qualification_check_results" USING btree ("run_id","check_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qualification_check_results_check_idx" ON "qualification_check_results" USING btree ("check_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qualification_runs_started_idx" ON "qualification_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qualification_runs_level_idx" ON "qualification_runs" USING btree ("level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_buckets_window_idx" ON "rate_limit_buckets" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "schedule_executions_idempotency_idx" ON "schedule_executions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_executions_schedule_idx" ON "schedule_executions" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_executions_state_idx" ON "schedule_executions" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_executions_occurrence_idx" ON "schedule_executions" USING btree ("occurrence_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_enabled_idx" ON "schedules" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_kind_idx" ON "schedules" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_project_idx" ON "schedules" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_records_idempotency_idx" ON "usage_records" USING btree ("idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_occurred_idx" ON "usage_records" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_mission_idx" ON "usage_records" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_task_idx" ON "usage_records" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_project_idx" ON "usage_records" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_model_idx" ON "usage_records" USING btree ("model_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_captures_created_idx" ON "voice_captures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_captures_state_idx" ON "voice_captures" USING btree ("state");