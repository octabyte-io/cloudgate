CREATE TABLE "gitlab" (
	"gitlab_id" text PRIMARY KEY NOT NULL,
	"gitlab_url" text DEFAULT 'https://gitlab.com' NOT NULL,
	"gitlab_internal_url" text,
	"application_id" text,
	"redirect_uri" text,
	"secret" text,
	"access_token" text,
	"refresh_token" text,
	"group_name" text,
	"expires_at" integer,
	"git_provider_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gitlab" ADD CONSTRAINT "gitlab_git_provider_id_git_provider_git_provider_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_provider"("git_provider_id") ON DELETE cascade ON UPDATE no action;