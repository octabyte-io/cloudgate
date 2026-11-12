CREATE TABLE "certificate_deletion" (
	"certificate_arn" text PRIMARY KEY NOT NULL,
	"cloud_account_id" text NOT NULL,
	"region" text NOT NULL,
	"state_id" text NOT NULL,
	"host" text,
	"forgotten_at" text NOT NULL,
	"last_tried_at" text
);
--> statement-breakpoint
ALTER TABLE "certificate_deletion" ADD CONSTRAINT "certificate_deletion_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE cascade ON UPDATE no action;