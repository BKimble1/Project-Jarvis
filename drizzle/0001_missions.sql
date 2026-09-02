CREATE TABLE "mission_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_version" integer NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_risk_level" text NOT NULL,
	"approved_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "mission_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"project_id" uuid,
	"run_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content_type" text DEFAULT 'text/markdown' NOT NULL,
	"content" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"topic" text NOT NULL,
	"question" text NOT NULL,
	"why" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommendation" text,
	"rule" text NOT NULL,
	"answer" text,
	"answer_provenance" text,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mission_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_message" text,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"run_id" uuid,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"actor" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_permission_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"requested_action" text NOT NULL,
	"reason" text NOT NULL,
	"risk" text DEFAULT 'medium' NOT NULL,
	"if_approved" text NOT NULL,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_note" text,
	"answer" text
);
--> statement-breakpoint
CREATE TABLE "mission_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"author" text NOT NULL,
	"provenance" text DEFAULT 'inferred' NOT NULL,
	"risk_level" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"fingerprint" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'starting' NOT NULL,
	"plan_version" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"agent_session_id" text,
	"runtime_name" text,
	"runtime_version" text,
	"workspace_path" text,
	"base_branch" text,
	"base_sha" text,
	"branch_name" text,
	"head_sha" text,
	"pull_request_url" text,
	"pull_request_number" integer,
	"files_changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_input_tokens" bigint,
	"usage_output_tokens" bigint,
	"usage_cache_read_tokens" bigint,
	"usage_cost_usd" double precision,
	"usage_turns" integer,
	"usage_duration_ms" bigint,
	"failure_code" text,
	"failure_message" text,
	"current_action" text,
	"workspace_preserved" boolean DEFAULT true NOT NULL,
	"last_event_seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"command" text NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"exit_code" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" bigint,
	"output_excerpt" text,
	"mission_related" boolean,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"owner_login" text,
	"raw_request" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"risk_level" text NOT NULL,
	"risk_rule_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_date" text,
	"source_id" uuid,
	"repository_owner" text,
	"repository_name" text,
	"base_branch" text,
	"working_branch" text,
	"base_sha" text,
	"pull_request_url" text,
	"pull_request_number" integer,
	"active_run_id" uuid,
	"claimed_by_worker_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"current_plan_version" integer,
	"approved_plan_version" integer,
	"execution_override_at" timestamp with time zone,
	"execution_override_reason" text,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"do_not_touch" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deliverable" text,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cancellation_reason" text,
	"completion_summary" text,
	"failure_code" text,
	"failure_message" text,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worker_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"version" text,
	"platform" text,
	"current_mission_id" uuid,
	"current_run_id" uuid,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"runtime_available" boolean DEFAULT false NOT NULL,
	"runtime_name" text,
	"runtime_detail" text,
	"workspace_healthy" boolean DEFAULT false NOT NULL,
	"workspace_root_label" text,
	"github_delivery_configured" boolean DEFAULT false NOT NULL,
	"diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_plan_id_mission_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."mission_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_artifacts" ADD CONSTRAINT "mission_artifacts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_artifacts" ADD CONSTRAINT "mission_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_artifacts" ADD CONSTRAINT "mission_artifacts_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_clarifications" ADD CONSTRAINT "mission_clarifications_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_commands" ADD CONSTRAINT "mission_commands_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_commands" ADD CONSTRAINT "mission_commands_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_permission_requests" ADD CONSTRAINT "mission_permission_requests_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_permission_requests" ADD CONSTRAINT "mission_permission_requests_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_plans" ADD CONSTRAINT "mission_plans_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_verifications" ADD CONSTRAINT "mission_verifications_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_verifications" ADD CONSTRAINT "mission_verifications_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_source_id_project_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."project_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_claimed_by_worker_id_workers_id_fk" FOREIGN KEY ("claimed_by_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_idempotency" ADD CONSTRAINT "worker_idempotency_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_approvals_mission_idx" ON "mission_approvals" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_approvals_active_idx" ON "mission_approvals" USING btree ("mission_id","plan_version") WHERE "mission_approvals"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "mission_artifacts_mission_idx" ON "mission_artifacts" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_artifacts_project_idx" ON "mission_artifacts" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_clarifications_question_idx" ON "mission_clarifications" USING btree ("mission_id","question_id");--> statement-breakpoint
CREATE INDEX "mission_clarifications_mission_idx" ON "mission_clarifications" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_commands_idempotency_idx" ON "mission_commands" USING btree ("mission_id","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "mission_commands_mission_idx" ON "mission_commands" USING btree ("mission_id","requested_at");--> statement-breakpoint
CREATE INDEX "mission_commands_state_idx" ON "mission_commands" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_events_run_seq_idx" ON "mission_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "mission_events_mission_created_idx" ON "mission_events" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE INDEX "mission_events_run_idx" ON "mission_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_permission_key_idx" ON "mission_permission_requests" USING btree ("run_id","request_key");--> statement-breakpoint
CREATE INDEX "mission_permission_mission_idx" ON "mission_permission_requests" USING btree ("mission_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_plans_version_idx" ON "mission_plans" USING btree ("mission_id","version");--> statement-breakpoint
CREATE INDEX "mission_plans_mission_idx" ON "mission_plans" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_runs_attempt_idx" ON "mission_runs" USING btree ("mission_id","attempt","kind");--> statement-breakpoint
CREATE INDEX "mission_runs_mission_idx" ON "mission_runs" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_runs_worker_idx" ON "mission_runs" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "mission_runs_state_idx" ON "mission_runs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "mission_verifications_run_idx" ON "mission_verifications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "mission_verifications_mission_idx" ON "mission_verifications" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "missions_project_idx" ON "missions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "missions_state_idx" ON "missions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "missions_created_idx" ON "missions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "missions_updated_idx" ON "missions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "missions_worker_idx" ON "missions" USING btree ("claimed_by_worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_idempotency_key_idx" ON "worker_idempotency" USING btree ("worker_id","key");--> statement-breakpoint
CREATE INDEX "worker_idempotency_expires_idx" ON "worker_idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_token_hash_idx" ON "workers" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "workers_status_idx" ON "workers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workers_heartbeat_idx" ON "workers" USING btree ("last_heartbeat_at");