ALTER TYPE "public"."domain_type" ADD VALUE 'bucket';--> statement-breakpoint
ALTER TABLE "domain" DROP CONSTRAINT "domain_exactly_one_parent";--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "bucket_id" text;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_bucket_id_bucket_bucket_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."bucket"("bucket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_exactly_one_parent" CHECK (num_nonnulls("application_id", "compose_id", "bucket_id") = 1);