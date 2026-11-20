ALTER TYPE "public"."provider_kind" ADD VALUE 'demo';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "demo_expires_at" timestamp with time zone;