CREATE TABLE "support_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"inbox_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "support_conversations_user_idx";--> statement-breakpoint
ALTER TABLE "support_conversations" ADD COLUMN "last_message_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "support_conversations" SET "last_message_at" = "created_at";--> statement-breakpoint
ALTER TABLE "support_inboxes" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "support_inboxes" ADD COLUMN "webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "support_inboxes" ADD COLUMN "webhook_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_inboxes" ADD COLUMN "webhook_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_inboxes" ADD COLUMN "webhook_error" text;--> statement-breakpoint
ALTER TABLE "support_webhook_events" ADD CONSTRAINT "support_webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_webhook_events" ADD CONSTRAINT "support_webhook_events_inbox_id_support_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."support_inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_webhook_events_due_idx" ON "support_webhook_events" USING btree ("inbox_id","next_attempt_at") WHERE "support_webhook_events"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "support_webhook_events_created_idx" ON "support_webhook_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "support_conversations_user_idx" ON "support_conversations" USING btree ("inbox_id","external_user_id","last_message_at");