-- Proven domains (ADR-0051): an email domain an Organization has shown
-- it owns with a DNS TXT record, which on the Hosted instance is what lets its
-- SSO provider route and accept sign-ins for that domain.
CREATE TABLE "proven_domain" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain" text NOT NULL,
	"challenge" text NOT NULL,
	"proven_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proven_domain" ADD CONSTRAINT "proven_domain_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proven_domain_organization_domain_unique" ON "proven_domain" USING btree ("organization_id","domain");