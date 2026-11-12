ALTER TABLE "environment" ADD COLUMN "config_branch" text;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "project_config_location" ADD COLUMN "git_provider_id" text;--> statement-breakpoint
ALTER TABLE "project_config_location" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "project_config_location" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "project_config_location" ADD CONSTRAINT "project_config_location_git_provider_id_git_provider_git_provider_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_provider"("git_provider_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_config_location" ADD CONSTRAINT "project_config_location_repository_iff_repository" CHECK (("project_config_location"."kind" = 'repository') = ("project_config_location"."repository" IS NOT NULL AND "project_config_location"."path" IS NOT NULL));