CREATE TABLE "support_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"inbox_id" text NOT NULL,
	"key_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"session_hash" text,
	"session_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_inboxes" ADD COLUMN "allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_inbox_id_support_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."support_inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_key_id_support_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."support_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_sessions_token_idx" ON "support_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "support_sessions_session_idx" ON "support_sessions" USING btree ("session_hash");--> statement-breakpoint
CREATE INDEX "support_sessions_expires_idx" ON "support_sessions" USING btree ("expires_at");