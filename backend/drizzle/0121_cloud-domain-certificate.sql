CREATE TYPE "public"."cloud_certificate_status" AS ENUM('waiting-for-dns', 'checking', 'live', 'failed');--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "cloud_certificate_status" "cloud_certificate_status";--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "acm_certificate_arn" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "validation_record" jsonb;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "certificate_requested_at" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "certificate_last_polled_at" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "certificate_issued_at" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "certificate_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "certificate_failure" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "validation_record_found" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "points_at_load_balancer" boolean DEFAULT false NOT NULL;