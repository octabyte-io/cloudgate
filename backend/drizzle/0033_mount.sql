CREATE TYPE "public"."mount_type" AS ENUM('bind', 'volume', 'file');--> statement-breakpoint
CREATE TABLE "mount" (
	"mount_id" text PRIMARY KEY NOT NULL,
	"type" "mount_type" NOT NULL,
	"host_path" text,
	"volume_name" text,
	"file_path" text,
	"content" text,
	"service_type" "service_type" DEFAULT 'application' NOT NULL,
	"mount_path" text NOT NULL,
	"application_id" text,
	"compose_id" text,
	"libsql_id" text,
	"mariadb_id" text,
	"mongo_id" text,
	"mysql_id" text,
	"postgres_id" text,
	"redis_id" text
);
--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_libsql_id_libsql_libsql_id_fk" FOREIGN KEY ("libsql_id") REFERENCES "public"."libsql"("libsql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_mariadb_id_mariadb_mariadb_id_fk" FOREIGN KEY ("mariadb_id") REFERENCES "public"."mariadb"("mariadb_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_mongo_id_mongo_mongo_id_fk" FOREIGN KEY ("mongo_id") REFERENCES "public"."mongo"("mongo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_mysql_id_mysql_mysql_id_fk" FOREIGN KEY ("mysql_id") REFERENCES "public"."mysql"("mysql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_postgres_id_postgres_postgres_id_fk" FOREIGN KEY ("postgres_id") REFERENCES "public"."postgres"("postgres_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_redis_id_redis_redis_id_fk" FOREIGN KEY ("redis_id") REFERENCES "public"."redis"("redis_id") ON DELETE cascade ON UPDATE no action;