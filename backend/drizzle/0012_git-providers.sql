CREATE TYPE "public"."git_provider_type" AS ENUM('github', 'gitlab', 'bitbucket', 'gitea');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('docker', 'git', 'github', 'gitlab', 'bitbucket', 'gitea', 'drop', 'raw');--> statement-breakpoint
CREATE TABLE "git_provider" (
	"git_provider_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider_type" "git_provider_type" DEFAULT 'github' NOT NULL,
	"created_at" text NOT NULL,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_provider" ADD CONSTRAINT "git_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;