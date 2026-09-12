CREATE TABLE IF NOT EXISTS "knowledge_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depth" integer,
	"page_number" integer,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"language" text,
	"char_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid,
	"item_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"indexing_version" text NOT NULL,
	"embedding" real[],
	"state" text DEFAULT 'pending' NOT NULL,
	"failure_message" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"revision_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"requested_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"content_hash" text NOT NULL,
	"byte_hash" text,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"unit_count" integer,
	"unit_kind" text DEFAULT 'line' NOT NULL,
	"block_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedded_chunk_count" integer DEFAULT 0 NOT NULL,
	"canonical_text" text,
	"parser_name" text NOT NULL,
	"parser_version" text NOT NULL,
	"chunker_version" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"limitations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "knowledge_chunks_ordinal_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "knowledge_sources_hash_idx";--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "revision_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "stable_key" text;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "chunker_version" text;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "page_number" integer;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "start_line" integer;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "end_line" integer;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "block_ordinals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "search_vector_exact" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("heading", '') || ' ' || "text")) STORED;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "active_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "sensitivity" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "refreshable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "last_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "storage_key" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "original_available" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_blocks" ADD CONSTRAINT "knowledge_blocks_revision_id_knowledge_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_embeddings" ADD CONSTRAINT "knowledge_embeddings_chunk_id_knowledge_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."knowledge_chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_embeddings" ADD CONSTRAINT "knowledge_embeddings_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_ingestion_jobs" ADD CONSTRAINT "knowledge_ingestion_jobs_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_ingestion_jobs" ADD CONSTRAINT "knowledge_ingestion_jobs_revision_id_knowledge_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_blocks_ordinal_idx" ON "knowledge_blocks" USING btree ("revision_id","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_blocks_revision_idx" ON "knowledge_blocks" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_blocks_page_idx" ON "knowledge_blocks" USING btree ("revision_id","page_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_embeddings_chunk_idx" ON "knowledge_embeddings" USING btree ("chunk_id","model","indexing_version") WHERE chunk_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_embeddings_item_idx" ON "knowledge_embeddings" USING btree ("item_id","model","indexing_version") WHERE item_id is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_embeddings_state_idx" ON "knowledge_embeddings" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_embeddings_model_idx" ON "knowledge_embeddings" USING btree ("model","indexing_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_ingestion_jobs_state_idx" ON "knowledge_ingestion_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_ingestion_jobs_source_idx" ON "knowledge_ingestion_jobs" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_revisions_active_idx" ON "knowledge_revisions" USING btree ("source_id") WHERE is_active;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_revisions_number_idx" ON "knowledge_revisions" USING btree ("source_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_revisions_content_idx" ON "knowledge_revisions" USING btree ("source_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_revisions_source_idx" ON "knowledge_revisions" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_revisions_state_idx" ON "knowledge_revisions" USING btree ("state");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_revision_id_knowledge_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_revision_ordinal_idx" ON "knowledge_chunks" USING btree ("revision_id","ordinal") WHERE revision_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_stable_key_idx" ON "knowledge_chunks" USING btree ("revision_id","stable_key") WHERE revision_id is not null and stable_key is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_revision_idx" ON "knowledge_chunks" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_search_exact_idx" ON "knowledge_chunks" USING gin ("search_vector_exact");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_hash_lookup_idx" ON "knowledge_sources" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_scope_idx" ON "knowledge_sources" USING btree ("scope","project_id");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_embeddings" ADD CONSTRAINT "knowledge_embeddings_one_target"
		CHECK ((chunk_id IS NOT NULL) <> (item_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
