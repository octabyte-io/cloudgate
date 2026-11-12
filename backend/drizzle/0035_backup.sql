CREATE TYPE "public"."backup_type" AS ENUM('database', 'compose');--> statement-breakpoint
CREATE TABLE "backup" (
	"backup_id" text PRIMARY KEY NOT NULL,
	"app_name" text NOT NULL,
	"schedule" text NOT NULL,
	"enabled" boolean,
	"database" text NOT NULL,
	"prefix" text NOT NULL,
	"service_name" text,
	"destination_id" text NOT NULL,
	"keep_latest_count" integer,
	"backup_type" "backup_type" DEFAULT 'database' NOT NULL,
	"database_type" "database_type" NOT NULL,
	"compose_id" text,
	"postgres_id" text,
	"mariadb_id" text,
	"mysql_id" text,
	"mongo_id" text,
	"libsql_id" text,
	"metadata" jsonb,
	"created_at" text NOT NULL,
	CONSTRAINT "backup_app_name_unique" UNIQUE("app_name")
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "backup_id" text;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_destination_id_destination_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("destination_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_postgres_id_postgres_postgres_id_fk" FOREIGN KEY ("postgres_id") REFERENCES "public"."postgres"("postgres_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_mariadb_id_mariadb_mariadb_id_fk" FOREIGN KEY ("mariadb_id") REFERENCES "public"."mariadb"("mariadb_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_mysql_id_mysql_mysql_id_fk" FOREIGN KEY ("mysql_id") REFERENCES "public"."mysql"("mysql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_mongo_id_mongo_mongo_id_fk" FOREIGN KEY ("mongo_id") REFERENCES "public"."mongo"("mongo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_libsql_id_libsql_libsql_id_fk" FOREIGN KEY ("libsql_id") REFERENCES "public"."libsql"("libsql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_backup_id_backup_backup_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backup"("backup_id") ON DELETE cascade ON UPDATE no action;