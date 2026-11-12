ALTER TABLE "application" ADD COLUMN "wired_changed_at" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "wired_changed_at" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "wired_changed_at" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "wired_changed_at" text;