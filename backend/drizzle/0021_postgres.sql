CREATE TYPE "public"."database_type" AS ENUM('postgres', 'mariadb', 'mysql', 'mongo', 'web-server', 'libsql');--> statement-breakpoint
CREATE TABLE "postgres" (
	"postgres_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"app_name" text NOT NULL,
	"database_name" text NOT NULL,
	"database_user" text NOT NULL,
	"database_password" text NOT NULL,
	"description" text,
	"docker_image" text DEFAULT 'postgres:18' NOT NULL,
	"command" text,
	"args" text[],
	"env" text,
	"memory_reservation" text,
	"memory_limit" text,
	"cpu_reservation" text,
	"cpu_limit" text,
	"external_port" integer,
	"application_status" "application_status" DEFAULT 'idle' NOT NULL,
	"health_check_swarm" json,
	"restart_policy_swarm" json,
	"placement_swarm" json,
	"update_config_swarm" json,
	"rollback_config_swarm" json,
	"mode_swarm" json,
	"labels_swarm" json,
	"network_swarm" json,
	"stop_grace_period_swarm" bigint,
	"endpoint_spec_swarm" json,
	"ulimits_swarm" json,
	"replicas" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"environment_id" text NOT NULL,
	"server_id" text,
	CONSTRAINT "postgres_app_name_unique" UNIQUE("app_name")
);
--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_environment_id_environment_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;