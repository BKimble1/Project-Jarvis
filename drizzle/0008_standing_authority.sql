ALTER TABLE "mission_approvals" ADD COLUMN "charter_version_id" uuid;--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD COLUMN "charter_digest" text;--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD COLUMN "authorization_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "autonomous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "charter_version_id" uuid;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "authorization_decision_id" uuid;