ALTER TYPE "public"."provider_kind" ADD VALUE 'postmark';--> statement-breakpoint
ALTER TYPE "public"."provider_kind" ADD VALUE 'mailgun';--> statement-breakpoint
CREATE TABLE "provider_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"user_id" text,
	"provider" text NOT NULL,
	"details" text,
	"receives_mail" boolean,
	"email" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "secondary_token_enc" text;--> statement-breakpoint
ALTER TABLE "provider_requests" ADD CONSTRAINT "provider_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_requests" ADD CONSTRAINT "provider_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_requests_created_idx" ON "provider_requests" USING btree ("created_at");