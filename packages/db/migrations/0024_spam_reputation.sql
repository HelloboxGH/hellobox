CREATE TABLE "domain_spam_reports" (
	"domain_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_spam_reports_domain_hash_user_id_pk" PRIMARY KEY("domain_hash","user_id")
);
--> statement-breakpoint
CREATE TABLE "spam_exemptions" (
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spam_exemptions_user_id_domain_pk" PRIMARY KEY("user_id","domain")
);
--> statement-breakpoint
ALTER TABLE "domain_spam_reports" ADD CONSTRAINT "domain_spam_reports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spam_exemptions" ADD CONSTRAINT "spam_exemptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;