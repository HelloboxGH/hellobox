CREATE TYPE "public"."import_status" AS ENUM('uploading', 'queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "imports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"filename" text NOT NULL,
	"format" text NOT NULL,
	"storage_key" text NOT NULL,
	"multipart_upload_id" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"status" "import_status" DEFAULT 'uploading' NOT NULL,
	"bytes_read" bigint DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ALTER COLUMN "domain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imports_workspace_idx" ON "imports" USING btree ("workspace_id","created_at");