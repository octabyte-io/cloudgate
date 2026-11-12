CREATE TABLE "gitea" (
	"gitea_id" text PRIMARY KEY NOT NULL,
	"gitea_url" text DEFAULT 'https://gitea.com' NOT NULL,
	"gitea_internal_url" text,
	"redirect_uri" text,
	"client_id" text,
	"client_secret" text,
	"access_token" text,
	"refresh_token" text,
	"expires_at" integer,
	"scopes" text DEFAULT 'repo,repo:status,read:user,read:org',
	"last_authenticated_at" integer,
	"git_provider_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gitea" ADD CONSTRAINT "gitea_git_provider_id_git_provider_git_provider_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_provider"("git_provider_id") ON DELETE cascade ON UPDATE no action;