CREATE TABLE "bitbucket" (
	"bitbucket_id" text PRIMARY KEY NOT NULL,
	"bitbucket_username" text,
	"bitbucket_email" text,
	"app_password" text,
	"api_token" text,
	"bitbucket_workspace_name" text,
	"git_provider_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bitbucket" ADD CONSTRAINT "bitbucket_git_provider_id_git_provider_git_provider_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_provider"("git_provider_id") ON DELETE cascade ON UPDATE no action;