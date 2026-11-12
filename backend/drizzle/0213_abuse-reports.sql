CREATE TABLE "abuse_report" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"report" text NOT NULL,
	"forwarded_at" timestamp (3) NOT NULL,
	"deadline_at" timestamp (3) NOT NULL,
	"forwarded_by" text NOT NULL,
	"closed_at" timestamp (3),
	"closed_by" text
);
--> statement-breakpoint
ALTER TABLE "abuse_report" ADD CONSTRAINT "abuse_report_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_report_organization_idx" ON "abuse_report" USING btree ("organization_id");