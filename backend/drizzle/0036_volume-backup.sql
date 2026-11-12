CREATE TABLE "volume_backup" (
	"volume_backup_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"volume_name" text NOT NULL,
	"prefix" text NOT NULL,
	"service_type" "service_type" DEFAULT 'application' NOT NULL,
	"app_name" text NOT NULL,
	"service_name" text,
	"turn_off" boolean DEFAULT false NOT NULL,
	"schedule" text NOT NULL,
	"keep_latest_count" integer,
	"enabled" boolean,
	"application_id" text,
	"postgres_id" text,
	"mariadb_id" text,
	"mongo_id" text,
	"mysql_id" text,
	"redis_id" text,
	"libsql_id" text,
	"compose_id" text,
	"destination_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "volume_backup_app_name_unique" UNIQUE("app_name")
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "volume_backup_id" text;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_postgres_id_postgres_postgres_id_fk" FOREIGN KEY ("postgres_id") REFERENCES "public"."postgres"("postgres_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_mariadb_id_mariadb_mariadb_id_fk" FOREIGN KEY ("mariadb_id") REFERENCES "public"."mariadb"("mariadb_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_mongo_id_mongo_mongo_id_fk" FOREIGN KEY ("mongo_id") REFERENCES "public"."mongo"("mongo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_mysql_id_mysql_mysql_id_fk" FOREIGN KEY ("mysql_id") REFERENCES "public"."mysql"("mysql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_redis_id_redis_redis_id_fk" FOREIGN KEY ("redis_id") REFERENCES "public"."redis"("redis_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_libsql_id_libsql_libsql_id_fk" FOREIGN KEY ("libsql_id") REFERENCES "public"."libsql"("libsql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_destination_id_destination_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("destination_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_volume_backup_id_volume_backup_volume_backup_id_fk" FOREIGN KEY ("volume_backup_id") REFERENCES "public"."volume_backup"("volume_backup_id") ON DELETE cascade ON UPDATE no action;