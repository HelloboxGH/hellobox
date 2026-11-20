ALTER TABLE "messages" ADD COLUMN "storage_counted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "bounces_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_expires_idx" ON "threads" USING btree ("expires_at") WHERE "threads"."expires_at" is not null;