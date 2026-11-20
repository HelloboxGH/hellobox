ALTER TABLE "resend_connections" RENAME CONSTRAINT "resend_connections_pkey" TO "connections_pkey";--> statement-breakpoint
ALTER TABLE "resend_connections" RENAME TO "connections";--> statement-breakpoint
ALTER TABLE "attachments" RENAME COLUMN "resend_attachment_id" TO "provider_attachment_id";--> statement-breakpoint
ALTER TABLE "domains" RENAME COLUMN "resend_domain_id" TO "provider_domain_id";--> statement-breakpoint
ALTER TABLE "messages" RENAME COLUMN "resend_email_id" TO "provider_message_id";--> statement-breakpoint
ALTER TABLE "outbox" RENAME COLUMN "resend_email_id" TO "provider_message_id";--> statement-breakpoint
ALTER TABLE "contact_segments" DROP CONSTRAINT "contact_segments_connection_id_resend_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "domains" DROP CONSTRAINT "domains_connection_id_resend_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_connection_id_resend_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "resend_connections_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_connection_id_resend_connections_id_fk";
--> statement-breakpoint
DROP INDEX "domains_connection_resend_idx";--> statement-breakpoint
DROP INDEX "messages_connection_email_idx";--> statement-breakpoint
ALTER TABLE "contact_segments" ADD CONSTRAINT "contact_segments_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domains_connection_provider_idx" ON "domains" USING btree ("connection_id","provider_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_connection_email_idx" ON "messages" USING btree ("connection_id","provider_message_id");