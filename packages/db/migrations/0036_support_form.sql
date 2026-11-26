ALTER TABLE "support_inboxes" ADD COLUMN "form_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "support_inboxes_form_key_idx" ON "support_inboxes" USING btree ("form_key");