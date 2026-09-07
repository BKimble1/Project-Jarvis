CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'needs_authorization' NOT NULL,
	"account_label" text,
	"account_id" text,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token" jsonb,
	"refresh_token" jsonb,
	"expires_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_message" text,
	"delta_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE "oauth_authorizations" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"requested_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "provider_connections_status_idx" ON "provider_connections" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "oauth_authorizations_expiry_idx" ON "oauth_authorizations" USING btree ("expires_at");
