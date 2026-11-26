ALTER TABLE "domains" ADD COLUMN "receive_with_hellobox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "receive_token" text;