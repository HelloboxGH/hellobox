CREATE TYPE "public"."campaign_delivery_status" AS ENUM('sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider_kind" AS ENUM('resend', 'ses');--> statement-breakpoint
ALTER TYPE "public"."connection_status" ADD VALUE 'pending' BEFORE 'active';--> statement-breakpoint
CREATE TABLE "campaign_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"contact_id" text,
	"email" text NOT NULL,
	"status" "campaign_delivery_status" DEFAULT 'sending' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "access_token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "refresh_token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "access_expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "provider" "provider_kind" DEFAULT 'resend' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "connect_token_hash" text;--> statement-breakpoint
ALTER TABLE "campaign_deliveries" ADD CONSTRAINT "campaign_deliveries_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_deliveries" ADD CONSTRAINT "campaign_deliveries_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_deliveries_recipient_idx" ON "campaign_deliveries" USING btree ("campaign_id","email");--> statement-breakpoint
CREATE INDEX "campaign_deliveries_message_idx" ON "campaign_deliveries" USING btree ("provider_message_id");