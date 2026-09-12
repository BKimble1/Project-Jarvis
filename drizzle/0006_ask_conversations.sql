CREATE TABLE IF NOT EXISTS "answer_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"scope" text DEFAULT 'portfolio' NOT NULL,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_id" text NOT NULL,
	"answer_count" integer DEFAULT 0 NOT NULL,
	"last_answered_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"retain_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "answer_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"subject_id" text NOT NULL,
	"label" text NOT NULL,
	"excerpt" text NOT NULL,
	"project_id" uuid,
	"locator" text,
	"revision_id" uuid,
	"content_hash" text,
	"href" text,
	"trust" text,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'created' NOT NULL;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "mode" text DEFAULT 'evidence_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "limitations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "retrieval_mode" text;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'answer_evidence_answer_id_answers_id_fk') THEN
    ALTER TABLE "answer_evidence" ADD CONSTRAINT "answer_evidence_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'answer_evidence_project_id_projects_id_fk') THEN
    ALTER TABLE "answer_evidence" ADD CONSTRAINT "answer_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answer_conversations_owner_idx" ON "answer_conversations" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answer_conversations_deleted_idx" ON "answer_conversations" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "answer_evidence_ref_idx" ON "answer_evidence" USING btree ("answer_id","ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answer_evidence_answer_idx" ON "answer_evidence" USING btree ("answer_id","ordinal");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'answers_conversation_id_answer_conversations_id_fk') THEN
    ALTER TABLE "answers" ADD CONSTRAINT "answers_conversation_id_answer_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."answer_conversations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answers_conversation_idx" ON "answers" USING btree ("conversation_id","generated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answers_state_idx" ON "answers" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "answers_idempotency_idx" ON "answers" USING btree ("asked_by","idempotency_key") WHERE idempotency_key is not null;