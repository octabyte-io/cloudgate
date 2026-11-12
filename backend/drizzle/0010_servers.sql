CREATE TYPE "public"."server_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."server_type" AS ENUM('deploy', 'build');--> statement-breakpoint
CREATE TABLE "server" (
	"server_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"ip_address" text NOT NULL,
	"port" integer NOT NULL,
	"username" text DEFAULT 'root' NOT NULL,
	"server_status" "server_status" DEFAULT 'active' NOT NULL,
	"server_type" "server_type" DEFAULT 'deploy' NOT NULL,
	"command" text DEFAULT '' NOT NULL,
	"ssh_key_id" text,
	"metrics_config" jsonb DEFAULT '{"server":{"type":"Remote","refreshRate":60,"port":4500,"token":"","urlCallback":"","cronJob":"","retentionDays":2,"thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":60,"services":{"include":[],"exclude":[]}}}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_ssh_key_id_ssh_key_ssh_key_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_key"("ssh_key_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;