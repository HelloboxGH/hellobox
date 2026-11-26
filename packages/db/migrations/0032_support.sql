CREATE TYPE "public"."support_status" AS ENUM('open', 'in_progress', 'solved');--> statement-breakpoint
CREATE TABLE "support_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"inbox_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"external_user_id" text,
	"email" text NOT NULL,
	"name" text,
	"verified" boolean DEFAULT false NOT NULL,
	"status" "support_status" DEFAULT 'open' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_inboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"inbox_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"inbox_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"source" text NOT NULL,
	"idempotency_key" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_inbox_id_support_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."support_inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_inboxes" ADD CONSTRAINT "support_inboxes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_inboxes" ADD CONSTRAINT "support_inboxes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_keys" ADD CONSTRAINT "support_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_keys" ADD CONSTRAINT "support_keys_inbox_id_support_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."support_inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_keys" ADD CONSTRAINT "support_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_inbox_id_support_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."support_inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_conversation_id_support_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."support_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_conversations_thread_idx" ON "support_conversations" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "support_conversations_user_idx" ON "support_conversations" USING btree ("inbox_id","external_user_id");--> statement-breakpoint
CREATE INDEX "support_conversations_workspace_idx" ON "support_conversations" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "support_inboxes_workspace_idx" ON "support_inboxes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "support_inboxes_mailbox_idx" ON "support_inboxes" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_keys_hash_idx" ON "support_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "support_keys_inbox_idx" ON "support_keys" USING btree ("inbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_message_idx" ON "support_messages" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_key_idx" ON "support_messages" USING btree ("inbox_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "support_messages_conversation_idx" ON "support_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "support_messages_usage_idx" ON "support_messages" USING btree ("workspace_id","created_at");