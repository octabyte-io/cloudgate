ALTER TABLE "deployment" ADD COLUMN "cloud_run" jsonb;--> statement-breakpoint
ALTER TABLE "web_server_settings" ADD COLUMN "cloud_runs_concurrency" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "web_server_settings" ADD COLUMN "cloud_run_time_limit_minutes" integer DEFAULT 60 NOT NULL;