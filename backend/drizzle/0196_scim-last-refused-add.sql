ALTER TABLE "scim_provider" ADD COLUMN "last_refused_add_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "scim_provider" ADD COLUMN "last_refused_add_email" text;