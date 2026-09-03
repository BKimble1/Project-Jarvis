CREATE TABLE IF NOT EXISTS "ci_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid,
	"task_id" uuid,
	"project_id" uuid,
	"purpose" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"workflow_file" text NOT NULL,
	"ref" text NOT NULL,
	"commit_sha" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inputs_fingerprint" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"refusal_rule" text,
	"refusal_reason" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"external_run_id" text,
	"external_run_url" text,
	"conclusion" text,
	"stage_report" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "display_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"location" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rotation_seconds" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_seen_user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"graph_version" integer NOT NULL,
	"plan_version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_review_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"key" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"evidence" text NOT NULL,
	"file" text,
	"line" integer,
	"component" text,
	"violates" text,
	"reproduction" text,
	"recommendation" text NOT NULL,
	"confidence" text NOT NULL,
	"blocks_delivery" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"triage_rule" text,
	"owner_decision" text,
	"resolved_by_task_id" uuid,
	"repair_round" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"graph_version" integer NOT NULL,
	"plan_version" integer NOT NULL,
	"reviewer_role" text NOT NULL,
	"verdict" text NOT NULL,
	"proposed_verdict" text,
	"override_rule" text,
	"override_reason" text,
	"summary" text NOT NULL,
	"diff_fingerprint" text NOT NULL,
	"reviewed_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repair_round" integer DEFAULT 0 NOT NULL,
	"cold_context" boolean DEFAULT true NOT NULL,
	"unavailable_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_task_graphs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"plan_version" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"playbook_key" text,
	"playbook_version" integer,
	"summary" text NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"max_parallel_tasks" integer DEFAULT 3 NOT NULL,
	"max_write_tasks" integer DEFAULT 1 NOT NULL,
	"max_repair_rounds" integer DEFAULT 2 NOT NULL,
	"proposed_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"graph_version" integer NOT NULL,
	"plan_version" integer NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"role" text NOT NULL,
	"permission_profile_id" text NOT NULL,
	"task_type" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"expected_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_outputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspace_requirement" text DEFAULT 'none' NOT NULL,
	"requires_repository" boolean DEFAULT true NOT NULL,
	"expected_file_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"declared_write_set" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actual_changed_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assigned_worker_id" uuid,
	"active_run_id" uuid,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"max_turns" integer,
	"time_limit_ms" bigint,
	"max_output_tokens" bigint,
	"usage_input_tokens" bigint,
	"usage_output_tokens" bigint,
	"usage_cost_usd" double precision,
	"usage_turns" integer,
	"usage_duration_ms" bigint,
	"reviews_task_id" uuid,
	"repair_round" integer DEFAULT 0 NOT NULL,
	"latest_review_id" uuid,
	"branch_name" text,
	"base_sha" text,
	"head_sha" text,
	"workspace_path" text,
	"workspace_preserved" boolean DEFAULT true NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_write_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playbook_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"playbook_key" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_app_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" text DEFAULT 'ios' NOT NULL,
	"app_name" text,
	"bundle_identifier" text,
	"sku" text,
	"team_identifier_reference" text,
	"app_category" text,
	"primary_color" text,
	"icon_state" text DEFAULT 'none' NOT NULL,
	"subscription_model" text DEFAULT 'not_applicable' NOT NULL,
	"storekit_product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_widget" boolean DEFAULT false NOT NULL,
	"requires_app_group" boolean DEFAULT false NOT NULL,
	"app_group_identifier" text,
	"requires_notifications" boolean DEFAULT false NOT NULL,
	"privacy_sensitive_apis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"website_repository" text,
	"website_domain" text,
	"support_url" text,
	"privacy_url" text,
	"terms_url" text,
	"testflight_workflow" text,
	"signing_secret_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid,
	"project_id" uuid NOT NULL,
	"kind" text DEFAULT 'testflight' NOT NULL,
	"repository_full_name" text NOT NULL,
	"workflow_file" text NOT NULL,
	"ref" text NOT NULL,
	"commit_sha" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"identity" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"bundle_identifier" text,
	"build_number" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"superseded_reason" text,
	"dispatch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "mission_runs_attempt_idx";--> statement-breakpoint
