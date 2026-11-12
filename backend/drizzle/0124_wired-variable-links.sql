ALTER TABLE "application" ADD COLUMN "config_links" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "config_links" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "config_links" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "config_links" jsonb DEFAULT '{}'::jsonb NOT NULL;