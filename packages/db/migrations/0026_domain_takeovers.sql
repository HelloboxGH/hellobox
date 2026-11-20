CREATE TABLE "domain_access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_name" text NOT NULL,
	"requester_workspace_id" text NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_takeovers" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_name" text NOT NULL,
	"requester_workspace_id" text NOT NULL,
	"requester_domain_id" text NOT NULL,
	"requested_by" text,
	"holder_workspace_id" text,
	"holder_domain_id" text,
	"token" text NOT NULL,
	"status" text DEFAULT 'dns' NOT NULL,
	"dns_verified_at" timestamp with time zone,
	"notice_ends_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
-- Activity wasn't recorded before this, so every workspace counts as active from now on:
-- none can have a domain claimed away until it has really been quiet for 90 days.
UPDATE "workspaces" SET "last_active_at" = now();--> statement-breakpoint
ALTER TABLE "domain_access_requests" ADD CONSTRAINT "domain_access_requests_requester_workspace_id_workspaces_id_fk" FOREIGN KEY ("requester_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_access_requests" ADD CONSTRAINT "domain_access_requests_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_takeovers" ADD CONSTRAINT "domain_takeovers_requester_workspace_id_workspaces_id_fk" FOREIGN KEY ("requester_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_takeovers" ADD CONSTRAINT "domain_takeovers_requester_domain_id_domains_id_fk" FOREIGN KEY ("requester_domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_takeovers" ADD CONSTRAINT "domain_takeovers_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_takeovers" ADD CONSTRAINT "domain_takeovers_holder_workspace_id_workspaces_id_fk" FOREIGN KEY ("holder_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_takeovers" ADD CONSTRAINT "domain_takeovers_holder_domain_id_domains_id_fk" FOREIGN KEY ("holder_domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_access_requests_idx" ON "domain_access_requests" USING btree ("domain_name","requester_workspace_id");--> statement-breakpoint
CREATE INDEX "domain_takeovers_domain_idx" ON "domain_takeovers" USING btree ("domain_name");--> statement-breakpoint
CREATE INDEX "domain_takeovers_holder_idx" ON "domain_takeovers" USING btree ("holder_workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_takeovers_open_idx" ON "domain_takeovers" USING btree ("requester_workspace_id","domain_name") WHERE "domain_takeovers"."status" in ('dns', 'notice');