CREATE TYPE "public"."compose_type" AS ENUM('docker-compose', 'stack');--> statement-breakpoint
CREATE TABLE "compose" (
	"compose_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"app_name" text NOT NULL,
	"description" text,
	"env" text,
	"compose_file" text DEFAULT '' NOT NULL,
	"refresh_token" text,
	"source_type" "source_type" DEFAULT 'github' NOT NULL,
	"compose_type" "compose_type" DEFAULT 'docker-compose' NOT NULL,
	"repository" text,
	"owner" text,
	"branch" text,
	"trigger_type" "trigger_type" DEFAULT 'push',
	"auto_deploy" boolean,
	"gitlab_project_id" integer,
	"gitlab_repository" text,
	"gitlab_owner" text,
	"gitlab_branch" text,
	"gitlab_path_namespace" text,
	"gitea_repository" text,
	"gitea_owner" text,
	"gitea_branch" text,
	"bitbucket_repository" text,
	"bitbucket_repository_slug" text,
	"bitbucket_owner" text,
	"bitbucket_branch" text,
	"custom_git_url" text,
	"custom_git_branch" text,
	"custom_git_ssh_key_id" text,
	"command" text DEFAULT '' NOT NULL,
	"enable_submodules" boolean DEFAULT false NOT NULL,
	"compose_path" text DEFAULT './docker-compose.yml' NOT NULL,
	"isolated_deployment" boolean DEFAULT false NOT NULL,
	"watch_paths" text[],
	"compose_status" "application_status" DEFAULT 'idle' NOT NULL,
	"created_at" text NOT NULL,
	"environment_id" text NOT NULL,
	"github_id" text,
	"gitlab_id" text,
	"gitea_id" text,
	"bitbucket_id" text,
	"server_id" text,
	CONSTRAINT "compose_app_name_unique" UNIQUE("app_name")
);
--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_custom_git_ssh_key_id_ssh_key_ssh_key_id_fk" FOREIGN KEY ("custom_git_ssh_key_id") REFERENCES "public"."ssh_key"("ssh_key_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_environment_id_environment_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_github_id_github_github_id_fk" FOREIGN KEY ("github_id") REFERENCES "public"."github"("github_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_gitlab_id_gitlab_gitlab_id_fk" FOREIGN KEY ("gitlab_id") REFERENCES "public"."gitlab"("gitlab_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_gitea_id_gitea_gitea_id_fk" FOREIGN KEY ("gitea_id") REFERENCES "public"."gitea"("gitea_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_bitbucket_id_bitbucket_bitbucket_id_fk" FOREIGN KEY ("bitbucket_id") REFERENCES "public"."bitbucket"("bitbucket_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;