ALTER TABLE "mission_runs" ADD COLUMN IF NOT EXISTS "task_id" uuid;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD COLUMN IF NOT EXISTS "role" text;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD COLUMN IF NOT EXISTS "permission_profile_id" text;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD COLUMN IF NOT EXISTS "repair_round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "current_graph_version" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "approved_graph_version" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "playbook_key" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "playbook_version" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "integration_branch" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "repair_rounds_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "receipt_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_task_id_mission_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."mission_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ci_dispatches" ADD CONSTRAINT "ci_dispatches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_receipts" ADD CONSTRAINT "mission_receipts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_review_findings" ADD CONSTRAINT "mission_review_findings_review_id_mission_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."mission_reviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_review_findings" ADD CONSTRAINT "mission_review_findings_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_task_id_mission_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."mission_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_task_dependencies" ADD CONSTRAINT "mission_task_dependencies_graph_id_mission_task_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."mission_task_graphs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_task_dependencies" ADD CONSTRAINT "mission_task_dependencies_task_id_mission_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."mission_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_task_dependencies" ADD CONSTRAINT "mission_task_dependencies_depends_on_task_id_mission_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."mission_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_task_graphs" ADD CONSTRAINT "mission_task_graphs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_graph_id_mission_task_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."mission_task_graphs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_assigned_worker_id_workers_id_fk" FOREIGN KEY ("assigned_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_write_leases" ADD CONSTRAINT "mission_write_leases_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mission_write_leases" ADD CONSTRAINT "mission_write_leases_task_id_mission_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."mission_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_app_profiles" ADD CONSTRAINT "project_app_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ci_dispatches_idempotency_idx" ON "ci_dispatches" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ci_dispatches_mission_idx" ON "ci_dispatches" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ci_dispatches_state_idx" ON "ci_dispatches" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ci_dispatches_requested_idx" ON "ci_dispatches" USING btree ("requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "display_devices_token_hash_idx" ON "display_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "display_devices_revoked_idx" ON "display_devices" USING btree ("revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_receipts_version_idx" ON "mission_receipts" USING btree ("mission_id","graph_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_receipts_mission_idx" ON "mission_receipts" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_review_findings_key_idx" ON "mission_review_findings" USING btree ("review_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_review_findings_mission_idx" ON "mission_review_findings" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_review_findings_state_idx" ON "mission_review_findings" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_review_findings_severity_idx" ON "mission_review_findings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_reviews_mission_idx" ON "mission_reviews" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_reviews_task_idx" ON "mission_reviews" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_reviews_verdict_idx" ON "mission_reviews" USING btree ("verdict");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_task_dependencies_edge_idx" ON "mission_task_dependencies" USING btree ("task_id","depends_on_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_task_dependencies_graph_idx" ON "mission_task_dependencies" USING btree ("graph_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_task_graphs_version_idx" ON "mission_task_graphs" USING btree ("mission_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_task_graphs_mission_idx" ON "mission_task_graphs" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_task_graphs_state_idx" ON "mission_task_graphs" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_tasks_key_idx" ON "mission_tasks" USING btree ("graph_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_tasks_mission_idx" ON "mission_tasks" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_tasks_graph_idx" ON "mission_tasks" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_tasks_state_idx" ON "mission_tasks" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_tasks_worker_idx" ON "mission_tasks" USING btree ("assigned_worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_tasks_role_idx" ON "mission_tasks" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_write_leases_task_idx" ON "mission_write_leases" USING btree ("task_id") WHERE state = 'held';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_write_leases_mission_idx" ON "mission_write_leases" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "playbook_versions_version_idx" ON "playbook_versions" USING btree ("playbook_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_versions_key_idx" ON "playbook_versions" USING btree ("playbook_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "playbooks_key_idx" ON "playbooks" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_app_profiles_project_idx" ON "project_app_profiles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_approvals_project_idx" ON "release_approvals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_approvals_state_idx" ON "release_approvals" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_approvals_identity_idx" ON "release_approvals" USING btree ("identity") WHERE state = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_runs_task_attempt_idx" ON "mission_runs" USING btree ("task_id","attempt") WHERE task_id is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_runs_task_idx" ON "mission_runs" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_runs_attempt_idx" ON "mission_runs" USING btree ("mission_id","attempt","kind") WHERE task_id is null;