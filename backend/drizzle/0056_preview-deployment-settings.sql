ALTER TABLE "application" ADD COLUMN "preview_limit" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "preview_port" integer DEFAULT 3000 NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "preview_env" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "preview_build_args" text;