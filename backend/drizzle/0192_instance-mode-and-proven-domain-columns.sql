-- §2.6 for the two tables 0190 and 0191 added: ISO-8601 text timestamps
-- rather than timestamp(3), and proven_domain's key named for its entity.
-- The timestamp(3) values were written as UTC (now() under the server's UTC
-- session, or a JS Date), so each converts to the string a JS toISOString()
-- would have written.
ALTER TABLE "recorded_instance_mode" ALTER COLUMN "recorded_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "recorded_instance_mode" ALTER COLUMN "recorded_at" SET DATA TYPE text USING to_char("recorded_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');--> statement-breakpoint
ALTER TABLE "recorded_instance_mode" ALTER COLUMN "changed_at" SET DATA TYPE text USING to_char("changed_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');--> statement-breakpoint
ALTER TABLE "proven_domain" RENAME COLUMN "id" TO "proven_domain_id";--> statement-breakpoint
ALTER TABLE "proven_domain" ALTER COLUMN "proven_at" SET DATA TYPE text USING to_char("proven_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');--> statement-breakpoint
ALTER TABLE "proven_domain" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "proven_domain" ALTER COLUMN "created_at" SET DATA TYPE text USING to_char("created_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
