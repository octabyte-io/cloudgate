CREATE TABLE "github" (
	"github_id" text PRIMARY KEY NOT NULL,
	"app_name" text,
	"app_id" integer,
	"client_id" text,
	"client_secret" text,
	"installation_id" text,
	"private_key" text,
	"webhook_secret" text,
	"git_provider_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github" ADD CONSTRAINT "github_git_provider_id_git_provider_git_provider_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_provider"("git_provider_id") ON DELETE cascade ON UPDATE no action;