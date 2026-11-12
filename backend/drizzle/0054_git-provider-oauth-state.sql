CREATE TABLE "git_provider_oauth_state" (
	"state" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"provider_type" "git_provider_type" NOT NULL,
	"git_provider_id" text NOT NULL,
	"redirect_uri" text,
	"return_to" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_provider_oauth_state" ADD CONSTRAINT "git_provider_oauth_state_git_provider_id_git_provider_git_provider_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_provider"("git_provider_id") ON DELETE cascade ON UPDATE no action;