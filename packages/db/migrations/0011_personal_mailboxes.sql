ALTER TABLE "mailboxes" ADD COLUMN "personal_user_id" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_personal_user_id_user_id_fk" FOREIGN KEY ("personal_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Owners and admins used to see every mailbox without being assigned. Assign them all
-- existing mailboxes so nobody loses access when assignment starts applying to them too.
INSERT INTO "mailbox_members" ("mailbox_id", "user_id")
SELECT "mailboxes"."id", "members"."user_id"
FROM "mailboxes"
INNER JOIN "members" ON "members"."workspace_id" = "mailboxes"."workspace_id"
WHERE "members"."role" IN ('owner', 'admin')
ON CONFLICT DO NOTHING;
